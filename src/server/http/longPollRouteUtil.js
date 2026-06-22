import { writeNdjson } from './ndjson.js';
import { shouldLongPoll, streamUntilVersion } from './streamPoll.js';

/**
 * @typedef {{
 *   createStream: (from: number, until: number) => import('event-storage').EventStream|false,
 *   getAvailableVersionOnIndexAdd: (indexName: string, indexLength: number, document: object|undefined) => number|undefined
 * }} StreamSource
 */

/**
 * Create a route-scoped long-poll runner with eventStore and timeoutMs pre-compiled.
 *
 * @param {import('event-storage').EventStore} eventStore
 * @param {number} [timeoutMs=10_000]
 * @returns {(
 *   response: import('express').Response,
 *   options: {
 *     range: { from: number, until: number, version: number },
 *     headers?: Record<string, string>,
 *     source: StreamSource
 *   }
 * ) => Promise<void>}
 */
function createLongPollRunner(eventStore, timeoutMs = 10_000) {
    const eventSource = eventStore.storage;

    return async function runLongPollRoute(response, { range, headers = {}, source }) {
        const { from, until, version } = range;
        const { createStream, getAvailableVersionOnIndexAdd } = source;

        if (!shouldLongPoll(from, until, version)) {
            await writeNdjson(response, createStream(from, until), headers);
            return;
        }

        try {
            await streamUntilVersion(response, {
                from,
                until,
                currentVersion: version,
                headers,
                timeoutMs,
                eventSource,
                getAvailableVersionOnIndexAdd,
                createStream
            });
        } catch (error) {
            if (!response.headersSent) {
                throw error;
            }
        }
    };
}

export { createLongPollRunner };
