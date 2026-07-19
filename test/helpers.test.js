import test from 'node:test';
import assert from 'node:assert/strict';
import { CommitConditionHelper, MatcherBuilder } from '../src/protocol/index.js';

test('MatcherBuilder builds nested object matchers with operators', () => {
    const matcher = new MatcherBuilder()
        .path('foo.bar').equals('baz')
        .path('foo.quux').greaterThan(24)
        .build();

    assert.deepEqual(matcher, {
        foo: {
            bar: 'baz',
            quux: { $gt: 24 }
        }
    });
});

test('MatcherBuilder supports anyOf(...args) as array matcher value', () => {
    const matcher = new MatcherBuilder()
        .path('foo.type').isAnyOf('OrderPlaced', 'OrderConfirmed', 'OrderShipped')
        .build();

    assert.deepEqual(matcher, {
        foo: {
            type: ['OrderPlaced', 'OrderConfirmed', 'OrderShipped']
        }
    });
});

test('CommitConditionHelper builds and round-trips header values', () => {
    const matcher = new MatcherBuilder()
        .path('payload.type').equals('OrderPlaced')
        .build();

    const condition = new CommitConditionHelper()
        .types(['OrderPlaced'])
        .noneMatchAfter(42)
        .matching(matcher)
        .build();

    const headerValue = CommitConditionHelper.toHeaderValue(condition);
    const parsed = CommitConditionHelper.parseHeaderValue(headerValue);

    assert.deepEqual(parsed, condition);
});

test('CommitConditionHelper parses conditions from headers-like objects', () => {
    const condition = CommitConditionHelper.create(['OrderPlaced'], 7, {
        payload: { orderId: '1' }
    });

    const headers = {
        get(name) {
            if (name === CommitConditionHelper.headerName) {
                return CommitConditionHelper.toHeaderValue(condition);
            }
            return null;
        }
    };

    assert.deepEqual(CommitConditionHelper.fromHeaders(headers), condition);
    assert.equal(CommitConditionHelper.fromHeaders({ get: () => null }), null);
});

test('CommitConditionHelper matcher(...) alias behaves like matching(...)', () => {
    const matcher = new MatcherBuilder()
        .path('payload.type').isAnyOf('OrderPlaced', 'OrderConfirmed')
        .build();

    const condition = new CommitConditionHelper()
        .types(['OrderPlaced'])
        .noneMatchAfter(12)
        .matcher(matcher)
        .build();

    assert.deepEqual(condition.matcher, matcher);
});

test('CommitConditionHelper selector(...) supports nested selector algebra', () => {
    const condition = new CommitConditionHelper()
        .selector([['tags/featured', ['OrderPlaced', 'OrderConfirmed']]])
        .noneMatchAfter(12)
        .build();

    assert.deepEqual(condition.selector, [['tags/featured', ['OrderPlaced', 'OrderConfirmed']]]);
});
