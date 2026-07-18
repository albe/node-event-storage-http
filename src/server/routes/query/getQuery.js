import { HttpError } from '../../http/errors.js';
import { writeNdjson } from '../../http/ndjson.js';
import { collectSelectorLeaves, getQueryValues, parseJson, parseMatcher, parseRevision, parseSelector, parseStreamName, resolveBoundary, serializeCondition } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerGetQueryRoute(app, eventStore, matcherCache = undefined) {
    /**
     * @param {import('express').Request} request
     * @returns {object|null}
     */
    const parseDcbQueryShorthand = (request) => {
        const bodyQuery = request.body?.query ?? request.body;
        if (bodyQuery && typeof bodyQuery === 'object' && !Array.isArray(bodyQuery) && Array.isArray(bodyQuery.items)) {
            return bodyQuery;
        }

        const rawQuery = request.query.query;
        if (rawQuery !== undefined) {
            const parsedQuery = typeof rawQuery === 'string'
                ? parseJson(rawQuery, 'query')
                : rawQuery;
            if (!parsedQuery || typeof parsedQuery !== 'object' || Array.isArray(parsedQuery) || !Array.isArray(parsedQuery.items)) {
                throw new HttpError(400, 'query must be a DCB query object with a non-empty items array.');
            }
            return parsedQuery;
        }
        return null;
    };

    /**
     * @param {import('express').Request} request
     * @returns {string|string[]}
     */
    const parseSelectorInput = (request) => {
        const dcbQuery = parseDcbQueryShorthand(request);
        if (dcbQuery) {
            return dcbQuery;
        }

        const rawSelector = request.query.selector;
        if (rawSelector !== undefined) {
            const selectorInput = typeof rawSelector === 'string'
                ? parseJson(rawSelector, 'selector')
                : rawSelector;
            return parseSelector(selectorInput, 'selector', true);
        }

        const types = getQueryValues(request.query.types).map(type => parseStreamName(type, 'types', true));
        if (types.length === 0) {
            throw new HttpError(400, 'types, selector, or query parameter is required.');
        }
        return types;
    };

    /**
     * @param {import('express').Request} request
     * @returns {object|string|undefined}
     */
    const extractBodyMatcher = (request) => {
        if (request.body?.matcher !== undefined) {
            return request.body.matcher;
        }
        if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
            return undefined;
        }
        if (Array.isArray(request.body.items) || Array.isArray(request.body.query?.items)) {
            return undefined;
        }
        return request.body;
    };

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetQuery = async (request, response) => {
        const selectorInput = parseSelectorInput(request);
        const bodyMatcher = extractBodyMatcher(request);
        const filter = parseMatcher(bodyMatcher ?? request.query.filter, 'filter', matcherCache);
        const parsedRevision = request.params.revision
            ? parseRevision(request.params.revision, 'from')
            : undefined;
        const minRevision = resolveBoundary(parsedRevision, 1, eventStore.length);
        const { stream, condition } = eventStore.query(selectorInput, filter, minRevision, true);
        const selectorLeaves = collectSelectorLeaves(condition.selector ?? selectorInput);
        await writeNdjson(response, stream, {
            'x-event-store-query-condition': serializeCondition(condition, filter),
            'x-event-store-query-types': selectorLeaves.join(',')
        });
    };

    app.get(['/query', '/query/from/:revision'], handleGetQuery);
}

export default registerGetQueryRoute;
