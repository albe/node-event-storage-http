import { HttpError } from '../../http/errors.js';
import { writeNdjson } from '../../http/ndjson.js';
import { buildReadWindow, parseMatcher, splitReadStreamPath } from '../../http/routeUtils.js';
import { shouldLongPoll, streamUntilVersion } from '../../http/streamPoll.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @returns {void}
 */
function registerGetStreamRoute(app, eventStore, timeoutMs = 10_000) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetStream = async (request, response) => {
        const { resourceName: streamName, options } = splitReadStreamPath(request.params[0]);
        const filter = parseMatcher(request.query.filter, 'filter');
        const version = eventStore.getStreamVersion(streamName);
        if (version === -1) {
            throw new HttpError(404, `Stream "${streamName}" does not exist.`);
        }
        const { from, until } = buildReadWindow(version, options);

        if (shouldLongPoll(from, until, version)) {
            try {
                await streamUntilVersion(response, {
                    from,
                    until,
                    currentVersion: version,
                    headers: {
                        'x-event-store-stream': streamName,
                        'x-event-store-version': String(version)
                    },
                    timeoutMs,
                    eventSource: eventStore.storage,
                    getAvailableVersionOnIndexAdd: (indexName, indexLength) => (
                        indexName === `stream-${streamName}` ? indexLength : undefined
                    ),
                    createStream: (rangeFrom, rangeUntil) => eventStore.getEventStream(streamName, rangeFrom, rangeUntil, filter, true)
                });
            } catch (error) {
                if (!response.headersSent) {
                    throw error;
                }
            }
            return;
        }

        const stream = eventStore.getEventStream(streamName, from, until, filter, true);
        await writeNdjson(response, stream, {
            'x-event-store-stream': streamName,
            'x-event-store-version': String(version)
        });
    };

    app.get(/^\/streams\/(?!join(?:\/|$))(?!category(?:\/|$))(.+)$/, handleGetStream);
}

export default registerGetStreamRoute;
