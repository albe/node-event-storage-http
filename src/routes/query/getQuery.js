import { HttpError } from '../../http/errors.js';
import { writeNdjson } from '../../http/ndjson.js';
import { getQueryValues, parseMatcher, parseRevision, parseStreamName, resolveBoundary, serializeCondition } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetQueryRoute(app, eventStore) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetQuery = async (request, response) => {
        const types = getQueryValues(request.query.types).map(type => parseStreamName(type, 'types'));
        if (types.length === 0) {
            throw new HttpError(400, 'types query parameter is required.');
        }

        const filter = parseMatcher(request.body?.matcher ?? request.body ?? request.query.filter, 'filter');
        const parsedRevision = request.params.revision
            ? parseRevision(request.params.revision, 'from')
            : undefined;
        const minRevision = resolveBoundary(parsedRevision, 1, eventStore.length);
        const { stream, condition } = eventStore.query(types, filter, minRevision, true);
        await writeNdjson(response, stream, {
            'x-event-store-query-condition': serializeCondition(condition, filter),
            'x-event-store-query-types': types.join(',')
        });
    };

    app.get(['/query', '/query/from/:revision'], handleGetQuery);
}

export default registerGetQueryRoute;
