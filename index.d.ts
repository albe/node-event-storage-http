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

