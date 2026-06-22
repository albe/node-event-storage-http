import { CommitConditionHelper } from '../protocol/CommitConditionHelper.js';
import { NdjsonDecoder } from '../protocol/ndjson.js';

/**
 * Client-side wrapper around an HTTP NDJSON response body.
 *
 * Parses the response as a newline-delimited stream of JSON objects so callers
 * can iterate over events without buffering the full body.  Exposes the
 * `x-event-store-query-condition` response header (if present) as
 * `commitCondition`, making it easy to pass the condition back to a subsequent
 * `commit()` call for DCB-style optimistic concurrency.
 *
 * @example
 * const response = await fetch('/query?types=OrderPlaced');
 * const stream = new HttpEventStream(response);
 * for await (const event of stream) {
 *     console.log(event);
 * }
 * // Reuse the condition for a conditional commit:
 * await fetch('/streams/orders/commit', {
 *     method: 'POST',
 *     headers: { 'x-event-store-condition': JSON.stringify(stream.commitCondition) },
 *     body: JSON.stringify({ events: [...] })
 * });
 */
class HttpEventStream {
    /**
     * @param {Response} response A Fetch API Response whose body is NDJSON. Must not be null/undefined.
     */
    constructor(response) {
        this.commitCondition = null;
        try {
            this.commitCondition = CommitConditionHelper.fromHeaders(response.headers);
        } catch {
            // ignore a malformed header
        }
        this.body = response.body;
    }

    /**
     * Iterate over the NDJSON response body, yielding one deserialized object
     * per line.
     *
     * @yields {object}
     * @returns {AsyncGenerator<object, void, undefined>}
     */
    async *[Symbol.asyncIterator]() {
        const reader = this.body.getReader();
        const decoder = new NdjsonDecoder();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    yield* this.#decodeOrThrow(() => decoder.flush());
                    return;
                }
                yield* this.#decodeOrThrow(() => decoder.push(value));
            }
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Run a decoder step, normalizing JSON parse failures into a descriptive
     * SyntaxError consistent with this class's historical error message.
     *
     * @param {() => object[]} step Decoder push/flush invocation.
     * @returns {object[]} Parsed objects.
     */
    #decodeOrThrow(step) {
        try {
            return step();
        } catch (error) {
            throw new SyntaxError(`HttpEventStream: malformed NDJSON: ${error.message}`);
        }
    }

    /**
     * Collect all events into an array.
     *
     * @returns {Promise<object[]>} Array of parsed events (never null/undefined).
     */
    async toArray() {
        const events = [];
        for await (const event of this) {
            events.push(event);
        }
        return events;
    }
}

export default HttpEventStream;
