/**
 * Client layer: everything needed to consume the HTTP API from a browser or a
 * server-side process. Importing this entry point loads zero `express` and zero
 * server code — only the protocol helpers it depends on.
 */
export { default as HttpEventStream } from './HttpEventStream.js';
export { default as EventStoreHttpClient } from './EventStoreHttpClient.js';

// Re-export protocol helpers commonly used alongside the client.
export { CommitConditionHelper, MatcherBuilder, CONDITION_HEADER, eventPosition, commitPosition, NdjsonDecoder } from '../protocol/index.js';
