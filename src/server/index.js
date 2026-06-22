/**
 * Server layer (default `.` entry point). Importing this loads the full HTTP
 * server stack, including `express`.
 *
 * For backwards compatibility this entry point also re-exports the protocol and
 * client building blocks, so existing `import { HttpEventStream } from
 * 'event-storage-http'` keeps working. Code that wants to avoid loading
 * `express` should import from `event-storage-http/client` or
 * `event-storage-http/protocol` instead.
 */
export {
    default,
    default as EventStoreHttpApi,
    createEventStoreHttpServer,
    createEventStoreHttpServerWithApp
} from './EventStoreHttpApi.js';

export { default as StorageStatsCollector } from './StatsCollector.js';

// Backwards-compatible re-exports of the lower layers.
export { CommitConditionHelper, MatcherBuilder, CONDITION_HEADER, eventPosition, commitPosition, NdjsonDecoder } from '../protocol/index.js';
export { HttpEventStream, EventStoreHttpClient } from '../client/index.js';
