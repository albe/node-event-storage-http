import { HttpError } from './errors.js';
import { writeNdjson } from './ndjson.js';

const jsonContentType = 'application/json; charset=utf-8';

/**
 * @param {number} from Lower requested revision.
 * @param {number} until Upper requested revision.
 * @param {number} version Currently visible version.
 * @returns {boolean} True when polling is required.
 */
function shouldLongPoll(from, until, version) {
    return until > version || from > version;
}

/**
 * @param {boolean} isForward `true` for forward reads, `false` for backward reads.
 * @param {number} from Current lower cursor.
 * @param {number} until Requested upper boundary.
 * @param {number} availableVersion Highest currently visible version.
 * @returns {{from: number, until: number}|null} Batch range or null when nothing is visible yet.
 */
function buildBatchRange(isForward, from, until, availableVersion) {
    if (isForward) {
        if (from > availableVersion || from > until) {
            return null;
        }
        const batchUntil = Math.min(until, availableVersion);
        return { from, until: batchUntil };
    }

    if (from > availableVersion) {
        return null;
    }
    return { from, until };
}

/**
 * @param {unknown} value Candidate version.
 * @returns {boolean} True when value is a positive integer version.
 */
function isValidAvailableVersion(value) {
    return Number.isInteger(value) && value >= 1;
}

/**
 * @param {import('event-storage').EventStream} stream Event stream instance.
 * @param {{from: number, until: number}} batch Candidate batch range.
 * @param {boolean} isForward Whether the read direction is forward.
 * @returns {boolean} True when the stream range indicates visible events for this batch.
 */
function hasVisibleBatch(stream, batch, isForward) {
    if (isForward) {
        return stream.version >= batch.from && stream.minRevision === batch.from;
    }
    return stream.version >= batch.from && stream.maxRevision === batch.until;
}

/**
 * Unified long-polling for stream/join/category routes.
 * Emits available events immediately and only waits while the next event in-range is missing.
 *
 * @param {import('express').Response} response Express response.
 * @param {{
 *   from: number,
 *   until: number,
 *   currentVersion: number,
 *   headers?: Record<string, string>,
 *   timeoutMs?: number,
 *   eventSource: import('event-storage').Storage,
 *   getAvailableVersionOnIndexAdd: (indexName: string, indexLength: number, document: object|undefined) => number|undefined,
 *   createStream: (from: number, until: number) => import('event-storage').EventStream|false
 * }} options Polling options object.
 * @returns {Promise<boolean>} Resolves true when polling flow handled the response, false when polling is not needed.
 */
async function streamUntilVersion(response, {
    from,
    until,
    currentVersion,
    headers = {},
    timeoutMs = 10_000,
    eventSource,
    getAvailableVersionOnIndexAdd,
    createStream
}) {
    if (!shouldLongPoll(from, until, currentVersion)) {
        return false;
    }

    const isForward = from <= until;
    const targetVersion = Math.max(from, until);
    let nextFrom = from;

    /**
     * @param {number|undefined} [statusCode=undefined] Optional forced status code.
     * @returns {void}
     */
    const finalizeResponse = (statusCode = undefined) => {
        const effectiveStatusCode = statusCode !== undefined
            ? statusCode
            : (!response.headersSent ? 408 : undefined);

        if (effectiveStatusCode !== undefined) {
            response.status(effectiveStatusCode);
            response.set({ 'content-type': jsonContentType });
            response.end(JSON.stringify({
                error: `Stream did not reach version ${targetVersion} within ${timeoutMs}ms.`
            }));
            return;
        }
        response.end();
    };

    /**
     * @param {number} availableVersion Highest visible version for this polling step.
     * @returns {Promise<boolean>} True when polling for this request is complete.
     */
    const streamBatch = async (availableVersion) => {
        const batch = buildBatchRange(isForward, nextFrom, until, availableVersion);
        if (!batch) {
            return isForward ? nextFrom > until : false;
        }

        const stream = createStream(batch.from, batch.until);
        if (stream === false) {
            throw new HttpError(404, 'Stream does not exist.');
        }

        if (!hasVisibleBatch(stream, batch, isForward)) {
            return false;
        }

        await writeNdjson(response, stream, headers, { end: false });

        if (isForward) {
            nextFrom = batch.until + 1;
            return nextFrom > until;
        }

        // Backwards reads flush in one batch once the upper boundary becomes visible.
        return true;
    };

    const initialComplete = await streamBatch(currentVersion);

    if (initialComplete) {
        finalizeResponse();
        return true;
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let writeQueue = Promise.resolve();

        /** @returns {void} */
        const finalize = () => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            response.removeListener('close', finalize);
            eventSource.removeListener('index-add', onIndexAdd);

            finalizeResponse();
            resolve(true);
        };

        /**
         * @param {string} indexName Index name that was updated.
         * @param {number} indexLength New index length for that index.
         * @param {object|undefined} document Stored document associated with the index update.
         * @returns {void}
         */
        const onIndexAdd = (indexName, indexLength, document) => {
            if (settled) {
                return;
            }

            const availableVersion = getAvailableVersionOnIndexAdd(indexName, indexLength, document);
            if (!isValidAvailableVersion(availableVersion)) {
                return;
            }

            writeQueue = writeQueue
                .then(async () => {
                    const complete = await streamBatch(availableVersion);
                    if (complete) {
                        finalize();
                    }
                })
                .catch(reject);
        };

        const timer = setTimeout(finalize, timeoutMs);

        response.once('close', finalize);
        eventSource.on('index-add', onIndexAdd);
    });
}

export { shouldLongPoll, streamUntilVersion };
