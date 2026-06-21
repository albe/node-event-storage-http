# event-storage-http

HTTP API layer for [`event-storage`](https://www.npmjs.com/package/event-storage) — exposes an EventStore instance as a set of REST endpoints over NDJSON streaming.

Requires `event-storage >= 1.3.0`.

## What and why

`event-storage-http` bridges a Node.js `EventStore` instance and any HTTP client. It is designed for setups where the event store lives in a **dedicated backend service** that multiple consumers — frontends, microservices, serverless functions, or other runtimes — need to reach over the network without a direct Node.js dependency.

**Use this package when:**
- you run the EventStore as a standalone service and trusted backend clients (Python workers, Go services, other Node.js services, …) need to connect remotely
- you need a simple, language-agnostic integration point between internal services without embedding the storage library

**Do not use this package when:**
- your consumers run in the same Node.js process — use `event-storage` directly for best performance and type safety
- you want to expose data to browsers or the public internet — this layer provides no authentication, authorization, or input sanitization and must only be reachable by trusted clients
- you need fine-grained access control, authentication, or schema validation — add those layers yourself before reaching for this package
- low-latency write paths are critical — the HTTP round-trip adds overhead that in-process access avoids

## Usage

Minimal setup — create an EventStore, wrap it in the HTTP API, and start listening:

```js
import EventStore from 'event-storage';
import EventStoreHttpApi from 'event-storage-http';

const eventStore = new EventStore({
    storageDirectory: './data',
    typeAccessor: 'type'
});

const api = new EventStoreHttpApi(eventStore);
api.listen(3000, () => console.log('Event store listening on port 3000'));
```

### With options

The second argument to `EventStoreHttpApi` accepts configuration for consumer behaviour:

```js
import EventStore from 'event-storage';
import EventStoreHttpApi from 'event-storage-http';

const eventStore = new EventStore({
    storageDirectory: './data',
    typeAccessor: 'type'
});

const api = new EventStoreHttpApi(eventStore, {
    // Re-open and register all persisted consumers at boot time so they begin
    // processing immediately without a client issuing a PUT first.
    autoStartConsumers: true,

    // How long (ms) GET /consumers/:id/after/:version waits before responding
    // with 408 Request Timeout.  Defaults to 10 000.
    consumerPollTimeoutMs: 30_000,

    // How long (ms) stream/join/category reads wait for the next event when
    // long-polling is active before timing out. Defaults to 10 000.
    streamPollTimeoutMs: 30_000
});

api.listen(3000, () => console.log('Event store listening on port 3000'));
```

### Client helpers

The package also exports lightweight client-side helpers for NDJSON reads and DCB commit-condition handling:

- `HttpEventStream` parses NDJSON response bodies and exposes the optional query condition header as `commitCondition`.
- `CommitConditionHelper` builds, validates, serializes, and parses `x-event-store-query-condition` values.
- `MatcherBuilder` builds object matchers with nested paths and operator helpers.

```js
import { HttpEventStream, CommitConditionHelper, MatcherBuilder } from 'event-storage-http';

const response = await fetch('http://127.0.0.1:3000/query?types=OrderPlaced');
const stream = new HttpEventStream(response);

const events = await stream.toArray();

const matcher = new MatcherBuilder()
    .path('payload.orderId').equals('order-1')
    .path('payload.type').anyOf('OrderPlaced', 'OrderConfirmed')
    .path('metadata.total').greaterThan(24)
    .build();

const condition = stream.commitCondition ?? new CommitConditionHelper()
    .types(['OrderPlaced'])
    .noneMatchAfter(events.length)
    .matcher(matcher)
    .build();

await fetch('http://127.0.0.1:3000/streams/orders-1/commit', {
    method: 'POST',
    headers: {
        'content-type': 'application/json',
        ...CommitConditionHelper.toHeaders(condition)
    },
    body: JSON.stringify({
        events: [{ type: 'OrderConfirmed', orderId: 'order-1' }],
        condition
    })
});
```

## Endpoints

- `POST /streams/{stream}/commit`
- `PUT /streams/{stream}`
- `GET /streams`
- `GET /streams/{stream}[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]`
- `GET /streams/{stream}/version`
- `GET /streams/join[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]?streams=...`
- `GET /streams/category/{category}[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]`
- `GET /query[/from/{revision}]?types=...`
- `PUT /consumers/{identifier}/stream/{stream}[/from/{revision}]`
- `GET /consumers/{identifier}`
- `GET /consumers/{identifier}/after/{minVersion}`
- `GET /consumers`
- `GET /health`

Stream, join, category, and query reads return `application/x-ndjson`. These endpoints use the core EventStore raw mode, so event documents are streamed as newline-delimited JSON buffers directly to the HTTP response.

Query responses also expose a serialized optimistic-concurrency condition in the `x-event-store-query-condition` response header so clients can pass it back to `POST /streams/{stream}/commit`.

`start` and `end` are accepted wherever a revision boundary is expected. Matchers are JSON object matchers using the same shape as the core storage matchers (`{ stream, payload, metadata }`). The HTTP layer reuses the canonical matcher implementation from `event-storage`.

`GET /health` returns a small JSON snapshot for liveness and basic diagnostics. It includes whether the store appears open, whether it is currently writable, store length, stream/consumer counts, `event-storage` version (best effort), and selected runtime information from the Express/Node process.

### Stream endpoints

`POST /streams/{stream}/commit` appends events to a stream.

- Path params:
  - `stream`: target stream name.
- Body (JSON object):
  - `events` (required): non-empty array of event payload objects.
  - `expectedVersion` (optional): integer, `"any"`, or `"empty"`.
  - `condition` (optional): serialized DCB commit condition (`{ types, noneMatchAfter, matcher? }`).
  - `metadata` (optional): object merged into commit metadata for all events.

```json
{
  "events": [
    { "type": "OrderPlaced", "orderId": "1" }
  ],
  "expectedVersion": "any",
  "metadata": { "requestId": "req-1" }
}
```

`PUT /streams/{stream}` creates a stream index (matcher stream).

- Path params:
  - `stream`: name of the stream to create.
- Body (JSON object): matcher definition, either directly as the request body or wrapped in `matcher`.

```json
{
  "stream": ["orders-1", "orders-2"],
  "payload": { "type": "OrderPlaced" }
}
```

or

```json
{
  "matcher": {
    "stream": ["orders-1", "orders-2"],
    "payload": { "type": "OrderPlaced" }
  }
}
```

`GET /streams` returns all known streams from the in-memory stream registry, including `stream`, `closed`, `version`, and `metadata`.

`GET /streams/{stream}[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]` returns NDJSON events for one stream.

- Path params:
  - `stream`: stream name.
  - `from` / `until` (optional): revision boundary (`start`, `end`, or integer).
  - `forwards` / `backwards` (optional): max number of events in selected direction.
- Query params:
  - `filter` (optional): matcher JSON object (URL-encoded when passed as string).

**Long-polling:** When `until` is greater than the current visible version (or `from` exceeds it), stream/join/category reads enter long-poll mode. The API streams everything it can see immediately and only waits while the next in-range event is missing. If at least one event is emitted, the response status is `200` and the response closes on timeout when no further event arrives. If no event could be emitted at all before timeout, the server responds with HTTP `408 Request Timeout`.

`GET /streams/{stream}/version` returns `{ stream, version }`.

`GET /streams/join[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]?streams=...` returns one merged NDJSON stream over all listed streams.

- Query params:
  - `streams` (required): comma-separated stream names.
  - `filter` (optional): matcher JSON object.


`GET /streams/category/{category}[/from/{from}][/until/{until}][/forwards/{amount}][/backwards/{amount}]` returns NDJSON events for all streams in a category (`{category}-...` or `{category}/...`).


### Consumer endpoints

`PUT /consumers/{identifier}/stream/{stream}[/from/{revision}]` starts a durable consumer that is kept running in memory and registered in the EventStore's internal `consumers` map (keyed by `identifier`). Re-issuing the PUT replaces the existing consumer and restarts from the new handler and state.

`GET /consumers/{identifier}` returns the live position and state of the named consumer from the in-memory registry. Returns `404` if the consumer is not registered.

`GET /consumers/{identifier}/after/{minVersion}` is a long-poll endpoint that blocks until the named consumer's position reaches `minVersion` or later, then responds with the consumer's current position and state. The returned position is therefore guaranteed to be at least the requested version and may be higher. If the consumer does not advance to `minVersion` within the configured timeout (default 10 s, configurable via `options.consumerPollTimeoutMs`), the server responds with HTTP `408 Request Timeout`. The consumer must be registered in the event store's consumer registry (via `PUT` or by the startup scan) before calling this endpoint.

```http
GET /consumers/orders-reader/after/5
```

```json
{
  "identifier": "orders-reader",
  "stream": "orders",
  "position": 5,
  "state": { "count": 5 }
}
```

`GET /consumers` lists all consumers currently registered in memory. It also fires an asynchronous filesystem scan to keep the registry eventually consistent with consumers created outside of this process.

On startup, `EventStoreHttpApi` calls `eventStore.scanConsumers()` once to pre-populate the consumer registry. Pass `options.autoStartConsumers: true` to open and register all existing consumers on disk at boot time.

Raw-mode matcher notes:

- Object matchers are evaluated using the same core matcher semantics as `event-storage`, including nested equality, array OR values, and scalar operators (`$gt`, `$gte`, `$lt`, `$lte`, `$eq`, `$ne`).
- Object matchers are evaluated against compact JSON bytes (no parsing in the HTTP layer).
- Function matchers in raw mode receive a raw document `Buffer`.
- Raw object matchers require the default compact JSON serializer format.

## Benchmark snapshot (local loopback)

The benchmark script in `bench/bench-http-layer.js` measures client-observed throughput including HTTP round-trips over `127.0.0.1`.
These numbers are a coarse upper bound for the HTTP layer on this machine and can be compared directionally against the in-process benchmark.

Run used for the table below:

- Date: 2026-05-26
- Command: `npm run bench:http`
- Read fixture: 10,000 events
- Requests per lane: write `400`, read `4`

### Write performance (events/s, 1 event/commit)

| Scenario | 1 | 2 | 4 | 8 | 16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| single-event commit (sharded streams) | 809 | 1,422 | 1,731 | 2,109 | 2,389 |
| single-event commit (single stream) | 1,051 | 1,494 | 1,882 | 2,142 | 2,401 |

### Read performance (events/s)

| Scenario | 1 | 2 | 4 | 8 | 16 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 - forward full scan | 107,829 | 122,049 | 133,120 | 139,627 | 138,417 |
| 2 - backwards full scan | 113,233 | 131,419 | 140,503 | 138,803 | 139,791 |
| 3 - join stream | 127,713 | 132,546 | 142,758 | 145,804 | 143,378 |
| 4 - range scan | 97,060 | 117,719 | 131,956 | 138,267 | 137,104 |

## Further reading

Full documentation for the underlying `event-storage` library, including the EventStore API, streams, consumers, DCB concurrency, and performance notes, is available at:

👉 **https://node-event-storage.readthedocs.io/en/latest/**
