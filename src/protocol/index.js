/**
 * Protocol layer: framework-free, server-free building blocks shared by clients
 * and servers. Importing this entry point loads zero `express` and zero server
 * code.
 */
export { CommitConditionHelper, MatcherBuilder, CONDITION_HEADER } from './CommitConditionHelper.js';
export { eventPosition, commitPosition } from './positions.js';
export { NdjsonDecoder } from './ndjson.js';
