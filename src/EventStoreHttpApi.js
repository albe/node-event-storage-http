import http from 'http';
import express from 'express';
import { once } from 'events';
import { HttpError, sendError } from './http/errors.js';
import { waitForReadyMiddleware } from './http/routeUtils.js';
import registerGetConsumerRoute from './routes/consumers/getConsumer.js';
import registerGetConsumersRoute from './routes/consumers/getConsumers.js';
import registerGetConsumerAfterRoute from './routes/consumers/getConsumerAfter.js';
import registerPutConsumerRoute from './routes/consumers/putConsumer.js';
import registerGetHealthRoute from './routes/health/getHealth.js';
import registerGetQueryRoute from './routes/query/getQuery.js';
import registerGetCategoryRoute from './routes/streams/getCategory.js';
import registerGetJoinRoute from './routes/streams/getJoin.js';
import registerGetStreamsRoute from './routes/streams/getStreams.js';
import registerGetStreamRoute from './routes/streams/getStream.js';
import registerGetVersionRoute from './routes/streams/getVersion.js';
import registerPostCommitRoute from './routes/streams/postCommit.js';
import registerPutStreamRoute from './routes/streams/putStream.js';

/**
 * @typedef {{
 *   autoStartConsumers?: boolean|undefined,
 *   consumerPollTimeoutMs?: number|undefined,
 *   streamPollTimeoutMs?: number|undefined
 * }} EventStoreHttpApiOptions
 */

class EventStoreHttpApi {
    /**
     * @param {import('event-storage').EventStore} eventStore EventStore instance. Must not be null/undefined.
     * @param {EventStoreHttpApiOptions|undefined} [options={}] Optional API configuration.
     */
    constructor(eventStore, options = {}) {
        if (!eventStore) {
            throw new Error('eventStore is required.');
        }
        const storage = eventStore.storage;
        this.eventStore = eventStore;
        this.options = options;
        this.server = null;
        this.ready = storage?.initialized === true
            ? Promise.resolve()
            : once(eventStore, 'ready').then(() => undefined);
        /**
         * @param {Error|undefined} err Startup consumer scan error.
         * @returns {void}
         */
        const handleStartupConsumerScanError = (err) => {
            if (err) {
                console.error('[EventStoreHttpApi] Consumer scan error on startup:', err);
            }
        };

        /**
         * @returns {void}
         */
        const handleReady = () => {
            eventStore.scanConsumers(/* istanbul ignore next */ handleStartupConsumerScanError, options.autoStartConsumers ?? false);
        };

        this.ready.then(handleReady);
        this.app = this.createApp();
    }

    /**
     * @returns {import('express').Express} Configured Express application.
     */
    createApp() {
        const app = express();
        app.disable('x-powered-by');
        app.use(express.json({ limit: '1mb' }));
        registerGetHealthRoute(app, this.eventStore);
        app.use((request, response, next) => waitForReadyMiddleware(this.ready, request, response, next));

        registerGetConsumersRoute(app, this.eventStore);
        registerGetConsumerRoute(app, this.eventStore);
        registerGetConsumerAfterRoute(app, this.eventStore, this.options.consumerPollTimeoutMs ?? 10_000);
        registerPutConsumerRoute(app, this.eventStore);
        registerGetQueryRoute(app, this.eventStore);
        registerGetJoinRoute(app, this.eventStore, this.options.streamPollTimeoutMs ?? 10_000);
        registerGetCategoryRoute(app, this.eventStore, this.options.streamPollTimeoutMs ?? 10_000);
        registerGetStreamsRoute(app, this.eventStore);
        registerPostCommitRoute(app, this.eventStore);
        registerGetVersionRoute(app, this.eventStore);
        registerGetStreamRoute(app, this.eventStore, this.options.streamPollTimeoutMs ?? 10_000);
        registerPutStreamRoute(app, this.eventStore);

        /**
         * @param {import('express').Request} request Express request.
         * @param {import('express').Response} response Express response.
         * @param {import('express').NextFunction} next Express next callback.
         * @returns {void}
         */
        const handleUnknownRoute = (request, response, next) => {
            next(new HttpError(404, 'Unknown route.'));
        };

        app.use(handleUnknownRoute);
        app.use(sendError);
        return app;
    }

    /**
     * @returns {import('http').Server} Lazily created HTTP server.
     */
    createServer() {
        if (!this.server) {
            this.server = http.createServer(this.app);
        }
        return this.server;
    }

    /**
     * @param {...any} args Parameters forwarded to `server.listen(...)`.
     * @returns {import('http').Server} HTTP server instance.
     */
    listen(...args) {
        return this.createServer().listen(...args);
    }

    /**
     * @param {((error?: Error|undefined) => void)|undefined} callback Optional close callback.
     * @returns {import('http').Server|undefined} Server close result, or `undefined` when no server exists.
     */
    close(callback) {
        if (!this.server) {
            callback?.();
            return undefined;
        }
        return this.server.close(callback);
    }
}

/**
 * @param {import('event-storage').EventStore} eventStore EventStore instance. Must not be null/undefined.
 * @param {EventStoreHttpApiOptions|undefined} [options={}] Optional API configuration.
 * @returns {import('http').Server} HTTP server wrapping the event store API.
 */
function createEventStoreHttpServer(eventStore, options = {}) {
    return new EventStoreHttpApi(eventStore, options).createServer();
}

export default EventStoreHttpApi;
export { createEventStoreHttpServer };
