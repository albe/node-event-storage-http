function matchesDocument(document, matcher) {
    if (typeof document === 'undefined') {
        return false;
    }
    if (typeof matcher === 'undefined') {
        return true;
    }
    if (typeof matcher === 'function') {
        return matcher(document);
    }

    for (const propertyName of Object.getOwnPropertyNames(matcher)) {
        const expectedValue = matcher[propertyName];
        const actualValue = document[propertyName];

        if (Array.isArray(expectedValue)) {
            if (!expectedValue.includes(actualValue)) {
                return false;
            }
            continue;
        }

        if (expectedValue && typeof expectedValue === 'object') {
            if (!matchesDocument(actualValue, expectedValue)) {
                return false;
            }
            continue;
        }

        if (typeof expectedValue !== 'undefined' && actualValue !== expectedValue) {
            return false;
        }
    }

    return true;
}

export { matchesDocument };

