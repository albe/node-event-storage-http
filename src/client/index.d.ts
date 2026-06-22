/**
 * Type definitions for `event-storage-http/client` — browser/Node consumers of
 * the HTTP API. No dependency on `express` or the server layer.
 */
import type { CommitCondition } from 'event-storage';
import type { SerializedCommitCondition } from '../protocol/index.js';

export type {
    ObjectMatcher,
    SerializedCommitCondition
} from '../protocol/index.js';
export {
    MatcherBuilder,
    CommitConditionHelper,
    CONDITION_HEADER,
    NdjsonDecoder,
    eventPosition,
    commitPosition
} from '../protocol/index.js';

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

export class HttpEventStream implements AsyncIterable<Record<string, unknown>> {
    constructor(response: FetchResponseLike);

    commitCondition: SerializedCommitCondition | CommitCondition | null;
    body: NdjsonBody;

    [Symbol.asyncIterator](): AsyncGenerator<Record<string, unknown>, void, undefined>;
    toArray(): Promise<Record<string, unknown>[]>;
}

export interface EventStoreHttpClientOptions {
    baseUrl?: string;
    getToken?: () => string | Promise<string>;
    fetch?: typeof globalThis.fetch;
    pollTimeoutMs?: number;
}

export type FollowSourceKind = 'stream' | 'category' | 'join';

export interface FollowSource {
    kind: FollowSourceKind;
    name?: string;
    streams?: string[];
}

export interface ReadOptions {
    from?: number;
    until?: number;
    signal?: AbortSignal;
}

export interface FollowOptions {
    fromPosition?: number;
    windowSize?: number;
    signal?: AbortSignal;
}

export interface CommitOptions {
    condition?: object | null;
    metadata?: object | null;
    signal?: AbortSignal;
}

export interface FollowBatch {
    events: Record<string, unknown>[];
    position: number;
}

export class EventStoreHttpClient {
    constructor(options?: EventStoreHttpClientOptions);

    baseUrl: string;
    getToken?: () => string | Promise<string>;
    fetch: typeof globalThis.fetch;
    pollTimeoutMs: number;

    readStream(name: string, options?: ReadOptions): Promise<HttpEventStream>;
    readCategory(name: string, options?: ReadOptions): Promise<HttpEventStream>;
    readJoin(streams: string[], options?: ReadOptions): Promise<HttpEventStream>;
    follow(source: FollowSource, options?: FollowOptions): AsyncGenerator<FollowBatch, void, undefined>;
    commit(stream: string, events: object[], options?: CommitOptions): Promise<Record<string, unknown>>;
    health(): Promise<Record<string, unknown>>;
}
