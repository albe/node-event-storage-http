import { CommitConditionHelper } from './CommitConditionHelper.js';

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
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    const tail = buffer.trim();
                    if (tail) {
                        try {
                            yield JSON.parse(tail);
                        } catch {
                            throw new SyntaxError(`HttpEventStream: malformed NDJSON: ${tail}`);
                        }
                    }
                    return;
                }
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed) {
                        try {
                            yield JSON.parse(trimmed);
                        } catch {
                            throw new SyntaxError(`HttpEventStream: malformed NDJSON: ${trimmed}`);
                        }
                    }
                }
            }
        } finally {
            reader.releaseLock();
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
