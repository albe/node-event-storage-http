import { HttpError } from '../../http/errors.js';
import { buildReadWindow, parseMatcher, splitReadStreamPath } from '../../http/routeUtils.js';
import { createLongPollRunner } from '../../http/longPollRouteUtil.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerGetStreamRoute(app, { eventStore, options = {}, matcherCache } = {}) {
    const timeoutMs = options.streamPollTimeoutMs ?? 10_000;
    const runLongPoll = createLongPollRunner(eventStore, timeoutMs);

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetStream = async (request, response) => {
        const { resourceName: streamName, options } = splitReadStreamPath(request.params[0], true);
        const filter = parseMatcher(request.query.filter, 'filter', matcherCache);
        const version = eventStore.getStreamVersion(streamName);
        if (version === -1) {
            throw new HttpError(404, `Stream "${streamName}" does not exist.`);
        }
        const { from, until } = buildReadWindow(version, options);

        await runLongPoll(response, {
            range: { from, until, version },
            headers: {
                'x-event-store-stream': streamName,
                'x-event-store-version': String(version)
            },
            source: {
                getAvailableVersionOnIndexAdd: (indexName, indexLength) => (
                    indexName === `stream-${streamName}` ? indexLength : undefined
                ),
                createStream: (rangeFrom, rangeUntil) => eventStore.getEventStream(streamName, rangeFrom, rangeUntil, filter, true)
            }
        });
    };

    app.get(/^\/streams\/(?!join(?:\/|$))(?!category(?:\/|$))(.+)$/, handleGetStream);
}

export default registerGetStreamRoute;
