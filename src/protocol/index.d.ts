/**
 * Type definitions for `event-storage-http/protocol` — framework-free, server-free
 * building blocks. No dependency on `express` or the server layer.
 */

export type ObjectMatcher = Record<string, unknown>;

export interface SerializedCommitCondition {
    types: string[];
    noneMatchAfter: number;
    matcher?: Record<string, unknown>;
}

export const CONDITION_HEADER: 'x-event-store-query-condition';

export class MatcherBuilder {
    matcher: ObjectMatcher;
    path(path: string): this;
    equals(value: unknown): this;
    isAnyOf(...values: unknown[]): this;
    notEquals(value: unknown): this;
    greaterThan(value: number): this;
    greaterThanOrEqual(value: number): this;
    lessThan(value: number): this;
    lessThanOrEqual(value: number): this;
    build(): ObjectMatcher;
}

export class CommitConditionHelper {
    static readonly headerName: 'x-event-store-query-condition';

    types(types: string[]): this;
    noneMatchAfter(noneMatchAfter: number): this;
    matching(matcher: ObjectMatcher | undefined): this;
    matcher(matcher: ObjectMatcher | undefined): this;
    build(): SerializedCommitCondition;

    static create(types: string[], noneMatchAfter: number, matcher?: ObjectMatcher): SerializedCommitCondition;
    static toHeaderValue(condition: SerializedCommitCondition): string;
    static parseHeaderValue(headerValue: string): SerializedCommitCondition;
    static fromHeaders(headers: { get?(name: string): string | null } | undefined): SerializedCommitCondition | null;
    static toHeaders(condition: SerializedCommitCondition): Record<'x-event-store-query-condition', string>;
}

/** Compute the 1-based global position immediately after a persisted event. */
export function eventPosition(event: { commitId: number; commitVersion: number }): number;

/** Compute the 1-based global position after a commit's final event. */
export function commitPosition(commitResult: { commitId: number; events: ReadonlyArray<unknown> }): number;

/** Incremental decoder for newline-delimited JSON. */
export class NdjsonDecoder {
    buffer: string;
    push(chunk: Uint8Array | string): object[];
    flush(): object[];
}
