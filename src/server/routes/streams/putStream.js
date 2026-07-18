import { HttpError, sendJson } from '../../http/errors.js';
import { parseMatcher, parseStreamName } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {void}
 */
function registerPutStreamRoute(app, eventStore, matcherCache = undefined) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handlePutStream = (request, response) => {
        const streamName = parseStreamName(decodeURIComponent(request.params[0]));
        const matcher = parseMatcher(request.body?.matcher ?? request.body, 'matcher', matcherCache);
        if (!matcher) {
            throw new HttpError(400, 'Stream creation requires a matcher object.');
        }
        const stream = eventStore.createEventStream(streamName, matcher);
        sendJson(response, 201, {
            stream: streamName,
            version: stream.version
        });
    };

    app.put(/^\/streams\/(.+)$/, handlePutStream);
}

export default registerPutStreamRoute;
