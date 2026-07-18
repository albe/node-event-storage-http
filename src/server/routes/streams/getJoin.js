import { randomUUID } from 'node:crypto';
import { HttpError } from '../../http/errors.js';
import { buildReadWindow, collectSelectorLeaves, getQueryValues, parseJson, parseMatcher, parseReadOptions, parseSelector, parseStreamName } from '../../http/routeUtils.js';
import { createLongPollRunner } from '../../http/longPollRouteUtil.js';

function normalizeSelectorForAll(selector, depth = 0) {
    if (typeof selector === 'string') {
        return selector;
    }

    const normalized = selector.map(node => normalizeSelectorForAll(node, depth + 1));
    if (normalized.length === 1) {
        const child = normalized[0];
        if (!Array.isArray(child)) {
            return child;
        }
        return child.length === 1 ? child[0] : normalized;
    }
    if (normalized.every(node => node === normalized[0])) {
        return normalized[0];
    }
    if (depth % 2 !== 0) {
        return normalized.filter(node => node !== '_all');
    }
    return normalized.some(node => node === '_all') ? '_all' : normalized;
}

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerGetJoinRoute(app, { eventStore, options = {}, matcherCache } = {}) {
    const timeoutMs = options.streamPollTimeoutMs ?? 10_000;
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
        const normalizedSelector = normalizeSelectorForAll(streamSelector);
        if (normalizedSelector === '_all') {
            throw new HttpError(400, 'streams must not include "_all" for join reads. Use GET /streams/_all instead.');
        }
        const selectorLeaves = collectSelectorLeaves(normalizedSelector);

        const parsedReadOptions = parseReadOptions(rawOptions);
        const { from, until } = buildReadWindow(eventStore.length, parsedReadOptions);
        const version = eventStore.length;
        const joinName = `join:${Date.now()}:${randomUUID()}`;
        const indexNames = new Set(selectorLeaves.map(name => `stream-${name}`));

        await runLongPoll(response, {
            range: { from, until, version },
            headers: {
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
