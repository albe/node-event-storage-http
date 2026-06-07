import { sendJson } from '../../http/errors.js';

function registerGetStreamsRoute(app, eventStore) {
    app.get('/streams', (request, response) => {
        const streams = Object.entries(eventStore.streams)
            .filter(([stream]) => !stream.startsWith('_'))
            .map(([stream, { index,  closed }]) => ({
                stream,
                closed: closed ?? false,
                length: index.length,
                metadata: index.metadata
            }));

        sendJson(response, 200, { streams });
    });
}

export default registerGetStreamsRoute;

