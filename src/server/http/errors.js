import { OptimisticConcurrencyError } from 'event-storage';

const jsonContentType = 'application/json; charset=utf-8';

class HttpError extends Error {
    /**
     * @param {number} status HTTP status code.
     * @param {string} message Error message.
     * @param {object|undefined} [details=undefined] Optional structured details.
     */
    constructor(status, message, details = undefined) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

/**
 * @param {Error&{status?: number|undefined}} error Error instance or compatible object.
 * @returns {number} Resolved HTTP status code.
 */
function mapErrorStatus(error) {
    if (error instanceof HttpError) {
        return error.status;
    }
    if (typeof error.status === 'number') {
        return error.status;
    }
    if (error instanceof OptimisticConcurrencyError) {
        return 409;
    }
    if (/does not exist|No streams for category/.test(error.message)) {
        return 404;
    }
    if (/already exists|already closed|Can not recreate stream|read-only mode|Optimistic concurrency error/.test(error.message)) {
        return 409;
    }
    if (/Must specify|Must provide|Invalid|No events specified|Specify either/.test(error.message)) {
        return 400;
    }
    return 500;
}

/**
 * @param {import('express').Response} response Express response.
 * @param {number} status HTTP status code.
 * @param {object} payload JSON payload object.
 * @param {Record<string, string>|undefined} [headers={}] Optional extra headers.
 * @returns {void}
 */
function sendJson(response, status, payload, headers = {}) {
    response.status(status);
    response.set({
        'content-type': jsonContentType,
        ...headers
    });
    response.send(JSON.stringify(payload));
}

/**
 * @param {Error&{details?: object|undefined}} error Error to serialize.
 * @param {import('express').Request} request Express request.
 * @param {import('express').Response} response Express response.
 * @param {import('express').NextFunction} next Express next callback.
 * @returns {void}
 */
function sendError(error, request, response, next) {
    if (response.headersSent) {
        next(error);
        return;
    }

    const status = mapErrorStatus(error);
    sendJson(response, status, {
        error: error.message,
        ...(error.details ? { details: error.details } : {})
    });
}

export { HttpError, sendJson, sendError };
