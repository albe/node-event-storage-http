import { HttpError } from '../../http/errors.js';
import { writeNdjson } from '../../http/ndjson.js';
import { buildReadWindow, getQueryValues, parseMatcher, parseReadOptions, parseStreamName } from '../../http/routeUtils.js';
import { shouldLongPoll, streamUntilVersion } from '../../http/streamPoll.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @returns {void}
 */
function registerGetJoinRoute(app, eventStore, timeoutMs = 10_000) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetJoin = async (request, response) => {
        const rawOptions = request.params[0] || '';
        const filter = parseMatcher(request.query.filter, 'filter');
        const streamNames = getQueryValues(request.query.streams).map(streamName => parseStreamName(streamName, 'streams'));
        if (streamNames.length === 0) {
            throw new HttpError(400, 'streams query parameter is required.');
        }

        const options = parseReadOptions(rawOptions);
        const { from, until } = buildReadWindow(eventStore.length, options);
        const version = eventStore.length;

        if (shouldLongPoll(from, until, version)) {
            const indexNames = new Set(streamNames.map(name => `stream-${name}`));
            try {
                await streamUntilVersion(response, {
                    from,
                    until,
                    currentVersion: version,
                    headers: {
                        'x-event-store-streams': streamNames.join(',')
                    },
                    timeoutMs,
                    eventSource: eventStore.storage,
                    getAvailableVersionOnIndexAdd: (indexName) => (
                        indexNames.has(indexName) ? eventStore.length : undefined
                    ),
                    createStream: (rangeFrom, rangeUntil) => eventStore.fromStreams(`join:${streamNames.join(',')}`, streamNames, rangeFrom, rangeUntil, filter, true)
                });
            } catch (error) {
                if (!response.headersSent) {
                    throw error;
                }
            }
            return;
        }

        const stream = eventStore.fromStreams(`join:${streamNames.join(',')}`, streamNames, from, until, filter, true);
        await writeNdjson(response, stream, {
            'x-event-store-streams': streamNames.join(',')
        });
    };

    app.get(/^\/streams\/join(?:\/(.*))?$/, handleGetJoin);
}

export default registerGetJoinRoute;
