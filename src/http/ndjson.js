const ndjsonContentType = 'application/x-ndjson; charset=utf-8';

/**
 * Write a stream as NDJSON.
 *
 * @param {import('express').Response} response Express response.
 * @param {import('event-storage').EventStream} eventStream Event stream.
 * @param {Record<string, string>} [headers={}] Additional headers.
 * @param {{end?: boolean|undefined}} [options={}] Optional behavior; `end` defaults to true.
 * @returns {Promise<boolean>} Resolves to `true` when at least one event was emitted, otherwise `false`.
 */
async function writeNdjson(response, eventStream, headers = {}, options = {}) {
    const { end = true } = options;
    if (!response.headersSent) {
        response.status(200);
        response.set({
            'content-type': ndjsonContentType,
            ...headers
        });
    }

    if (eventStream.raw) {
        return new Promise((resolve, reject) => {
            eventStream.once('end', resolve);
            eventStream.once('error', reject);
            eventStream.pipe(response, { end });
        });
    }

    /** @returns {void} */
    const pump = () => {
        let next;
        while ((next = eventStream.next()) !== false) {
            if (!response.write(JSON.stringify(next) + '\n')) {
                response.once('drain', pump);
                return;
            }
        }
        if (end) {
            response.end();
        }
    };

    pump();
}

export { writeNdjson };
