import { HttpError, sendJson } from '../../http/errors.js';
import { parseConsumerIdentifier, parsePositiveInteger } from '../../http/routeUtils.js';

/**
 * Register the long-poll consumer endpoint.
 *
 * Waits until the named consumer has processed at least `minVersion`, then
 * responds with the consumer's current position and state.  If the consumer does
 * not reach `minVersion` within `timeoutMs`, a 408 Request Timeout is returned.
 *
 * The consumer must be registered in the EventStore's `consumers` map (i.e. started via PUT).
 *
 * @param {import('express').Express} app Express app instance (must not be null/undefined).
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {number|undefined} [timeoutMs=10_000] Poll timeout in milliseconds.
 * @returns {void}
 */
function registerGetConsumerAfterRoute(app, eventStore, timeoutMs = 10_000) {
    /**
     * @param {import('express').Request} request Express request.
     * @param {import('express').Response} response Express response.
     * @returns {Promise<void>}
     */
    const handleGetConsumerAfter = async (request, response) => {
        const identifier = parseConsumerIdentifier(request.params.identifier);
        const minVersion = parsePositiveInteger(request.params.minVersion, 'minVersion');

        const consumer = eventStore.getConsumer(identifier);
        if (!consumer) {
            throw new HttpError(404, `Consumer "${identifier}" is not running. Start it via PUT before polling.`);
        }

        if (consumer.position >= minVersion) {
            return sendJson(response, 200, { identifier, stream: consumer.streamName, position: consumer.position, state: consumer.state });
        }

        await new Promise((resolve, reject) => {
            /** @returns {void} */
            const onTimeout = () => {
                cleanup();
                reject(new HttpError(408, `Consumer "${identifier}" did not reach version ${minVersion} within ${timeoutMs}ms.`));
            };
            const timer = setTimeout(onTimeout, timeoutMs);

            /**
             * @returns {void}
             */
            function cleanup() {
                clearTimeout(timer);
                consumer.removeListener('progress', onProgress);
                consumer.removeListener('error', onError);
            }

            /**
             * @param {number} position Current consumer position.
             * @returns {void}
             */
            function onProgress(position) {
                if (position < minVersion) {
                    return;
                }
                cleanup();
                resolve();
            }

            /**
             * @param {Error} err Consumer error.
             * @returns {void}
             */
            function onError(err) {
                cleanup();
                reject(new HttpError(500, `Consumer "${identifier}" encountered an error: ${err.message}`));
            }

            consumer.on('progress', onProgress);
            consumer.once('error', onError);
        });

        sendJson(response, 200, { identifier, stream: consumer.streamName, position: consumer.position, state: consumer.state });
    };

    app.get('/consumers/:identifier/after/:minVersion', handleGetConsumerAfter);
}

export default registerGetConsumerAfterRoute;
