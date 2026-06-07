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
function registerGetCategoryRoute(app, eventStore, timeoutMs = 10_000) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetCategory = async (request, response) => {
        const { resourceName: category, options } = splitReadStreamPath(request.params[0]);
        const filter = parseMatcher(request.query.filter, 'filter');

        const categoryStreams = Object.keys(eventStore.streams).filter(streamName =>
            streamName.startsWith(category + '-') ||
            streamName.startsWith(category + '/')
        );
        if (categoryStreams.length === 0) {
            throw new HttpError(404, `No streams for category '${category}' exist.`);
        }

        const { from, until } = buildReadWindow(eventStore.length, options);
        const version = eventStore.length;

        if (shouldLongPoll(from, until, version)) {
            const prefixedCategory = `stream-${category}`;
            try {
                await streamUntilVersion(response, {
                    from,
                    until,
                    currentVersion: version,
                    headers: {
                        'x-event-store-category': category
                    },
                    timeoutMs,
                    eventSource: eventStore.storage,
                    getAvailableVersionOnIndexAdd: (indexName) => (
                        indexName === prefixedCategory ||
                        indexName.startsWith(prefixedCategory + '-') ||
                        indexName.startsWith(prefixedCategory + '/')
                            ? eventStore.length
                            : undefined
                    ),
                    createStream: (rangeFrom, rangeUntil) => eventStore.getEventStreamForCategory(category, rangeFrom, rangeUntil, filter, true)
                });
            } catch (error) {
                if (!response.headersSent) {
                    throw error;
                }
            }
            return;
        }

        const categoryStream = eventStore.getEventStreamForCategory(category, from, until, filter, true);
        await writeNdjson(response, categoryStream, {
            'x-event-store-category': category
        });
    };

    app.get(/^\/streams\/category\/(.+)$/, handleGetCategory);
}

export default registerGetCategoryRoute;
