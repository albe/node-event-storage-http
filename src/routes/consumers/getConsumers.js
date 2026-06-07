import { sendJson } from '../../http/errors.js';

const SCAN_DEBOUNCE_MS = 5_000;

/**
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetConsumersRoute(app, eventStore) {
    let lastScanAt = 0;

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetConsumers = (request, response) => {
        // Return the current in-memory registry immediately.
        const consumers = [...eventStore.consumers.entries()].map(([identifier, consumer]) => ({
            identifier,
            stream: consumer.streamName
        }));

        // Fire off an async filesystem scan so consumers created externally are eventually
        // added to the registry and visible in subsequent calls, debounced to avoid hammering the fs.
        const now = Date.now();
        if (now - lastScanAt > SCAN_DEBOUNCE_MS) {
            lastScanAt = now;
            eventStore.scanConsumers((err) => {
                /* istanbul ignore next */
                if (err) {
                    console.error('[EventStoreHttpApi] Background consumer scan error:', err);
                }
            }, true);
        }

        sendJson(response, 200, { consumers });
    };

    app.get('/consumers', handleGetConsumers);
}

export default registerGetConsumersRoute;
