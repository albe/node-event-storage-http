import { CommitCondition, ExpectedVersion } from 'event-storage';
import { HttpError } from './errors.js';

const readOptionNames = new Set(['from', 'until', 'forwards', 'backwards']);
const streamNameSeparators = ['/', ':', '@', '~', '+', '=', '-', '#', '.'];
const streamNamePattern = /^[A-Za-z0-9][A-Za-z0-9_]*(?:[\/:@~+=\-#.][A-Za-z0-9][A-Za-z0-9_]*)*$/;
const consumerIdentifierPattern = /^[A-Za-z0-9_-]+$/;

function createMatcherCache(maxEntries = 100) {
    const maxSize = Number.isInteger(maxEntries) ? Math.max(0, maxEntries) : 100;
    const entries = new Map();

    return {
        get(raw) {
            if (maxSize === 0 || !entries.has(raw)) {
                return undefined;
            }
            const matcher = entries.get(raw);
            entries.delete(raw);
            entries.set(raw, matcher);
            return matcher;
        },
        set(raw, matcher) {
            if (maxSize === 0) {
                return matcher;
            }
            if (entries.has(raw)) {
                entries.delete(raw);
            } else if (entries.size >= maxSize) {
                const oldestKey = entries.keys().next().value;
                entries.delete(oldestKey);
            }
            entries.set(raw, matcher);
            return matcher;
        },
        get size() {
            return entries.size;
        }
    };
}

/**
 * @param {string} raw Raw JSON text (must not be null/undefined).
 * @param {string} what Logical source label used in error text.
 * @returns {any} Parsed JSON value.
 */
function parseJson(raw, what) {
    try {
        return JSON.parse(raw);
    } catch {
        throw new HttpError(400, `Invalid ${what}.`);
    }
}

/**
 * @param {object|string|undefined} value Matcher candidate value.
 * @param {string} source Source label used in error messages.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {object|null} Parsed matcher object, or null when value is empty.
 */
function parseMatcher(value, source, matcherCache = undefined) {
    if (value === undefined || value === null || value === '') {
        return null;
    }
    if (typeof value === 'string') {
        const cachedMatcher = matcherCache?.get(value);
        if (cachedMatcher) {
            return cachedMatcher;
        }
        const parsedMatcher = parseJson(value, source);
        if (!parsedMatcher || typeof parsedMatcher !== 'object' || Array.isArray(parsedMatcher)) {
            throw new HttpError(400, `${source} must be a JSON object.`);
        }
        return matcherCache?.set(value, parsedMatcher) ?? parsedMatcher;
    }
    const matcher = value;
    if (!matcher || typeof matcher !== 'object' || Array.isArray(matcher)) {
        throw new HttpError(400, `${source} must be a JSON object.`);
    }
    return matcher;
}

/**
 * @param {string|string[]|unknown[]|unknown} selector Candidate selector algebra value.
 * @param {string} source Source label used in error messages.
 * @param {boolean} [allowAll=true] Allow the reserved `_all` stream name.
 * @returns {string|string[]} Parsed selector.
 */
function parseSelector(selector, source, allowAll = true) {
    if (typeof selector === 'string') {
        return parseStreamName(selector, source, allowAll);
    }
    if (!Array.isArray(selector) || selector.length === 0) {
        throw new HttpError(400, `${source} must be a non-empty selector array or stream name.`);
    }
    return selector.map((item, index) => parseSelector(item, `${source}[${index}]`, allowAll));
}

/**
 * @param {string|string[]|unknown[]|unknown} selector Selector to inspect.
 * @returns {string[]} All selector stream-name leaves.
 */
function collectSelectorLeaves(selector) {
    if (typeof selector === 'string') {
        return [selector];
    }
    if (!Array.isArray(selector)) {
        return [];
    }
    return selector.flatMap(item => collectSelectorLeaves(item));
}

/**
 * @param {number|string|undefined|null} value Expected version value.
 * @returns {number} Parsed expected version constant/number.
 */
function parseExpectedVersion(value) {
    if (value === undefined || value === null) {
        return ExpectedVersion.Any;
    }
    if (typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'any') {
            return ExpectedVersion.Any;
        }
        if (normalized === 'emptystream' || normalized === 'empty') {
            return ExpectedVersion.EmptyStream;
        }
        if (/^-?\d+$/.test(normalized)) {
            return Number(normalized);
        }
    }
    throw new HttpError(400, 'expectedVersion must be a number, "any", or "empty".');
}

/**
 * @param {object|string|undefined} value Condition object or JSON string.
 * @param {{ get(raw: string): object|undefined, set(raw: string, matcher: object): object }|undefined} [matcherCache] Optional matcher cache.
 * @returns {CommitCondition|null} Parsed commit condition or null when omitted.
 */
function parseCondition(value, matcherCache = undefined) {
    if (value === undefined || value === null) {
        return null;
    }
    const condition = typeof value === 'string' ? parseJson(value, 'condition') : value;
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) {
        throw new HttpError(400, 'condition must be a JSON object.');
    }
    if (!Number.isInteger(condition.noneMatchAfter) || condition.noneMatchAfter < 0) {
        throw new HttpError(400, 'condition.noneMatchAfter must be a non-negative integer.');
    }
    const selectorCandidate = condition.selector ?? condition.types;
    if (selectorCandidate === undefined) {
        throw new HttpError(400, 'condition.selector (or condition.types) is required.');
    }
    const selector = parseSelector(selectorCandidate, condition.selector !== undefined ? 'condition.selector' : 'condition.types', true);
    const matcher = parseMatcher(condition.matcher, 'condition.matcher', matcherCache);
    return new CommitCondition(
        selector,
        matcher,
        condition.noneMatchAfter
    );
}

/**
 * @param {CommitCondition} condition Commit condition instance.
 * @param {object|undefined} [matcher=undefined] Optional matcher to include.
 * @returns {string} JSON string representation.
 */
function serializeCondition(condition, matcher = null) {
    const selector = condition.selector ?? condition.types;
    const types = selector === undefined ? [] : collectSelectorLeaves(selector);
    return JSON.stringify({
        ...(selector !== undefined ? { selector } : {}),
        ...(types.length > 0 ? { types } : {}),
        noneMatchAfter: condition.noneMatchAfter,
        ...(matcher ? { matcher } : {})
    });
}

/**
 * @param {string|undefined} value Revision token.
 * @param {string} name Parameter label.
 * @returns {number|'start'|'end'|undefined} Parsed revision.
 */
function parseRevision(value, name) {
    if (value === undefined) {
        return undefined;
    }
    if (value === 'start') {
        return 'start';
    }
    if (value === 'end') {
        return 'end';
    }
    if (/^-?\d+$/.test(value)) {
        const parsed = Number(value);
        if (parsed === 0) {
            throw new HttpError(400, `${name} must not be 0.`);
        }
        return parsed;
    }
    throw new HttpError(400, `${name} must be an integer, "start", or "end".`);
}

/**
 * @param {string|number} value Candidate number.
 * @param {string} name Parameter label.
 * @returns {number} Positive integer value.
 */
function parsePositiveInteger(value, name) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new HttpError(400, `${name} must be a positive integer.`);
    }
    return parsed;
}

/**
 * @param {string|undefined} value Stream name.
 * @param {string} [source='stream'] Source label.
 * @param {boolean} [allowAll=false] Allow the reserved `_all` stream name.
 * @returns {string} Validated stream name.
 */
function parseStreamName(value, source = 'stream', allowAll = false) {
    if (typeof value !== 'string' || value === '') {
        throw new HttpError(400, `${source} must not be empty.`);
    }
    if (allowAll && value === '_all') {
        return value;
    }
    if (!streamNamePattern.test(value)) {
        throw new HttpError(400, `${source} must use segments that start with a letter or number and may contain letters, numbers, "_", and separators: / : @ ~ + = - # .`);
    }
    return value;
}

/**
 * @param {string|undefined} value Consumer identifier.
 * @param {string} [source='identifier'] Source label.
 * @returns {string} Validated identifier.
 */
function parseConsumerIdentifier(value, source = 'identifier') {
    if (typeof value !== 'string' || value === '') {
        throw new HttpError(400, `${source} must not be empty.`);
    }
    if (!consumerIdentifierPattern.test(value)) {
        throw new HttpError(400, `${source} may only contain letters, numbers, "-" and "_".`);
    }
    return value;
}

/**
 * @param {string[]} segments URL path segments.
 * @param {number|undefined} [startIndex=0] Segment offset.
 * @returns {{from?: number|'start'|'end'|undefined, until?: number|'start'|'end'|undefined, direction?: 'forwards'|'backwards'|undefined, amount?: number|undefined}} Parsed range options.
 */
function parseSegmentOptions(segments, startIndex = 0) {
    const options = {};
    for (let index = startIndex; index < segments.length; index += 2) {
        const name = segments[index];
        const value = segments[index + 1];
        if (value === undefined) {
            throw new HttpError(404, 'Unknown route.');
        }
        switch (name) {
        case 'from':
            options.from = parseRevision(value, 'from');
            break;
        case 'until':
            options.until = parseRevision(value, 'until');
            break;
        case 'forwards':
            if (options.direction) {
                throw new HttpError(400, 'Specify either forwards or backwards, not both.');
            }
            options.direction = 'forwards';
            options.amount = parsePositiveInteger(value, 'forwards');
            break;
        case 'backwards':
            if (options.direction) {
                throw new HttpError(400, 'Specify either forwards or backwards, not both.');
            }
            options.direction = 'backwards';
            options.amount = parsePositiveInteger(value, 'backwards');
            break;
        default:
            throw new HttpError(404, 'Unknown route.');
        }
    }
    return options;
}

/**
 * @param {number|'start'|'end'|undefined} boundary Boundary token.
 * @param {number} fallback Default numeric fallback.
 * @param {number} length Stream length.
 * @returns {number} Resolved numeric boundary.
 */
function resolveBoundary(boundary, fallback, length) {
    if (boundary === undefined) {
        return fallback;
    }
    if (boundary === 'start') {
        return 1;
    }
    if (boundary === 'end') {
        return length;
    }
    return boundary;
}

/**
 * @param {number} length Stream/global length.
 * @param {{from?: number|'start'|'end'|undefined, until?: number|'start'|'end'|undefined, direction?: 'forwards'|'backwards'|undefined, amount?: number|undefined}|undefined} [options={}] Parsed range options.
 * @returns {{from: number, until: number}} Inclusive read window.
 */
function buildReadWindow(length, options = {}) {
    const lower = resolveBoundary(options.from, 1, length);
    const upper = resolveBoundary(options.until, length, length);
    if (!Number.isInteger(lower) || !Number.isInteger(upper)) {
        throw new HttpError(400, 'Invalid stream boundaries.');
    }

    const direction = options.direction || 'forwards';
    if (direction === 'forwards') {
        const from = lower;
        const until = options.amount ? Math.min(upper, from + options.amount - 1) : upper;
        return { from, until };
    }

    const from = upper;
    const until = options.amount ? Math.max(lower, upper - options.amount + 1) : lower;
    return { from, until };
}

/**
 * @param {string|undefined} [rawPath=''] Raw relative path tail.
 * @returns {string[]} Decoded path segments.
 */
function splitPathSegments(rawPath = '') {
    return rawPath
        .split('/')
        .filter(Boolean)
        .map(segment => decodeURIComponent(segment));
}

/**
 * @param {string|undefined} [rawPath=''] Raw option path.
 * @returns {{from?: number|'start'|'end'|undefined, until?: number|'start'|'end'|undefined, direction?: 'forwards'|'backwards'|undefined, amount?: number|undefined}} Parsed options.
 */
function parseReadOptions(rawPath = '') {
    return parseSegmentOptions(splitPathSegments(rawPath));
}

/**
 * @param {string|undefined} rawPath Stream path including optional range suffix.
 * @param {boolean} [allowAll=false] Allow the reserved `_all` stream name.
 * @returns {{resourceName: string, options: {from?: number|'start'|'end'|undefined, until?: number|'start'|'end'|undefined, direction?: 'forwards'|'backwards'|undefined, amount?: number|undefined}}}
 */
function splitReadStreamPath(rawPath, allowAll = false) {
    const segments = splitPathSegments(rawPath);
    let optionStart = segments.length;
    while (optionStart >= 2 && readOptionNames.has(segments[optionStart - 2])) {
        optionStart -= 2;
    }
    const resourceName = segments.slice(0, optionStart).join('/');
    if (!resourceName) {
        throw new HttpError(404, 'Unknown route.');
    }
    return {
        resourceName: parseStreamName(resourceName, 'stream', allowAll),
        options: parseSegmentOptions(segments.slice(optionStart))
    };
}

/**
 * @param {string|undefined} rawPath Consumer stream path with optional `/from/:n`.
 * @returns {{resourceName: string, from: number}} Parsed target stream and starting revision.
 */
function splitConsumerStreamPath(rawPath) {
    const segments = splitPathSegments(rawPath);
    let from = 0;
    if (segments.length >= 2 && segments[segments.length - 2] === 'from') {
        from = parsePositiveInteger(segments[segments.length - 1], 'from');
        segments.splice(-2, 2);
    }
    const resourceName = parseStreamName(segments.join('/'));
    if (!resourceName) {
        throw new HttpError(404, 'Unknown route.');
    }
    return { resourceName, from };
}

/**
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @param {string} streamName Target stream name.
 * @param {object[]|object} events Events to commit.
 * @param {number|CommitCondition} expectedVersion Expected version / condition.
 * @param {object|undefined} metadata Commit metadata.
 * @returns {Promise<object>} Commit object.
 */
function commitAsync(eventStore, streamName, events, expectedVersion, metadata) {
    return new Promise((resolve, reject) => {
        try {
            eventStore.commit(streamName, events, expectedVersion, metadata, resolve);
        } catch (error) {
            reject(error);
        }
    });
}

/**
 * @param {import('event-storage').EventStore} eventStore EventStore instance.
 * @returns {Promise<Array<{name: string, stream: string, identifier: string}>>} Parsed consumer entries.
 */
function scanConsumersAsync(eventStore) {
    return new Promise((resolve, reject) => {
        eventStore.scanConsumers((error, consumers) => error ? reject(error) : resolve(consumers));
    });
}

/**
 * @param {string|string[]|number|undefined} value Query value or value array.
 * @returns {string[]} Normalized string list.
 */
function getQueryValues(value) {
    if (Array.isArray(value)) {
        return value.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
    }
    if (value === undefined) {
        return [];
    }
    return String(value).split(',').map(item => item.trim()).filter(Boolean);
}

/**
 * @param {Promise<void>} promise Readiness promise.
 * @param {import('express').Request} request Express request.
 * @param {import('express').Response} response Express response.
 * @param {import('express').NextFunction} next Express next callback.
 * @returns {Promise<void>}
 */
async function waitForReadyMiddleware(promise, request, response, next) {
    try {
        await promise;
        next();
    } catch (error) {
        next(error);
    }
}

/**
 * @param {string} stream Stream name (`_all` allowed).
 * @param {string} identifier Consumer identifier.
 * @returns {string} Persisted consumer name.
 */
function buildConsumerName(stream, identifier) {
    return stream === '_all'
        ? `_all.${identifier}`
        : `stream-${stream}.${identifier}`;
}

export {
    buildReadWindow,
    buildConsumerName,
    commitAsync,
    collectSelectorLeaves,
    createMatcherCache,
    getQueryValues,
    parseCondition,
    parseExpectedVersion,
    parseMatcher,
    parseJson,
    parsePositiveInteger,
    parseReadOptions,
    parseConsumerIdentifier,
    parseRevision,
    parseSelector,
    parseSegmentOptions,
    parseStreamName,
    resolveBoundary,
    scanConsumersAsync,
    serializeCondition,
    splitConsumerStreamPath,
    splitReadStreamPath,
    waitForReadyMiddleware
};
