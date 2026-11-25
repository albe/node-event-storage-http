import { HttpError, sendJson } from '../../http/errors.js';
import { hasPreference, parseCondition, parseExpectedVersion, parseStreamName } from '../../http/routeUtils.js';
import { commitPosition, POSITION_HEADER } from '../../../protocol/index.js';

const RESPOND_UNFLUSHED = 'respond-unflushed';

/**
 * @param {import('express').Response} response Express response.
 * @param {number} status HTTP status code.
 * @param {object} commit The commit returned by or passed to `eventStore.commit()`.
 * @param {Record<string, string>} [headers={}] Extra headers.
 * @returns {void}
 */
function sendCommit(response, status, commit, headers = {}) {
    sendJson(response, status, commit, { [POSITION_HEADER]: String(commitPosition(commit)), ...headers });
}

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance passed through to commit helpers.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerPostCommitRoute(app, { eventStore, matcherCache } = {}) {
    /**
     * The response waits for the commit callback, i.e. the acknowledged write. The position of a commit is already
     * known when `commit()` returns, so a client that only needs the position can skip the wait with
     * `Prefer: respond-unflushed`.
     *
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
        let acknowledge;
        const acknowledged = new Promise(resolve => {
            acknowledge = resolve;
        });
        const commit = eventStore.commit(streamName, body.events, expectedVersion, metadata, acknowledge);
        if (hasPreference(request, RESPOND_UNFLUSHED)) {
            sendCommit(response, 202, commit, { 'preference-applied': RESPOND_UNFLUSHED });
            return;
        }
        sendCommit(response, 201, await acknowledged);
    };

    app.post(/^\/streams\/(.+)\/commit$/, handlePostCommit);
}

export default registerPostCommitRoute;
