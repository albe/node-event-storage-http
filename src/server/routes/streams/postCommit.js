import { HttpError, sendJson } from '../../http/errors.js';
import { commitAsync, parseCondition, parseExpectedVersion, parseStreamName } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance passed through to commit helpers.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerPostCommitRoute(app, { eventStore, matcherCache } = {}) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handlePostCommit = async (request, response) => {
        const streamName = parseStreamName(decodeURIComponent(request.params[0]));
        const body = request.body ?? {};
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new HttpError(400, 'Commit payload must be a JSON object.');
        }
        if (!Array.isArray(body.events) || body.events.length === 0) {
            throw new HttpError(400, 'Commit payload must include a non-empty events array.');
        }

        const expectedVersion = body.condition !== undefined
            ? parseCondition(body.condition, matcherCache)
            : parseExpectedVersion(body.expectedVersion);
        const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {};
        const commit = await commitAsync(eventStore, streamName, body.events, expectedVersion, metadata);
        sendJson(response, 201, commit);
    };

    app.post(/^\/streams\/(.+)\/commit$/, handlePostCommit);
}

export default registerPostCommitRoute;
