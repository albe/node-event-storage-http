import { HttpError, sendJson } from '../../http/errors.js';
import { parseStreamName } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetVersionRoute(app, eventStore) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetVersion = (request, response) => {
        const streamName = parseStreamName(decodeURIComponent(request.params[0]));
        const version = eventStore.getStreamVersion(streamName);
        if (version === -1) {
            throw new HttpError(404, `Stream "${streamName}" does not exist.`);
        }
        sendJson(response, 200, { stream: streamName, version });
    };

    app.get(/^\/streams\/(.+)\/version$/, handleGetVersion);
}

export default registerGetVersionRoute;
