import type { Server } from 'node:http';
import type { EventStore, CommitCondition } from 'event-storage';
import type { Express } from 'express';

export interface EventStoreHttpApiOptions {
    autoStartConsumers?: boolean;
    consumerPollTimeoutMs?: number;
    streamPollTimeoutMs?: number;
}

export interface SerializedCommitCondition {
    types: string[];
    noneMatchAfter: number;
    matcher?: Record<string, unknown>;
}

export type ObjectMatcher = Record<string, unknown>;

export interface NdjsonReader {
    read(): Promise<{ done: boolean; value?: Uint8Array }>;
    releaseLock(): void;
}

export interface NdjsonBody {
    getReader(): NdjsonReader;
}

export interface FetchResponseLike {
    headers?: { get?(name: string): string | null };
    body: NdjsonBody;
}

export class EventStoreHttpApi {
    constructor(eventStore: EventStore, options?: EventStoreHttpApiOptions);

    eventStore: EventStore;
    options: EventStoreHttpApiOptions;
    app: Express;
    server: Server | null;
    ready: Promise<void>;

    createApp(): Express;
    createServer(): Server;
    listen(...args: any[]): Server;
    close(callback?: (error?: Error) => void): Server | undefined;
}

export function createEventStoreHttpServer(eventStore: EventStore, options?: EventStoreHttpApiOptions): Server;

export default EventStoreHttpApi;

export class HttpEventStream implements AsyncIterable<Record<string, unknown>> {
    constructor(response: FetchResponseLike);

    commitCondition: SerializedCommitCondition | CommitCondition | null;
    body: NdjsonBody;

    [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, undefined>;
    toArray(): Promise<Record<string, unknown>[]>;
}

export class MatcherBuilder {
    path(path: string): this;
    equals(value: unknown): this;
    anyOf(...values: unknown[]): this;
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

