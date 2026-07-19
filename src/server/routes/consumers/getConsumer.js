import { HttpError, sendJson } from '../../http/errors.js';
import { parseConsumerIdentifier } from '../../http/routeUtils.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetConsumerRoute(app, { eventStore } = {}) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetConsumer = (request, response) => {
        const identifier = parseConsumerIdentifier(request.params.identifier);
        const consumer = eventStore.getConsumer(identifier);
        if (!consumer) {
            throw new HttpError(404, `Consumer "${identifier}" does not exist.`);
        }
        return sendJson(response, 200, {
            identifier,
            stream: consumer.streamName,
            position: consumer.position,
            state: consumer.state
        });
    };

    app.get('/consumers/:identifier', handleGetConsumer);
}

export default registerGetConsumerRoute;
