import { eventPosition } from '../protocol/positions.js';
import HttpEventStream from './HttpEventStream.js';

/**
 * @typedef {{
 *   baseUrl?: string|undefined,
 *   getToken?: (() => string|Promise<string>)|undefined,
 *   fetch?: typeof globalThis.fetch|undefined,
 *   pollTimeoutMs?: number|undefined
 * }} EventStoreHttpClientOptions
 */

/**
 * @typedef {{
 *   kind: 'stream'|'category'|'join',
 *   name?: string|undefined,
 *   streams?: string[]|undefined,
 *   selector?: string|Array<string|any>|undefined
 * }} FollowSource
 */

/**
 * Thin client over the event-storage HTTP API. Reads stream/category/join
 * resources as NDJSON, commits events, and follows a source as a long-lived
 * async iterator. Pulls in zero server code or `express`.
 */
class EventStoreHttpClient {
    /**
     * @param {EventStoreHttpClientOptions} [options={}] Client configuration.
     */
    constructor(options = {}) {
        this.baseUrl = options.baseUrl ?? 'http://127.0.0.1:3000';
        this.getToken = options.getToken;
        this.fetch = options.fetch ?? globalThis.fetch;
        this.pollTimeoutMs = options.pollTimeoutMs ?? 10_000;
    }

    /**
     * @param {string} method HTTP method.
     * @param {string} path Request path (relative to `baseUrl`).
     * @param {{headers?: Record<string, string>, body?: string|null, signal?: AbortSignal|null}} [init={}] Request options.
     * @returns {Promise<Response>} The fetch Response (only for 2xx).
     */
    async _request(method, path, { headers = {}, body = null, signal = null } = {}) {
        const url = new URL(path, this.baseUrl);
        const token = this.getToken ? await this.getToken() : null;
        const finalHeaders = { ...headers };
        if (token) {
            finalHeaders['Authorization'] = `Bearer ${token}`;
        }
        const res = await this.fetch(url, { method, headers: finalHeaders, body, signal });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`${method} ${path} ${res.status}: ${text}`);
        }
        return res;
    }

    /**
     * Build the read path for a follow/read source.
     *
     * @param {FollowSource} source Resource descriptor.
     * @param {number} from Inclusive lower position.
     * @param {number|undefined} until Inclusive upper position.
     * @returns {string} Request path.
     */
    _readPath(source, from, until) {
        const range = `/from/${from}${until !== undefined ? `/until/${until}` : ''}`;
        if (source.kind === 'stream') {
            return `/streams/${encodeURIComponent(source.name)}${range}`;
        }
        if (source.kind === 'category') {
            return `/streams/category/${encodeURIComponent(source.name)}${range}`;
        }
        if (source.kind === 'join') {
            if (source.selector !== undefined) {
                const selector = encodeURIComponent(JSON.stringify(source.selector));
                return `/streams/join${range}?selector=${selector}`;
            }
            const streams = source.streams.map(name => encodeURIComponent(name)).join(',');
            return `/streams/join${range}?streams=${streams}`;
        }
        throw new TypeError(`Unknown source kind: ${source.kind}`);
    }

    /**
     * @param {string} name Stream name.
     * @param {{from?: number, until?: number, signal?: AbortSignal}} [options={}] Read window.
     * @returns {Promise<HttpEventStream>} NDJSON event stream.
     */
    async readStream(name, { from = 1, until, signal } = {}) {
        const res = await this._request('GET', this._readPath({ kind: 'stream', name }, from, until), { signal });
        return new HttpEventStream(res);
    }

    /**
     * @param {string} name Category name.
     * @param {{from?: number, until?: number, signal?: AbortSignal}} [options={}] Read window.
     * @returns {Promise<HttpEventStream>} NDJSON event stream.
     */
    async readCategory(name, { from = 1, until, signal } = {}) {
        const res = await this._request('GET', this._readPath({ kind: 'category', name }, from, until), { signal });
        return new HttpEventStream(res);
    }

    /**
     * @param {string[]|string|Array<string|any>} selectorOrStreams Join selector (nested algebra) or flat stream names.
     * @param {{from?: number, until?: number, signal?: AbortSignal}} [options={}] Read window.
     * @returns {Promise<HttpEventStream>} NDJSON event stream.
     */
    async readJoin(selectorOrStreams, { from = 1, until, signal } = {}) {
        const source = { kind: 'join', selector: selectorOrStreams };
        const res = await this._request('GET', this._readPath(source, from, until), { signal });
        return new HttpEventStream(res);
    }

    /**
     * @param {string[]|object} selectorOrQuery Legacy types array or DCB query object.
     * @param {{from?: number, filter?: object|null, signal?: AbortSignal}} [options={}] Query options.
     * @returns {Promise<HttpEventStream>} NDJSON event stream.
     */
    async readQuery(selectorOrQuery, { from, filter = null, signal } = {}) {
        const queryParams = [];
        if (Array.isArray(selectorOrQuery)) {
            queryParams.push(`types=${selectorOrQuery.map(type => encodeURIComponent(type)).join(',')}`);
        } else {
            queryParams.push(`query=${encodeURIComponent(JSON.stringify(selectorOrQuery))}`);
        }
        if (filter) {
            queryParams.push(`filter=${encodeURIComponent(JSON.stringify(filter))}`);
        }
        const queryString = queryParams.length > 0 ? `?${queryParams.join('&')}` : '';
        const fromPath = from !== undefined ? `/from/${from}` : '';
        const res = await this._request('GET', `/query${fromPath}${queryString}`, { signal });
        return new HttpEventStream(res);
    }

    /**
     * Continuously follow a source, yielding batches of events as they arrive.
     * Reconnects with a fixed backoff on transient errors; stops only when the
     * provided signal is aborted.
     *
     * @param {FollowSource} source Resource descriptor.
     * @param {{fromPosition?: number, windowSize?: number, signal?: AbortSignal}} [options={}] Follow options. `fromPosition` is the 1-based revision cursor to resume from.
     * @yields {{events: object[], position: number}}
     * @returns {AsyncGenerator<{events: object[], position: number}, void, undefined>}
     */
    async *follow(source, { fromPosition = 1, windowSize = 1_000_000, signal } = {}) {
        let position = fromPosition;

        while (true) {
            if (signal?.aborted) {
                return;
            }
            const until = position + windowSize;
            try {
                const res = await this._request('GET', this._readPath(source, position, until), { signal });
                const stream = new HttpEventStream(res);
                const events = [];
                for await (const event of stream) {
                    events.push(event);
                    position = eventPosition(event);
                }
                if (events.length > 0) {
                    yield { events, position };
                }
            } catch (err) {
                if (signal?.aborted) {
                    throw err;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    /**
     * @param {string} stream Target stream name.
     * @param {object[]} events Events to append.
     * @param {{condition?: object|null, metadata?: object|null, signal?: AbortSignal}} [options={}] Commit options.
     * @returns {Promise<object>} The commit result.
     */
    async commit(stream, events, { condition = null, metadata = null, signal } = {}) {
        // The commit route reads `condition`/`metadata` from the JSON body.
        const payload = { events };
        if (condition) {
            payload.condition = condition;
        }
        if (metadata) {
            payload.metadata = metadata;
        }
        const headers = { 'Content-Type': 'application/json' };
        const res = await this._request('POST', `/streams/${encodeURIComponent(stream)}/commit`, {
            headers,
            body: JSON.stringify(payload),
            signal
        });
        return res.json();
    }

    /**
     * @returns {Promise<object>} Server health payload.
     */
    async health() {
        const res = await this._request('GET', '/health');
        return res.json();
    }
}

export { EventStoreHttpClient };
export default EventStoreHttpClient;
