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
function registerGetCategoryRoute(app, eventStore, timeoutMs = 10_000, matcherCache = undefined) {
    const runLongPoll = createLongPollRunner(eventStore, timeoutMs);

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetCategory = async (request, response) => {
        const { resourceName: category, options } = splitReadStreamPath(request.params[0]);
        const filter = parseMatcher(request.query.filter, 'filter', matcherCache);

        const categoryStreams = Object.keys(eventStore.streams).filter(streamName =>
            streamName.startsWith(category + '-') ||
            streamName.startsWith(category + '/')
        );
        if (categoryStreams.length === 0) {
            throw new HttpError(404, `No streams for category '${category}' exist.`);
        }

        const { from, until } = buildReadWindow(eventStore.length, options);
        const version = eventStore.length;
        const prefixedCategory = `stream-${category}`;

        await runLongPoll(response, {
            range: { from, until, version },
            headers: { 'x-event-store-category': category },
            source: {
                getAvailableVersionOnIndexAdd: (indexName) => (
                    indexName === prefixedCategory ||
                    indexName.startsWith(prefixedCategory + '-') ||
                    indexName.startsWith(prefixedCategory + '/')
                        ? eventStore.length
                        : undefined
                ),
                createStream: (rangeFrom, rangeUntil) => eventStore.getEventStreamForCategory(category, rangeFrom, rangeUntil, filter, true)
            }
        });
    };

    app.get(/^\/streams\/category\/(.+)$/, handleGetCategory);
}

export default registerGetCategoryRoute;
