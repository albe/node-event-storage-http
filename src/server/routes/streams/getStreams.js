import { sendJson } from '../../http/errors.js';

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetStreamsRoute(app, { eventStore } = {}) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetStreams = (request, response) => {
        const streams = Object.entries(eventStore.streams)
            .filter(([stream]) => !stream.startsWith('_'))
            .map(([stream, { index, closed }]) => ({
                stream,
                closed: closed ?? false,
                version: index.length,
                metadata: index.metadata
            }));

        sendJson(response, 200, { streams });
    };

    app.get('/streams', handleGetStreams);
}

export default registerGetStreamsRoute;
