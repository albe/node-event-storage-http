import { sendJson } from '../../http/errors.js';
import StorageStatsCollector from "../../StatsCollector.js";

/**
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {string|null} Resolved event-storage version from the EventStore class.
 */
function getEventStorageVersion(eventStore) {
    const version = eventStore?.constructor?.VERSION;
    return typeof version === 'string' ? version : null;
}

/**
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {boolean} True when the store appears open for reads/writes.
 */
function isStoreOpen(eventStore) {
    const storage = eventStore?.storage;
    if (!storage || !storage.index) {
        return false;
    }
    const initialized = storage.initialized === true;
    const indexOpen = typeof storage.index.isOpen === 'function'
        ? storage.index.isOpen()
        : true;
    return initialized && indexOpen;
}

/**
 * @param {import('express').Express} app Express app instance.
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {void}
 */
function registerGetHealthRoute(app, { eventStore } = {}) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetHealth = (request, response) => {
        const storage = eventStore.storage;
        const streamCount = Object.keys(eventStore.streams || {})
            .filter(streamName => !streamName.startsWith('_'))
            .length;
        const consumerCount = eventStore.consumers?.size ?? 0;
        const open = isStoreOpen(eventStore);
        const writable = typeof storage?.flush === 'function';

        sendJson(response, open ? 200 : 503, {
            status: open ? 'ok' : 'degraded',
            store: {
                open,
                writable,
                length: eventStore.length,
                streams: streamCount,
                consumers: consumerCount,
                eventStorageVersion: getEventStorageVersion(eventStore)
            },
            server: {
                env: request.app.get('env'),
                uptimeSeconds: Math.floor(process.uptime()),
                nodeVersion: process.version
            }
        });
    };

    app.get('/health', handleGetHealth);

    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {void}
     */
    const handleGetStats = (request, response) => {
        const storage = eventStore.storage;
        const open = isStoreOpen(eventStore);
        const statsCollector = new StorageStatsCollector(storage);

        sendJson(response, open ? 200 : 503, statsCollector.stats());
    };

    app.get('/health/stats', handleGetStats);
}

export default registerGetHealthRoute;

