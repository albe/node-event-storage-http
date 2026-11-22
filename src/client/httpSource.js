import { eventPosition } from '../protocol/positions.js';

/**
 * @param {string} path Dot-notation path, e.g. `'type'` or `'meta.tags'`.
 * @returns {(object: object) => any} Reads the path from an object.
 */
function compileAccessor(path) {
    const segments = path.split('.');
    return object => segments.reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

/**
 * @param {number} ms Milliseconds to wait.
 * @param {AbortSignal|undefined} signal Ends the wait early.
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done);
    });
}

/**
 * An event source over the HTTP API, for the decision models and read models of `event-storage/projections`.
 *
 * Events are read through `GET /query`. Their type and tags are read with the `typeAccessor` and `tagsAccessor` of
 * the store, which the server reports in `GET /health` unless they are passed here. `follow()` polls for new events
 * every `pollIntervalMs` while nothing new arrives.
 *
 * Committing stays with the client: pass `model.commitCondition` as `client.commit(stream, events, { condition })`.
 *
 * @param {import('./EventStoreHttpClient.js').default} client
 * @param {{ typeAccessor?: string, tagsAccessor?: string|null, pollIntervalMs?: number }} [options={}]
 * @returns {object} An event source with `query()`, `read()` and `follow()`.
 */
function httpSource(client, { typeAccessor, tagsAccessor, pollIntervalMs = 1000 } = {}) {
    let accessors = null;

    const loadAccessors = async (signal) => {
        if (accessors) {
            return accessors;
        }
        let type = typeAccessor;
        let tags = tagsAccessor;
        if (type === undefined || tags === undefined) {
            const reported = (await client.health({ signal })).store?.accessors ?? {};
            // null is an explicit opt-out, only fill in what was not passed.
            if (type === undefined) type = reported.type ?? null;
            if (tags === undefined) tags = reported.tags ?? null;
        }
        if (!type) {
            throw new Error('httpSource() needs the typeAccessor of the store. Configure it on the server or pass { typeAccessor }.');
        }
        const tagsOf = tags ? compileAccessor(tags) : () => [];
        accessors = { typeOf: compileAccessor(type), tagsOf };
        return accessors;
    };

    /**
     * @param {AsyncIterable<{ payload: object, metadata: object }>} documents
     * @param {number} from Skip events before this position.
     * @param {number} [until] Stop after this position.
     * @param {AbortSignal} [signal] Cancels the accessor discovery.
     */
    const envelopes = async function* (documents, from, until = Infinity, signal = undefined) {
        const { typeOf, tagsOf } = await loadAccessors(signal);
        for await (const { payload, metadata } of documents) {
            const position = eventPosition(metadata);
            if (position < from) continue;
            if (position > until) return;
            yield { event: payload, metadata, position, type: typeOf(payload), tags: tagsOf(payload) ?? [] };
        }
    };

    /**
     * @param {{ selector: any, matcher?: object|null }} selection
     * @param {{ from: number, signal?: AbortSignal }} options
     */
    const request = (selection, { from, signal }) => {
        if (typeof selection.matcher === 'function') {
            throw new TypeError('httpSource() can only send object matchers to the server, not functions.');
        }
        return client.readQuery({ selector: selection.selector }, { from, filter: selection.matcher ?? null, signal });
    };

    return Object.freeze({
        async query(query, { from = 1 } = {}) {
            await loadAccessors();
            const stream = await client.readQuery(query, { from });
            const condition = stream.commitCondition;
            if (!condition) {
                throw new Error('The server did not return a commit condition for the query.');
            }
            return { events: envelopes(stream, from, condition.noneMatchAfter), condition };
        },

        async *read(selection, { from = 1, signal } = {}) {
            await loadAccessors(signal);
            yield* envelopes(await request(selection, { from, signal }), from, Infinity, signal);
        },

        async *follow(selection, { from = 1, signal } = {}) {
            let next = from;
            while (!signal?.aborted) {
                let received = false;
                try {
                    await loadAccessors(signal);
                    const stream = await request(selection, { from: next, signal });
                    for await (const envelope of envelopes(stream, next, Infinity, signal)) {
                        next = envelope.position + 1;
                        received = true;
                        yield envelope;
                    }
                    // Skip the events up to the end of the store at the time of the request, they did not match.
                    if (stream.commitCondition) {
                        next = Math.max(next, stream.commitCondition.noneMatchAfter + 1);
                    }
                } catch (error) {
                    if (signal?.aborted) return;
                    throw error;
                }
                if (!received) {
                    await sleep(pollIntervalMs, signal);
                }
            }
        }
    });
}

export default httpSource;
export { httpSource };
