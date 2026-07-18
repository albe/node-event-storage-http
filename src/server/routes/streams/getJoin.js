import { HttpError } from '../../http/errors.js';
import { buildReadWindow, collectSelectorLeaves, getQueryValues, parseJson, parseMatcher, parseReadOptions, parseSelector, parseStreamName } from '../../http/routeUtils.js';
import { createLongPollRunner } from '../../http/longPollRouteUtil.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerGetJoinRoute(app, eventStore, timeoutMs = 10_000, matcherCache = undefined) {
    const runLongPoll = createLongPollRunner(eventStore, timeoutMs);

    /**
     * @param {import('express').Request} request Express request.
     * @returns {string|string[]} Parsed selector.
     */
    const parseJoinSelector = (request) => {
        const rawSelector = request.query.selector;
        if (rawSelector !== undefined) {
            const selectorInput = typeof rawSelector === 'string'
                ? parseJson(rawSelector, 'selector')
                : rawSelector;
            return parseSelector(selectorInput, 'selector', true);
        }

        const streamNames = getQueryValues(request.query.streams).map(streamName => parseStreamName(streamName, 'streams', true));
        if (streamNames.length === 0) {
            throw new HttpError(400, 'streams or selector query parameter is required.');
        }
        return streamNames;
    };

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetJoin = async (request, response) => {
        const rawOptions = request.params[0] || '';
        const filter = parseMatcher(request.query.filter, 'filter', matcherCache);
        const streamSelector = parseJoinSelector(request);
        const selectorLeaves = collectSelectorLeaves(streamSelector);
        if (selectorLeaves.includes('_all')) {
            throw new HttpError(400, 'streams must not include "_all" for join reads. Use GET /streams/_all instead.');
        }

        const options = parseReadOptions(rawOptions);
        const { from, until } = buildReadWindow(eventStore.length, options);
        const version = eventStore.length;
        const joinName = `join:${selectorLeaves.join(',') || 'selector'}`;
        const indexNames = new Set(selectorLeaves.map(name => `stream-${name}`));

        await runLongPoll(response, {
            range: { from, until, version },
            headers: {
                'x-event-store-streams': selectorLeaves.join(','),
                'x-event-store-selector': JSON.stringify(streamSelector)
            },
            source: {
                getAvailableVersionOnIndexAdd: (indexName) => (
                    indexNames.has(indexName) ? eventStore.length : undefined
                ),
                createStream: (rangeFrom, rangeUntil) => eventStore.fromStreams(joinName, streamSelector, rangeFrom, rangeUntil, filter, true)
            }
        });
    };

    app.get(/^\/streams\/join(?:\/(.*))?$/, handleGetJoin);
}

export default registerGetJoinRoute;
