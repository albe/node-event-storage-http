import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import EventStore from 'event-storage';
import express from 'express';

// Import through the public subpath exports to validate the exports map and the
// layer boundaries (self-referencing resolution via package.json "exports").
import * as protocolApi from 'event-storage-http/protocol';
import * as clientApi from 'event-storage-http/client';
import * as serverApi from 'event-storage-http';
import { EventStoreHttpClient } from 'event-storage-http/client';
import {
    EventStoreHttpApi,
    createEventStoreHttpServerWithApp
} from 'event-storage-http';

test('protocol subpath exposes framework-free helpers', () => {
    for (const name of ['MatcherBuilder', 'CommitConditionHelper', 'CONDITION_HEADER', 'eventPosition', 'commitPosition', 'NdjsonDecoder']) {
        assert.ok(name in protocolApi, `protocol should export ${name}`);
    }
});

test('client subpath exposes client + re-exported protocol helpers', () => {
    for (const name of ['HttpEventStream', 'EventStoreHttpClient', 'MatcherBuilder', 'NdjsonDecoder']) {
        assert.ok(name in clientApi, `client should export ${name}`);
    }
});

test('server subpath re-exports lower layers and server API', () => {
    for (const name of ['EventStoreHttpApi', 'createEventStoreHttpServer', 'createEventStoreHttpServerWithApp', 'HttpEventStream', 'MatcherBuilder']) {
        assert.ok(name in serverApi, `server should export ${name}`);
    }
});

test('eventPosition and commitPosition compute global positions', () => {
    const { eventPosition, commitPosition } = protocolApi;
    assert.equal(eventPosition({ commitId: 10, commitVersion: 0 }), 11);
    assert.equal(eventPosition({ commitId: 10, commitVersion: 2 }), 13);
    assert.equal(commitPosition({ commitId: 10, events: [{}, {}, {}] }), 13);
});

test('NdjsonDecoder splits across chunk boundaries and flushes the tail', () => {
    const decoder = new protocolApi.NdjsonDecoder();
    const enc = new TextEncoder();
    assert.deepEqual(decoder.push(enc.encode('{"a":1}\n{"b":')), [{ a: 1 }]);
    assert.deepEqual(decoder.push(enc.encode('2}\n')), [{ b: 2 }]);
    assert.deepEqual(decoder.push('{"c":3}'), [], 'a line without a trailing newline stays buffered');
    assert.deepEqual(decoder.flush(), [{ c: 3 }]);
});

test('NdjsonDecoder flush emits a final unterminated line', () => {
    const decoder = new protocolApi.NdjsonDecoder();
    assert.deepEqual(decoder.push('{"a":1}'), []);
    assert.deepEqual(decoder.flush(), [{ a: 1 }]);
    assert.deepEqual(decoder.flush(), []);
});

test('EventStoreHttpApi(store, options) keeps owning its own app', () => {
    const api = new EventStoreHttpApi(fakeStore(), { autoStartConsumers: false });
    assert.equal(typeof api.app, 'function', 'should build its own Express app');
    assert.equal(api.options.autoStartConsumers, false);
});

test('EventStoreHttpApi(store, app) attaches to the provided app', () => {
    const app = express();
    const api = new EventStoreHttpApi(fakeStore(), app, { streamPollTimeoutMs: 250 });
    assert.equal(api.app, app, 'should attach to the provided app');
    assert.equal(api.options.streamPollTimeoutMs, 250);
});

test('client round-trips against a server built with createEventStoreHttpServerWithApp', async () => {
    const fixture = await createFixture();
    try {
        const client = new EventStoreHttpClient({ baseUrl: fixture.baseUrl });

        const health = await client.health();
        assert.ok(health, 'health should return a payload');

        const commit = await client.commit('orders', [
            { type: 'OrderPlaced', payload: { id: 'o1' } },
            { type: 'OrderShipped', payload: { id: 'o1' } }
        ]);
        assert.ok(commit, 'commit should return a result');

        const stream = await client.readStream('orders', { from: 1 });
        const events = await stream.toArray();
        assert.equal(events.length, 2);
        assert.equal(events[0].payload.type, 'OrderPlaced');
        assert.equal(events[1].payload.type, 'OrderShipped');
    } finally {
        await fixture.close();
    }
});

test('client.readJoin supports nested selector algebra', async () => {
    const fixture = await createFixture({ tagsAccessor: 'tags' });
    try {
        const client = new EventStoreHttpClient({ baseUrl: fixture.baseUrl });
        await client.commit('orders-1', [{ type: 'OrderPlaced', orderId: '1', tags: ['featured', 'eu'] }]);
        await client.commit('orders-2', [{ type: 'OrderPlaced', orderId: '2', tags: ['featured'] }]);

        const stream = await client.readJoin([['tags/featured', ['tags/eu', 'OrderPlaced']]]);
        const events = await stream.toArray();
        assert.deepEqual(events.map(event => event.payload.orderId), ['1']);
    } finally {
        await fixture.close();
    }
});

test('client.readQuery supports DCB shorthand query objects', async () => {
    const fixture = await createFixture({ tagsAccessor: 'tags' });
    try {
        const client = new EventStoreHttpClient({ baseUrl: fixture.baseUrl });
        await client.commit('orders-1', [{ type: 'OrderPlaced', orderId: '1', tags: ['featured'] }]);
        await client.commit('orders-2', [{ type: 'OrderPlaced', orderId: '2', tags: ['archived'] }]);

        const stream = await client.readQuery({ items: [{ types: ['OrderPlaced'], tags: ['featured'] }] });
        const events = await stream.toArray();
        assert.deepEqual(events.map(event => event.payload.orderId), ['1']);
    } finally {
        await fixture.close();
    }
});

test('client.follow yields a batch then stops cleanly on break', async () => {
    const fixture = await createFixture();
    try {
        const client = new EventStoreHttpClient({ baseUrl: fixture.baseUrl });
        await client.commit('inventory', [{ type: 'ItemAdded', payload: { sku: 'x' } }]);

        const batches = [];
        for await (const batch of client.follow({ kind: 'stream', name: 'inventory' }, { fromPosition: 1 })) {
            batches.push(batch);
            break;
        }
        assert.equal(batches.length, 1);
        assert.equal(batches[0].events.length, 1);
        assert.equal(batches[0].events[0].payload.type, 'ItemAdded');
    } finally {
        await fixture.close();
    }
});

function fakeStore() {
    // Minimal stand-in for EventStore for constructor-only assertions: it never
    // emits 'ready', but `createApp`/`attach` only need scanConsumers to exist.
    return {
        storage: { initialized: true },
        scanConsumers() {}
    };
}

async function createFixture(eventStoreConfig = {}) {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'event-storage-http-layers-'));
    const eventStore = new EventStore({ storageDirectory, typeAccessor: 'type', ...eventStoreConfig });
    await once(eventStore, 'ready');

    const app = express();
    const returned = createEventStoreHttpServerWithApp(eventStore, app, { streamPollTimeoutMs: 250 });
    assert.equal(returned, app, 'createEventStoreHttpServerWithApp returns the provided app');

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
            await new Promise(resolve => server.close(resolve));
            await fs.rm(storageDirectory, { recursive: true, force: true });
        }
    };
}
