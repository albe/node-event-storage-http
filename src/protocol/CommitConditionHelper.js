const CONDITION_HEADER = 'x-event-store-query-condition';

function assert(condition, message) {
    if (!condition) {
        throw new TypeError(message);
    }
}

function cloneValue(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function validateTypes(types) {
    assert(Array.isArray(types) && types.length > 0, 'types must be a non-empty array of strings.');
    assert(types.every(type => typeof type === 'string' && type !== ''), 'types must be a non-empty array of strings.');
}

function validateSelector(selector) {
    if (typeof selector === 'string') {
        assert(selector !== '', 'selector stream names must not be empty.');
        return;
    }
    assert(Array.isArray(selector) && selector.length > 0, 'selector must be a non-empty selector array or stream name.');
    for (const item of selector) {
        validateSelector(item);
    }
}

function collectSelectorLeaves(selector) {
    if (typeof selector === 'string') {
        return [selector];
    }
    if (!Array.isArray(selector)) {
        return [];
    }
    return selector.flatMap(item => collectSelectorLeaves(item));
}

function validateNoneMatchAfter(noneMatchAfter) {
    assert(Number.isInteger(noneMatchAfter) && noneMatchAfter >= 0, 'noneMatchAfter must be a non-negative integer.');
}

function validateMatcher(matcher) {
    if (matcher === undefined) {
        return;
    }
    assert(matcher && typeof matcher === 'object' && !Array.isArray(matcher), 'matcher must be a JSON object.');
}

function validateCommitCondition(condition) {
    assert(condition && typeof condition === 'object' && !Array.isArray(condition), 'condition must be a JSON object.');
    const selector = condition.selector ?? condition.types;
    if (condition.selector !== undefined) {
        validateSelector(condition.selector);
    } else {
        validateTypes(condition.types);
    }
    if (condition.types !== undefined) {
        validateTypes(condition.types);
    }
    assert(selector !== undefined, 'condition must include selector or types.');
    validateNoneMatchAfter(condition.noneMatchAfter);
    validateMatcher(condition.matcher);
}

function splitPath(path) {
    assert(typeof path === 'string' && path !== '', 'path must be a non-empty string.');
    const segments = path.split('.');
    assert(segments.every(segment => segment !== ''), 'path must not contain empty segments.');
    return segments;
}

function getOrCreatePath(target, segments) {
    let node = target;
    for (let i = 0; i < segments.length - 1; i++) {
        const key = segments[i];
        const current = node[key];
        if (current === undefined) {
            node[key] = {};
            node = node[key];
            continue;
        }
        assert(current && typeof current === 'object' && !Array.isArray(current), `path segment "${key}" conflicts with an existing scalar value.`);
        node = current;
    }
    return { node, key: segments[segments.length - 1] };
}

class MatcherBuilder {
    constructor() {
        this.matcher = {};
        this.currentSegments = null;
    }

    path(path) {
        this.currentSegments = splitPath(path);
        return this;
    }

    equals(value) {
        return this.setValue(value);
    }

    isAnyOf(...values) {
        assert(values.length > 0, 'isAnyOf(...) requires at least one value.');
        return this.setValue(values);
    }

    notEquals(value) {
        return this.setOperator('$ne', value);
    }

    greaterThan(value) {
        return this.setOperator('$gt', value);
    }

    greaterThanOrEqual(value) {
        return this.setOperator('$gte', value);
    }

    lessThan(value) {
        return this.setOperator('$lt', value);
    }

    lessThanOrEqual(value) {
        return this.setOperator('$lte', value);
    }

    setValue(value) {
        assert(this.currentSegments, 'call path(...) before adding matcher operations.');
        const { node, key } = getOrCreatePath(this.matcher, this.currentSegments);
        node[key] = cloneValue(value);
        return this;
    }

    setOperator(operator, value) {
        assert(this.currentSegments, 'call path(...) before adding matcher operations.');
        const { node, key } = getOrCreatePath(this.matcher, this.currentSegments);
        const current = node[key];
        if (current === undefined) {
            node[key] = { [operator]: value };
            return this;
        }
        assert(current && typeof current === 'object' && !Array.isArray(current), `path "${this.currentSegments.join('.')}" is already a scalar matcher.`);
        node[key][operator] = value;
        return this;
    }

    build() {
        return cloneValue(this.matcher);
    }
}

class CommitConditionHelper {
    constructor() {
        this.data = {
            selector: undefined,
            noneMatchAfter: 0,
            matcher: undefined
        };
    }

    types(types) {
        validateTypes(types);
        this.data.selector = [...types];
        return this;
    }

    selector(selector) {
        validateSelector(selector);
        this.data.selector = cloneValue(selector);
        return this;
    }

    noneMatchAfter(noneMatchAfter) {
        validateNoneMatchAfter(noneMatchAfter);
        this.data.noneMatchAfter = noneMatchAfter;
        return this;
    }

    matching(matcher) {
        validateMatcher(matcher);
        this.data.matcher = cloneValue(matcher);
        return this;
    }

    matcher(matcher) {
        return this.matching(matcher);
    }

    build() {
        const selector = cloneValue(this.data.selector);
        const types = selector !== undefined ? collectSelectorLeaves(selector) : undefined;
        const condition = {
            ...(selector !== undefined ? { selector } : {}),
            ...(types && types.length > 0 ? { types } : {}),
            noneMatchAfter: this.data.noneMatchAfter,
            ...(this.data.matcher !== undefined ? { matcher: cloneValue(this.data.matcher) } : {})
        };
        validateCommitCondition(condition);
        return condition;
    }

    static get headerName() {
        return CONDITION_HEADER;
    }

    static toHeaderValue(condition) {
        validateCommitCondition(condition);
        return JSON.stringify(condition);
    }

    static parseHeaderValue(headerValue) {
        assert(typeof headerValue === 'string' && headerValue !== '', 'headerValue must be a non-empty string.');
        let parsed;
        try {
            parsed = JSON.parse(headerValue);
        } catch {
            throw new TypeError('headerValue must contain valid JSON.');
        }
        validateCommitCondition(parsed);
        return parsed;
    }

    static fromHeaders(headers) {
        const headerValue = headers?.get?.(CONDITION_HEADER);
        if (!headerValue) {
            return null;
        }
        return CommitConditionHelper.parseHeaderValue(headerValue);
    }

    static toHeaders(condition) {
        return {
            [CONDITION_HEADER]: CommitConditionHelper.toHeaderValue(condition)
        };
    }

    static create(selectorOrTypes, noneMatchAfter, matcher = undefined) {
        const helper = new CommitConditionHelper()
            .matching(matcher)
            .noneMatchAfter(noneMatchAfter);
        if (Array.isArray(selectorOrTypes) && selectorOrTypes.every(item => typeof item === 'string' && item !== '')) {
            return helper.types(selectorOrTypes).build();
        }
        return helper.selector(selectorOrTypes).build();
    }
}

export { CommitConditionHelper, MatcherBuilder, CONDITION_HEADER };

