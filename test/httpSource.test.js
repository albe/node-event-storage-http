import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import EventStore from 'event-storage';
import express from 'express';
import { EventStoreHttpClient, httpSource } from 'event-storage-http/client';
import { createEventStoreHttpServerWithApp } from 'event-storage-http';

const course = (id, capacity) => ({ type: 'CourseDefined', id, capacity, tags: [`course/${id}`] });
const subscribe = (studentId, courseId) => ({ type: 'StudentSubscribed', studentId, courseId, tags: [`course/${courseId}`, `student/${studentId}`] });

async function createFixture(eventStoreConfig = {}) {
    const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'event-storage-http-source-'));
    const eventStore = new EventStore({ storageDirectory, typeAccessor: 'type', tagsAccessor: 'tags', ...eventStoreConfig });
    await once(eventStore, 'ready');
    const app = express();
    createEventStoreHttpServerWithApp(eventStore, app, { streamPollTimeoutMs: 250 });
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new EventStoreHttpClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    return {
        eventStore,
        client,
        async close() {
            await new Promise(resolve => server.close(resolve));
            eventStore.close();
            await fs.rm(storageDirectory, { recursive: true, force: true });
        }
    };
}

async function collect(iterable) {
    const items = [];
    for await (const item of iterable) items.push(item);
    return items;
}

test('GET /health reports the type and tags accessors', async () => {
    const fixture = await createFixture();
    try {
        const health = await fixture.client.health();
        assert.deepEqual(health.store.accessors, { type: 'type', tags: 'tags' });
    } finally {
        await fixture.close();
    }
});

test('httpSource.query delivers envelopes and the commit condition', async () => {
    const fixture = await createFixture();
    try {
        const { client } = fixture;
        await client.commit('courses', [course('c1', 2), course('c2', 3)]);
        await client.commit('subscriptions', [subscribe('s1', 'c1')]);

        const source = httpSource(client);
        const { events, condition } = await source.query({ items: [{ types: ['CourseDefined', 'StudentSubscribed'], tags: ['course/c1'] }] });
        const envelopes = await collect(events);
        assert.deepEqual(envelopes.map(e => [e.position, e.type, e.tags]), [
            [1, 'CourseDefined', ['course/c1']],
            [3, 'StudentSubscribed', ['course/c1', 'student/s1']]
        ]);
        assert.equal(envelopes[0].event.capacity, 2);
        assert.equal(condition.noneMatchAfter, 3);

        // The condition protects a decision made on these events.
        await client.commit('subscriptions', [subscribe('s2', 'c1')], { condition });
        await assert.rejects(client.commit('subscriptions', [subscribe('s3', 'c1')], { condition }));
    } finally {
        await fixture.close();
    }
});

test('httpSource.query reads from a position and stops at the condition', async () => {
    const fixture = await createFixture();
    try {
        const { client } = fixture;
        await client.commit('courses', [course('c1', 2), course('c2', 3)]);
        const source = httpSource(client);
        const { events, condition } = await source.query({ items: [{ types: ['CourseDefined'] }] }, { from: 2 });
        assert.deepEqual((await collect(events)).map(e => e.position), [2]);
        const { events: none } = await source.query({ items: [{ types: ['CourseDefined'] }] }, { from: condition.noneMatchAfter + 1 });
        assert.deepEqual(await collect(none), []);
    } finally {
        await fixture.close();
    }
});

test('httpSource.read applies the selector and an object matcher', async () => {
    const fixture = await createFixture();
    try {
        const { client } = fixture;
        await client.commit('courses', [course('c1', 2), course('c2', 5), course('c3', 7)]);
        const source = httpSource(client);
        const { condition } = await source.query({ items: [{ types: ['CourseDefined'] }] });
        const read = source.read({ selector: condition.selector, matcher: { payload: { capacity: { $gt: 2 } } } }, { from: 1 });
        assert.deepEqual((await collect(read)).map(e => e.event.id), ['c2', 'c3']);
        await assert.rejects(source.read({ selector: condition.selector, matcher: () => true }).next(), TypeError);
    } finally {
        await fixture.close();
    }
});

test('httpSource.follow delivers new events until aborted', async () => {
    const fixture = await createFixture();
    try {
        const { client } = fixture;
        await client.commit('courses', [course('c1', 2)]);
        const source = httpSource(client, { pollIntervalMs: 20 });
        const { condition } = await source.query({ items: [{ types: ['StudentSubscribed'], tags: ['course/c1'] }] });

        const abort = new AbortController();
        const seen = [];
        const following = (async () => {
            for await (const { event, position } of source.follow(condition, { from: condition.noneMatchAfter + 1, signal: abort.signal })) {
                seen.push([position, event.studentId]);
                if (seen.length === 2) abort.abort();
            }
        })();
        await client.commit('subscriptions', [subscribe('s1', 'c2')]);
        await client.commit('subscriptions', [subscribe('s2', 'c1')]);
        await new Promise(resolve => setTimeout(resolve, 50));
        await client.commit('subscriptions', [subscribe('s3', 'c1')]);
        await following;
        assert.deepEqual(seen, [[3, 's2'], [4, 's3']]);
    } finally {
        await fixture.close();
    }
});

test('httpSource keeps a null tagsAccessor as an opt-out', async () => {
    const fixture = await createFixture();
    try {
        const { client } = fixture;
        await client.commit('courses', [course('c1', 2)]);
        const { events } = await httpSource(client, { tagsAccessor: null }).query({ items: [{ types: ['CourseDefined'] }] });
        assert.deepEqual((await collect(events)).map(e => [e.type, e.tags]), [['CourseDefined', []]]);
    } finally {
        await fixture.close();
    }
});

test('httpSource cancels the accessor discovery with the signal', async () => {
    let healthSignal;
    const client = {
        health: ({ signal }) => new Promise((resolve, reject) => {
            healthSignal = signal;
            signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
        readQuery: async () => { throw new Error('not reached'); }
    };
    const abort = new AbortController();
    const reading = httpSource(client).read({ selector: ['_all'] }, { signal: abort.signal }).next();
    await new Promise(resolve => setImmediate(resolve));
    abort.abort();
    await assert.rejects(reading, /aborted/);
    assert.equal(healthSignal, abort.signal);
});

test('httpSource uses explicit accessors and requires a type accessor', async () => {
    const fixture = await createFixture({ typeAccessor: undefined, tagsAccessor: undefined, streamSources: [{ path: 'kind', nameBuilder: v => `kind/${v}` }] });
    try {
        const { client } = fixture;
        await client.commit('things', [{ kind: 'A', type: 'X' }]);
        await assert.rejects(httpSource(client).query(['kind/A']), /typeAccessor/);
        const { events } = await httpSource(client, { typeAccessor: 'kind', tagsAccessor: null }).query(['kind/A']);
        assert.deepEqual((await collect(events)).map(e => [e.type, e.tags]), [['A', []]]);
    } finally {
        await fixture.close();
    }
});
