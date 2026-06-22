/**
 * Incremental decoder for newline-delimited JSON (NDJSON).
 *
 * Feed it chunks (`Uint8Array` or `string`) via {@link NdjsonDecoder#push} and
 * it returns the fully-formed JSON objects decoded so far, buffering any partial
 * trailing line until the next chunk completes it. Call {@link NdjsonDecoder#flush}
 * once the source is exhausted to emit a final unterminated line, if any.
 *
 * This is a pure protocol helper: it has no dependency on the server, on
 * `express`, or on any platform beyond the WHATWG `TextDecoder`.
 *
 * @example
 * const decoder = new NdjsonDecoder();
 * for await (const chunk of response.body) {
 *     for (const obj of decoder.push(chunk)) handle(obj);
 * }
 * for (const obj of decoder.flush()) handle(obj);
 */
class NdjsonDecoder {
    constructor() {
        /** @type {string} */
        this.buffer = '';
        // A single streaming TextDecoder so multi-byte characters split across
        // chunk boundaries are decoded correctly.
        this.textDecoder = new TextDecoder();
    }

    /**
     * Push a chunk and return any complete JSON objects it produced.
     *
     * @param {Uint8Array|string} chunk Bytes or text to append. Must not be null/undefined.
     * @returns {object[]} Parsed objects for every complete line in the chunk.
     */
    push(chunk) {
        const text = typeof chunk === 'string'
            ? chunk
            : this.textDecoder.decode(chunk, { stream: true });
        this.buffer += text;
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() ?? '';
        const objects = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                objects.push(JSON.parse(trimmed));
            }
        }
        return objects;
    }

    /**
     * Flush the buffered trailing line, if any. Returns an array (possibly
     * empty) so callers can treat it identically to {@link NdjsonDecoder#push}.
     *
     * @returns {object[]} A single-element array with the final object, or empty.
     */
    flush() {
        const tail = (this.buffer + this.textDecoder.decode()).trim();
        this.buffer = '';
        if (!tail) {
            return [];
        }
        return [JSON.parse(tail)];
    }
}

export { NdjsonDecoder };
