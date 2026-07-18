import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'events';
import EventStore from 'event-storage';
import EventStoreHttpApi from '../src/server/EventStoreHttpApi.js';
import HttpEventStream from '../src/client/HttpEventStream.js';

function commitAsync(eventStore, streamName, events) {
    return new Promise((resolve, reject) => {
        try {
            eventStore.commit(streamName, events, resolve);
        } catch (error) {
            reject(error);
        }
    });
}

async function createFixture({ eventStoreConfig = {}, apiOptions = {} } = {}) {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'event-storage-http-test-'));
    const eventStore = new EventStore({
        storageDirectory,
        typeAccessor: 'type',
        ...eventStoreConfig
    });
    await once(eventStore, 'ready');

    const api = new EventStoreHttpApi(eventStore, apiOptions);
    const server = api.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();

    return {
        storageDirectory,
        eventStore,
        server,
        baseUrl: `http://127.0.0.1:${address.port}`
    };
}

async function destroyFixture(fixture) {
    await new Promise(resolve => fixture.server.close(resolve));
    fixture.eventStore.close();
    await fs.rm(fixture.storageDirectory, { recursive: true, force: true });
}

async function parseNdjson(response) {
    const text = await response.text();
    return text
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

test('POST /streams/:stream/commit stores events and GET /streams/:stream/version reports the version', async () => {
    const fixture = await createFixture();
    try {
        const commitResponse = await fetch(`${fixture.baseUrl}/streams/orders-1/commit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                events: [
                    { type: 'OrderPlaced', orderId: '1' },
                    { type: 'OrderConfirmed', orderId: '1' }
                ],
                metadata: { requestId: 'req-1' }
            })
        });
        assert.equal(commitResponse.status, 201);
        const commit = await commitResponse.json();
        assert.equal(commit.streamName, 'orders-1');
        assert.equal(commit.events.length, 2);

        const versionResponse = await fetch(`${fixture.baseUrl}/streams/orders-1/version`);
        assert.equal(versionResponse.status, 200);
        assert.deepEqual(await versionResponse.json(), {
            stream: 'orders-1',
            version: 2
        });
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /health reports basic store and runtime information', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        await fetch(`${fixture.baseUrl}/consumers/orders-reader/stream/orders-1/from/1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                state: {},
                handler: '() => ({})'
            })
        });

        const response = await fetch(`${fixture.baseUrl}/health`);
        assert.equal(response.status, 200);
        const body = await response.json();

        assert.equal(body.status, 'ok');
        assert.equal(body.store.open, true);
        assert.equal(body.store.writable, true);
        assert.equal(body.store.length, 1);
        assert.ok(body.store.streams >= 1);
        assert.ok(body.store.consumers >= 1);
        assert.ok(body.store.eventStorageVersion === null || typeof body.store.eventStorageVersion === 'string');
        assert.equal(body.server.env, 'development');
        assert.equal(typeof body.server.uptimeSeconds, 'number');
        assert.equal(body.server.nodeVersion, process.version);

    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /health/stats returns storage statistics', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const response = await fetch(`${fixture.baseUrl}/health/stats`);
        assert.equal(response.status, 200);
        const body = await response.json();

        assert.equal(typeof body.numPartitions, 'number');
        assert.equal(typeof body.numIndexes, 'number');
        assert.equal(typeof body.bytesWritten, 'number');
        assert.equal(typeof body.partitions, 'object');
        assert.equal(typeof body.indexes, 'object');
        assert.ok(body.numPartitions >= 1);
        assert.ok(body.numIndexes >= 1);
        assert.ok(Object.keys(body.partitions).length >= 1);
        assert.ok(Object.keys(body.indexes).length >= 1);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /health reports writable=false when the API wraps a read-only event store', async () => {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'event-storage-http-health-ro-'));
    let writableStore;
    let readOnlyStore;
    let server;
    try {
        writableStore = new EventStore({
            storageDirectory,
            typeAccessor: 'type'
        });
        await once(writableStore, 'ready');
        await commitAsync(writableStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        writableStore.close();

        readOnlyStore = new EventStore({
            storageDirectory,
            readOnly: true,
            typeAccessor: 'type'
        });
        await once(readOnlyStore, 'ready');

        const api = new EventStoreHttpApi(readOnlyStore);
        server = api.createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const response = await fetch(`${baseUrl}/health`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.status, 'ok');
        assert.equal(body.store.writable, false);
        assert.equal(body.store.length, 1);
    } finally {
        if (server) {
            await new Promise(resolve => server.close(resolve));
        }
        if (readOnlyStore) {
            readOnlyStore.close();
        }
        if (writableStore) {
            writableStore.close();
        }
        await fs.rm(storageDirectory, { recursive: true, force: true });
    }
});

test('GET /health returns 503 when the event store is closed', async () => {
    const fixture = await createFixture();
    try {
        fixture.eventStore.close();
        const response = await fetch(`${fixture.baseUrl}/health`);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.equal(body.status, 'degraded');
        assert.equal(body.store.open, false);
    } finally {
        await destroyFixture(fixture);
    }
});

test('HTTP API validates stream names and consumer identifiers', async () => {
    const fixture = await createFixture();
    try {
        const validCommitResponse = await fetch(`${fixture.baseUrl}/streams/orders.v1/eu-1/commit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                events: [{ type: 'OrderPlaced', orderId: 'safe-1' }]
            })
        });
        assert.equal(validCommitResponse.status, 201);

        const validVersionResponse = await fetch(`${fixture.baseUrl}/streams/orders.v1/eu-1/version`);
        assert.equal(validVersionResponse.status, 200);

        const dottedTypeQueryResponse = await fetch(`${fixture.baseUrl}/query?types=Order.Placed`);
        assert.equal(dottedTypeQueryResponse.status, 200);

        const invalidStreamResponse = await fetch(`${fixture.baseUrl}/streams/orders..1/commit`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                events: [{ type: 'OrderPlaced', orderId: 'unsafe-1' }]
            })
        });
        assert.equal(invalidStreamResponse.status, 400);
        assert.deepEqual(await invalidStreamResponse.json(), {
            error: 'stream must use segments that start with a letter or number and may contain letters, numbers, "_", and separators "/", ":", "@", "~", "+", "=", "-", "#", ".".'
        });

        const invalidJoinResponse = await fetch(`${fixture.baseUrl}/streams/join?streams=orders..1`);
        assert.equal(invalidJoinResponse.status, 400);

        const invalidQueryResponse = await fetch(`${fixture.baseUrl}/query?types=Order..Placed`);
        assert.equal(invalidQueryResponse.status, 400);

        const invalidConsumerResponse = await fetch(`${fixture.baseUrl}/consumers/reader%2F1/stream/orders.v1/eu-1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ lastSeen: null })
        });
        assert.equal(invalidConsumerResponse.status, 400);
        assert.deepEqual(await invalidConsumerResponse.json(), {
            error: 'identifier may only contain letters, numbers, "-" and "_".'
        });
    } finally {
        await destroyFixture(fixture);
    }
});

test('PUT /streams/:stream creates matcher streams and GET /streams/:stream returns filtered NDJSON', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'users-1', [
            { type: 'UserCreated', userId: '1' },
            { type: 'UserEmailUpdated', userId: '1' }
        ]);

        const createResponse = await fetch(`${fixture.baseUrl}/streams/users`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                stream: ['users-1']
            })
        });
        assert.equal(createResponse.status, 201);

        const matcher = encodeURIComponent(JSON.stringify({ payload: { type: 'UserEmailUpdated' } }));
        const response = await fetch(`${fixture.baseUrl}/streams/users/backwards/2?filter=${matcher}`);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');

        const events = await parseNdjson(response);
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.type, 'UserEmailUpdated');
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams lists stream name, closed state, version, and metadata', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderConfirmed', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'users-1', [{ type: 'UserCreated', userId: '1' }]);
        fixture.eventStore.closeEventStream('users-1');

        const response = await fetch(`${fixture.baseUrl}/streams`);
        assert.equal(response.status, 200);

        const body = await response.json();
        const streamsByName = new Map(body.streams.map(stream => [stream.stream, stream]));

        assert.equal(streamsByName.has('_all'), false);

        const orders = streamsByName.get('orders-1');
        assert.equal(orders.closed, false);
        assert.equal(orders.version, fixture.eventStore.streams['orders-1'].index.length);
        assert.deepEqual(orders.metadata, fixture.eventStore.streams['orders-1'].index.metadata);

        const users = streamsByName.get('users-1');
        assert.equal(users.closed, true);
        assert.equal(users.version, fixture.eventStore.streams['users-1'].index.length);
        assert.deepEqual(users.metadata, fixture.eventStore.streams['users-1'].index.metadata);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/:stream with until > version long-polls and streams forward until target version', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const responsePromise = fetch(`${fixture.baseUrl}/streams/orders-1/until/3/from/1`);

        await new Promise(resolve => setTimeout(resolve, 25));
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderConfirmed', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderShipped', orderId: '1' }]);

        const response = await responsePromise;
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');

        const events = await parseNdjson(response);
        assert.deepEqual(events.map(event => event.payload.type), ['OrderPlaced', 'OrderConfirmed', 'OrderShipped']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/_all and /streams/_all/version expose the global stream', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'users-1', [{ type: 'UserCreated', userId: '1' }]);

        const streamResponse = await fetch(`${fixture.baseUrl}/streams/_all/from/2/until/2`);
        assert.equal(streamResponse.status, 200);
        const events = await parseNdjson(streamResponse);
        assert.equal(events.length, 1);
        assert.equal(events[0].stream, 'users-1');
        assert.equal(events[0].payload.type, 'UserCreated');

        const versionResponse = await fetch(`${fixture.baseUrl}/streams/_all/version`);
        assert.equal(versionResponse.status, 200);
        assert.deepEqual(await versionResponse.json(), {
            stream: '_all',
            version: 2
        });
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/:stream with until > version returns 408 on timeout', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-2', [{ type: 'OrderPlaced', orderId: '1' }]);

        const shortTimeoutApi = new EventStoreHttpApi(fixture.eventStore, { streamPollTimeoutMs: 100 });
        const shortTimeoutServer = shortTimeoutApi.createServer();
        await new Promise(resolve => shortTimeoutServer.listen(0, '127.0.0.1', resolve));
        const shortAddress = shortTimeoutServer.address();
        const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`;

        try {
            // Request from position 2 onwards until version 99. This will timeout since stream only has 1 event.
            const timeoutResponse = await fetch(`${shortBaseUrl}/streams/orders-2/until/99/from/2`);
            assert.equal(timeoutResponse.status, 408);
            const body = await timeoutResponse.json();
            assert.ok(body.error.includes('did not reach version'));
        } finally {
            await new Promise(resolve => shortTimeoutServer.close(resolve));
        }
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/:stream polling returns 200 when at least one event was emitted before timeout', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-3', [{ type: 'OrderPlaced', orderId: '1' }]);

        const shortTimeoutApi = new EventStoreHttpApi(fixture.eventStore, { streamPollTimeoutMs: 100 });
        const shortTimeoutServer = shortTimeoutApi.createServer();
        await new Promise(resolve => shortTimeoutServer.listen(0, '127.0.0.1', resolve));
        const shortAddress = shortTimeoutServer.address();
        const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`;

        try {
            const response = await fetch(`${shortBaseUrl}/streams/orders-3/from/1/until/99`);
            assert.equal(response.status, 200);
            const events = await parseNdjson(response);
            assert.deepEqual(events.map(event => event.payload.type), ['OrderPlaced']);
        } finally {
            await new Promise(resolve => shortTimeoutServer.close(resolve));
        }
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join and /streams/category return joined NDJSON output, including nested categories', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'orders-2', [{ type: 'OrderPlaced', orderId: '2' }]);
        await commitAsync(fixture.eventStore, 'orders/eu/1', [{ type: 'OrderPlaced', orderId: '3' }]);
        await commitAsync(fixture.eventStore, 'orders/eu/2', [{ type: 'OrderPlaced', orderId: '4' }]);

        const joinResponse = await fetch(`${fixture.baseUrl}/streams/join?streams=orders-1,orders-2`);
        assert.equal(joinResponse.status, 200);
        const joined = await parseNdjson(joinResponse);
        assert.deepEqual(joined.map(event => event.stream), ['orders-1', 'orders-2']);

        const categoryResponse = await fetch(`${fixture.baseUrl}/streams/category/orders`);
        assert.equal(categoryResponse.status, 200);
        const categoryEvents = await parseNdjson(categoryResponse);
        assert.equal(categoryEvents.length, 4);

        const nestedCategoryResponse = await fetch(`${fixture.baseUrl}/streams/category/orders/eu`);
        assert.equal(nestedCategoryResponse.status, 200);
        const nestedCategoryEvents = await parseNdjson(nestedCategoryResponse);
        assert.deepEqual(nestedCategoryEvents.map(event => event.stream), ['orders/eu/1', 'orders/eu/2']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join rejects _all to avoid redundant full-store joins', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const response = await fetch(`${fixture.baseUrl}/streams/join?streams=_all,orders-1`);
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            error: 'streams must not include "_all" for join reads. Use GET /streams/_all instead.'
        });
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join over a single stream still applies global revision windows', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        await commitAsync(fixture.eventStore, 'users-1', [{ type: 'UserCreated', userId: '1' }]);
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderConfirmed', orderId: '1' }]);

        const globalMatchResponse = await fetch(`${fixture.baseUrl}/streams/join/from/3/until/3?streams=orders-1`);
        assert.equal(globalMatchResponse.status, 200);
        const globalMatch = await parseNdjson(globalMatchResponse);
        assert.equal(globalMatch.length, 1);
        assert.equal(globalMatch[0].stream, 'orders-1');
        assert.equal(globalMatch[0].payload.type, 'OrderConfirmed');
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join supports nested selector algebra via selector query parameter', async () => {
    const fixture = await createFixture({ eventStoreConfig: { tagsAccessor: 'tags' } });
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1', tags: ['featured', 'eu'] }
        ]);
        await commitAsync(fixture.eventStore, 'orders-2', [
            { type: 'OrderPlaced', orderId: '2', tags: ['featured'] }
        ]);
        await commitAsync(fixture.eventStore, 'orders-3', [
            { type: 'OrderCancelled', orderId: '3', tags: ['eu'] }
        ]);

        const selector = encodeURIComponent(JSON.stringify([['tags/featured', 'tags/eu', ['OrderPlaced']]]));
        const response = await fetch(`${fixture.baseUrl}/streams/join?selector=${selector}`);
        assert.equal(response.status, 200);

        const events = await parseNdjson(response);
        assert.deepEqual(events.map(event => event.payload.orderId), ['1']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join accepts non-existing streams as empty results', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);
        const response = await fetch(`${fixture.baseUrl}/streams/join?streams=orders-1,orders-missing`);
        assert.equal(response.status, 200);
        const events = await parseNdjson(response);
        assert.deepEqual(events.map(event => event.stream), ['orders-1']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/join long-poll returns 408 when no in-range event becomes visible', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const shortTimeoutApi = new EventStoreHttpApi(fixture.eventStore, { streamPollTimeoutMs: 100 });
        const shortTimeoutServer = shortTimeoutApi.createServer();
        await new Promise(resolve => shortTimeoutServer.listen(0, '127.0.0.1', resolve));
        const shortAddress = shortTimeoutServer.address();
        const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`;

        try {
            const response = await fetch(`${shortBaseUrl}/streams/join/from/2/until/99?streams=orders-1`);
            assert.equal(response.status, 408);
            const body = await response.json();
            assert.ok(body.error.includes('did not reach version'));
        } finally {
            await new Promise(resolve => shortTimeoutServer.close(resolve));
        }
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /streams/category long-poll returns 200 when at least one event was streamed', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const shortTimeoutApi = new EventStoreHttpApi(fixture.eventStore, { streamPollTimeoutMs: 100 });
        const shortTimeoutServer = shortTimeoutApi.createServer();
        await new Promise(resolve => shortTimeoutServer.listen(0, '127.0.0.1', resolve));
        const shortAddress = shortTimeoutServer.address();
        const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`;

        try {
            const response = await fetch(`${shortBaseUrl}/streams/category/orders/from/1/until/99`);
            assert.equal(response.status, 200);
            const events = await parseNdjson(response);
            assert.deepEqual(events.map(event => event.payload.type), ['OrderPlaced']);
        } finally {
            await new Promise(resolve => shortTimeoutServer.close(resolve));
        }
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /query returns NDJSON and exposes a serialized commit condition header', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1' },
            { type: 'OrderPlaced', orderId: '2' }
        ]);

        const filter = encodeURIComponent(JSON.stringify({ payload: { orderId: '2' } }));
        const response = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter}`);
        assert.equal(response.status, 200);
        const condition = JSON.parse(response.headers.get('x-event-store-query-condition'));
        assert.deepEqual(condition, {
            selector: ['OrderPlaced'],
            types: ['OrderPlaced'],
            noneMatchAfter: 2,
            matcher: { payload: { orderId: '2' } }
        });

        const events = await parseNdjson(response);
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.orderId, '2');
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /query supports operator object matchers from core event-storage', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', amount: 50 },
            { type: 'OrderPlaced', amount: 150 }
        ]);

        const filter = encodeURIComponent(JSON.stringify({ payload: { amount: { $gte: 100 } } }));
        const response = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter}`);
        assert.equal(response.status, 200);

        const events = await parseNdjson(response);
        assert.equal(events.length, 1);
        assert.equal(events[0].payload.amount, 150);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /query supports DCB shorthand query payloads with tags and types', async () => {
    const fixture = await createFixture({ eventStoreConfig: { tagsAccessor: 'tags' } });
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1', tags: ['featured'] },
            { type: 'OrderPlaced', orderId: '2', tags: ['archived'] }
        ]);

        const dcbQuery = encodeURIComponent(JSON.stringify({
            items: [{ types: ['OrderPlaced'], tags: ['featured'] }]
        }));
        const response = await fetch(`${fixture.baseUrl}/query?query=${dcbQuery}`);
        assert.equal(response.status, 200);

        const condition = JSON.parse(response.headers.get('x-event-store-query-condition'));
        assert.deepEqual(condition.selector, [['tags/featured', 'OrderPlaced']]);
        const events = await parseNdjson(response);
        assert.deepEqual(events.map(event => event.payload.orderId), ['1']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /query treats non-existing type streams as empty', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1' }
        ]);

        const response = await fetch(`${fixture.baseUrl}/query?types=MissingType`);
        assert.equal(response.status, 200);
        const events = await parseNdjson(response);
        assert.deepEqual(events, []);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /query supports $hasAny array matchers', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1', tags: ['featured'] },
            { type: 'OrderPlaced', orderId: '2', tags: ['archived'] }
        ]);
        const filter = encodeURIComponent(JSON.stringify({ payload: { tags: { $hasAny: ['featured', 'beta'] } } }));
        const response = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter}`);
        assert.equal(response.status, 200);
        const events = await parseNdjson(response);
        assert.deepEqual(events.map(event => event.payload.orderId), ['1']);
    } finally {
        await destroyFixture(fixture);
    }
});

test('HTTP matcher parsing reuses object references for repeated JSON matcher strings', async () => {
    const fixture = await createFixture({ apiOptions: { matcherCacheSize: 100 } });
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const seenMatchers = [];
        const originalQuery = fixture.eventStore.query.bind(fixture.eventStore);
        fixture.eventStore.query = (selector, matcher, minRevision, raw) => {
            seenMatchers.push(matcher);
            return originalQuery(selector, matcher, minRevision, raw);
        };

        const filter = encodeURIComponent(JSON.stringify({ payload: { orderId: '1' } }));
        const firstResponse = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter}`);
        const secondResponse = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter}`);
        assert.equal(firstResponse.status, 200);
        assert.equal(secondResponse.status, 200);
        await parseNdjson(firstResponse);
        await parseNdjson(secondResponse);

        assert.equal(seenMatchers.length, 2);
        assert.strictEqual(seenMatchers[0], seenMatchers[1]);
    } finally {
        await destroyFixture(fixture);
    }
});

test('HTTP matcher cache evicts least-recently-used entries when full', async () => {
    const fixture = await createFixture({ apiOptions: { matcherCacheSize: 2 } });
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        const seenMatchers = [];
        const originalQuery = fixture.eventStore.query.bind(fixture.eventStore);
        fixture.eventStore.query = (selector, matcher, minRevision, raw) => {
            seenMatchers.push(matcher);
            return originalQuery(selector, matcher, minRevision, raw);
        };

        const filter1 = encodeURIComponent(JSON.stringify({ payload: { orderId: '1' } }));
        const filter2 = encodeURIComponent(JSON.stringify({ payload: { orderId: '2' } }));
        const filter3 = encodeURIComponent(JSON.stringify({ payload: { orderId: '3' } }));

        const responses = [
            await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter1}`),
            await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter2}`),
            await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter3}`),
            await fetch(`${fixture.baseUrl}/query?types=OrderPlaced&filter=${filter1}`)
        ];

        for (const response of responses) {
            assert.equal(response.status, 200);
            await parseNdjson(response);
        }

        assert.equal(seenMatchers.length, 4);
        assert.notStrictEqual(seenMatchers[0], seenMatchers[3], 'oldest matcher should be evicted when cache exceeds configured size');
    } finally {
        await destroyFixture(fixture);
    }
});

test('PUT /consumers/:identifier/stream/:stream and GET /consumers endpoints expose durable consumers', async () => {
    const fixture = await createFixture();
    try {
        const streamResponse = await fetch(`${fixture.baseUrl}/streams/orders-1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stream: 'orders-1' })
        });
        assert.equal(streamResponse.status, 201);

        const createResponse = await fetch(`${fixture.baseUrl}/consumers/orders-reader/stream/orders-1/from/1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                state: { lastSeen: null },
                handler: '(event, state) => ({ lastSeen: event.orderId ?? state.lastSeen })'
            })
        });
        assert.equal(createResponse.status, 201);
        assert.deepEqual(await createResponse.json(), {
            identifier: 'orders-reader',
            stream: 'orders-1',
            position: 1,
            state: { lastSeen: null }
        });

        const consumerResponse = await fetch(`${fixture.baseUrl}/consumers/orders-reader`);
        assert.equal(consumerResponse.status, 200);
        assert.deepEqual(await consumerResponse.json(), {
            identifier: 'orders-reader',
            stream: 'orders-1',
            position: 1,
            state: { lastSeen: null }
        });

        const listResponse = await fetch(`${fixture.baseUrl}/consumers`);
        assert.equal(listResponse.status, 200);
        const list = await listResponse.json();
        assert.deepEqual(list, {
            consumers: [
                {
                    identifier: 'orders-reader',
                    stream: 'orders-1'
                }
            ]
        });
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /consumers/:identifier/after/:minVersion long-polls until the consumer reaches the requested version or later', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        // Start a consumer at position 1 (one event already committed).
        await fetch(`${fixture.baseUrl}/consumers/poll-reader/stream/orders-1/from/1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                state: { count: 0 },
                handler: '(event, state) => ({ count: state.count + 1 })'
            })
        });

        // The consumer is at position 1; asking for version 1 should respond immediately.
        const immediateResponse = await fetch(`${fixture.baseUrl}/consumers/poll-reader/after/1`);
        assert.equal(immediateResponse.status, 200);
        const immediate = await immediateResponse.json();
        assert.equal(immediate.identifier, 'poll-reader');
        assert.equal(immediate.stream, 'orders-1');
        assert.ok(immediate.position >= 1);

        // Commit a second event while the long-poll is in flight.
        const pollPromise = fetch(`${fixture.baseUrl}/consumers/poll-reader/after/2`);
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderConfirmed', orderId: '1' }]);

        const pollResponse = await pollPromise;
        assert.equal(pollResponse.status, 200);
        const polled = await pollResponse.json();
        assert.ok(polled.position >= 2);
        assert.equal(polled.state.count, 1);
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /consumers/:identifier/after/:minVersion returns 408 when timeout elapses before version is reached', async () => {
    const fixture = await createFixture();
    try {
        // Create an API instance with a very short timeout so the test doesn't hang.
        const shortTimeoutApi = new EventStoreHttpApi(fixture.eventStore, { consumerPollTimeoutMs: 100 });
        const shortTimeoutServer = shortTimeoutApi.createServer();
        await new Promise(resolve => shortTimeoutServer.listen(0, '127.0.0.1', resolve));
        const shortAddress = shortTimeoutServer.address();
        const shortBaseUrl = `http://127.0.0.1:${shortAddress.port}`;

        try {
            await commitAsync(fixture.eventStore, 'orders-2', [{ type: 'OrderPlaced', orderId: '1' }]);
            await fetch(`${shortBaseUrl}/consumers/timeout-reader/stream/orders-2/from/1`, {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    state: {},
                    handler: '() => {}'
                })
            });

            // Ask for version 99 which will never be reached within 100ms.
            const timeoutResponse = await fetch(`${shortBaseUrl}/consumers/timeout-reader/after/99`);
            assert.equal(timeoutResponse.status, 408);
            const body = await timeoutResponse.json();
            assert.ok(body.error.includes('did not reach version'));
        } finally {
            await new Promise(resolve => shortTimeoutServer.close(resolve));
        }
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /consumers/:identifier/after/:minVersion returns 404 for unknown consumer', async () => {
    const fixture = await createFixture();
    try {
        const response = await fetch(`${fixture.baseUrl}/consumers/no-such-consumer/after/1`);
        assert.equal(response.status, 404);
    } finally {
        await destroyFixture(fixture);
    }
});

test('HttpEventStream parses NDJSON response body and exposes commitCondition header', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1' },
            { type: 'OrderConfirmed', orderId: '1' }
        ]);

        const response = await fetch(`${fixture.baseUrl}/query?types=OrderPlaced,OrderConfirmed`);
        assert.equal(response.status, 200);

        const stream = new HttpEventStream(response);
        assert.ok(stream.commitCondition, 'commitCondition should be populated from response header');
        assert.deepEqual(stream.commitCondition.types, ['OrderPlaced', 'OrderConfirmed']);

        const events = await stream.toArray();
        assert.equal(events.length, 2);
        assert.equal(events[0].payload.type, 'OrderPlaced');
        assert.equal(events[1].payload.type, 'OrderConfirmed');
    } finally {
        await destroyFixture(fixture);
    }
});

test('HttpEventStream async iteration yields events one by one', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [
            { type: 'OrderPlaced', orderId: '1' },
            { type: 'OrderConfirmed', orderId: '1' }
        ]);

        const response = await fetch(`${fixture.baseUrl}/streams/orders-1`);
        assert.equal(response.status, 200);

        const stream = new HttpEventStream(response);
        const collected = [];
        for await (const event of stream) {
            collected.push(event);
        }
        assert.equal(collected.length, 2);
        assert.equal(collected[0].payload.type, 'OrderPlaced');
        assert.equal(collected[1].payload.type, 'OrderConfirmed');
    } finally {
        await destroyFixture(fixture);
    }
});

test('GET /consumers/:identifier returns running consumer from registry without opening a second instance', async () => {
    const fixture = await createFixture();
    try {
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderPlaced', orderId: '1' }]);

        // Start the consumer via PUT so it is in the registry.
        const putResponse = await fetch(`${fixture.baseUrl}/consumers/reg-reader/stream/orders-1/from/1`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                state: { count: 0 },
                handler: '(event, state) => ({ count: state.count + 1 })'
            })
        });
        assert.equal(putResponse.status, 201);

        // Let the consumer catch up.
        await commitAsync(fixture.eventStore, 'orders-1', [{ type: 'OrderConfirmed', orderId: '1' }]);
        await fetch(`${fixture.baseUrl}/consumers/reg-reader/after/2`);

        // GET should return the registry entry (live position/state).
        const getResponse = await fetch(`${fixture.baseUrl}/consumers/reg-reader`);
        assert.equal(getResponse.status, 200);
        const body = await getResponse.json();
        assert.equal(body.identifier, 'reg-reader');
        assert.ok(body.position >= 2, 'should reflect the live position from the registry');
    } finally {
        await destroyFixture(fixture);
    }
});
