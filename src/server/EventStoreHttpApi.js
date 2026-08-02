import http from 'http';
import express from 'express';
import { once } from 'events';
import { HttpError, sendError } from './http/errors.js';
import { createMatcherCache, waitForReadyMiddleware } from './http/routeUtils.js';
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
import registerPostStreamCloseRoute from './routes/streams/postStreamClose.js';
import registerPutStreamRoute from './routes/streams/putStream.js';

/**
 * @typedef {{
 *   autoStartConsumers?: boolean|undefined,
 *   consumerPollTimeoutMs?: number|undefined,
 *   streamPollTimeoutMs?: number|undefined,
 *   matcherCacheSize?: number|undefined
 * }} EventStoreHttpApiOptions
 */

/**
 * Detect whether a value is an Express application/router (a callable with a
 * `use` method) rather than an options object.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} True when `value` looks like an Express app.
 */
function isExpressApp(value) {
    return typeof value === 'function' && typeof (/** @type {any} */(value).use) === 'function';
}

class EventStoreHttpApi {
    /**
     * Construct an API. The second argument is overloaded:
     *   - `new EventStoreHttpApi(store)` / `new EventStoreHttpApi(store, options)`
     *     builds and owns its own Express app (`this.app`).
     *   - `new EventStoreHttpApi(store, app)` / `new EventStoreHttpApi(store, app, options)`
     *     attaches the API routes onto the provided Express app.
     *
     * @param {import('event-storage').EventStore} eventStore EventStore instance. Must not be null/undefined.
     * @param {import('express').Express|EventStoreHttpApiOptions|undefined} [appOrOptions={}] An Express app to attach to, or API options.
     * @param {EventStoreHttpApiOptions|undefined} [finalOptions={}] Options, used only when an Express app is supplied as the second argument.
     */
    constructor(eventStore, appOrOptions = {}, finalOptions = {}) {
        if (!eventStore) {
            throw new Error('eventStore is required.');
        }
        const providedApp = isExpressApp(appOrOptions) ? /** @type {import('express').Express} */(appOrOptions) : null;
        const options = providedApp ? finalOptions : /** @type {EventStoreHttpApiOptions} */(appOrOptions);
        const storage = eventStore.storage;
        this.eventStore = eventStore;
        this.options = options;
        this.matcherCache = createMatcherCache(options.matcherCacheSize ?? 100);
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
        this.app = providedApp ? null : this.createApp();
        if (providedApp) {
            this.attach(providedApp);
        }
    }

    /**
     * Create and fully configure an owned Express application (including a
     * catch-all 404 handler).
     *
     * @returns {import('express').Express} Configured Express application.
     */
    createApp() {
        const app = express();
        app.disable('x-powered-by');
        this._registerRoutes(app, { includeNotFound: true });
        return app;
    }

    /**
     * Attach the API routes onto an externally-owned Express app. No catch-all
     * 404 handler is registered, so the host app may serve its own routes; an
     * error handler is still appended so API errors are serialized consistently.
     *
     * @param {import('express').Express} app Express app to mount routes on. Must not be null/undefined.
     * @returns {this} This instance, for chaining.
     */
    attach(app) {
        this.app = app;
        this._registerRoutes(app, { includeNotFound: false });
        return this;
    }

    /**
     * Register body parsing, all resource routes, and the error handler onto an
     * Express app.
     *
     * @param {import('express').Express} app Target Express app.
     * @param {{includeNotFound?: boolean|undefined}} [options={}] When `includeNotFound` is true, a catch-all 404 handler is added before the error handler.
     * @returns {void}
     */
    _registerRoutes(app, { includeNotFound = false } = {}) {
        app.use(express.json({ limit: '1mb' }));
        const routeParams = {
            eventStore: this.eventStore,
            options: this.options,
            matcherCache: this.matcherCache
        };
        registerGetHealthRoute(app, routeParams);
        app.use((request, response, next) => waitForReadyMiddleware(this.ready, request, response, next));

        registerGetConsumersRoute(app, routeParams);
        registerGetConsumerRoute(app, routeParams);
        registerGetConsumerAfterRoute(app, routeParams);
        registerPutConsumerRoute(app, routeParams);
        registerGetQueryRoute(app, routeParams);
        registerGetJoinRoute(app, routeParams);
        registerGetCategoryRoute(app, routeParams);
        registerGetStreamsRoute(app, routeParams);
        registerPostCommitRoute(app, routeParams);
        registerGetVersionRoute(app, routeParams);
        registerGetStreamRoute(app, routeParams);
        registerPutStreamRoute(app, routeParams);
        registerPostStreamCloseRoute(app, routeParams);

        /**
         * @param {import('express').Request} request Express request.
         * @param {import('express').Response} response Express response.
         * @param {import('express').NextFunction} next Express next callback.
         * @returns {void}
         */
        const handleUnknownRoute = (request, response, next) => {
            next(new HttpError(404, 'Unknown route.'));
        };

        if (includeNotFound) {
            app.use(handleUnknownRoute);
        }
        app.use(sendError);
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
 * Legacy convenience factory: builds an API that owns its Express app and
 * returns a ready HTTP server.
 *
 * @param {import('event-storage').EventStore} eventStore EventStore instance. Must not be null/undefined.
 * @param {EventStoreHttpApiOptions|undefined} [options={}] Optional API configuration.
 * @returns {import('http').Server} HTTP server wrapping the event store API.
 */
function createEventStoreHttpServer(eventStore, options = {}) {
    return new EventStoreHttpApi(eventStore, options).createServer();
}

/**
 * Explicit factory: attaches the API routes onto a caller-provided Express app
 * and returns that same app (the caller controls listening/serving).
 *
 * @param {import('event-storage').EventStore} eventStore EventStore instance. Must not be null/undefined.
 * @param {import('express').Express} app An Express app to attach routes to. Must not be null/undefined.
 * @param {EventStoreHttpApiOptions|undefined} [options={}] Optional API configuration.
 * @returns {import('express').Express} The provided app, with API routes attached.
 */
function createEventStoreHttpServerWithApp(eventStore, app, options = {}) {
    new EventStoreHttpApi(eventStore, app, options);
    return app;
}

export default EventStoreHttpApi;
export { createEventStoreHttpServer, createEventStoreHttpServerWithApp };
