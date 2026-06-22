/**
 * Type definitions for `event-storage-http` (default `.` / server entry point).
 *
 * Re-exports the protocol and client layers for backwards compatibility, and
 * adds the Express-based server surface.
 */
import type { Server } from 'node:http';
import type { EventStore } from 'event-storage';
import type { Express } from 'express';

export * from '../protocol/index.js';
export * from '../client/index.js';

export interface EventStoreHttpApiOptions {
    autoStartConsumers?: boolean;
    consumerPollTimeoutMs?: number;
    streamPollTimeoutMs?: number;
}

export class EventStoreHttpApi {
    constructor(eventStore: EventStore, options?: EventStoreHttpApiOptions);
    constructor(eventStore: EventStore, app: Express, options?: EventStoreHttpApiOptions);

    eventStore: EventStore;
    options: EventStoreHttpApiOptions;
    app: Express | null;
    server: Server | null;
    ready: Promise<void>;

    createApp(): Express;
    attach(app: Express): this;
    createServer(): Server;
    listen(...args: any[]): Server;
    close(callback?: (error?: Error) => void): Server | undefined;
}

export function createEventStoreHttpServer(eventStore: EventStore, options?: EventStoreHttpApiOptions): Server;

export function createEventStoreHttpServerWithApp(eventStore: EventStore, app: Express, options?: EventStoreHttpApiOptions): Express;

export class StorageStatsCollector {
    constructor(storage: unknown);
    stats(): {
        numPartitions: number;
        partitions: Record<string, { id: number; size: number; headerSize: number; metadata: object }>;
        numIndexes: number;
        indexes: Record<string, { size: number; headerSize: number; metadata: object }>;
        bytesWritten: number;
    };
}

export default EventStoreHttpApi;
