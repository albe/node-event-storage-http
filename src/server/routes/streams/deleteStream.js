import { HttpError, sendJson } from '../../http/errors.js';
import { parseStreamName } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerDeleteStreamRoute(app, { eventStore } = {}) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleDeleteStream = (request, response) => {
        const streamName = parseStreamName(decodeURIComponent(request.params[0]));
        try {
            eventStore.closeEventStream(streamName);
        } catch (err) {
            const message = err?.message ?? String(err);
            if (message.includes('read-only')) {
                throw new HttpError(409, 'Cannot close a stream on a read-only store.');
            }
            if (message.includes('does not exist')) {
                throw new HttpError(404, `Stream "${streamName}" does not exist.`);
            }
            if (message.includes('already closed')) {
                throw new HttpError(409, `Stream "${streamName}" is already closed.`);
            }
            throw err;
        }
        sendJson(response, 200, { stream: streamName, closed: true });
    };

    app.delete(/^\/streams\/(.+)$/, handleDeleteStream);
}

export default registerDeleteStreamRoute;
