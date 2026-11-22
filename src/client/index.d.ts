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
export type StreamSelector = string | StreamSelector[];

export interface FollowSource {
    kind: FollowSourceKind;
    name?: string;
    streams?: string[];
    selector?: StreamSelector;
}

export interface ReadOptions {
    from?: number;
    until?: number;
    signal?: AbortSignal;
}

export interface QueryReadOptions {
    from?: number;
    filter?: object | null;
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
    readJoin(selectorOrStreams: StreamSelector, options?: ReadOptions): Promise<HttpEventStream>;
    readQuery(selectorOrQuery: string[] | { selector: StreamSelector } | Record<string, unknown>, options?: QueryReadOptions): Promise<HttpEventStream>;
    /** Read the events of a compiled selector from a global position; the response carries the commit condition. */
    follow(source: FollowSource, options?: FollowOptions): AsyncGenerator<FollowBatch, void, undefined>;
    commit(stream: string, events: object[], options?: CommitOptions): Promise<Record<string, unknown>>;
    health(options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
}

/** One event as delivered by an event source. */
export interface SourceEnvelope {
    event: Record<string, unknown>;
    metadata: Record<string, unknown>;
    /** Global position of the event. */
    position: number;
    type: string;
    tags: string[];
}

/** The events to read: a selector and an optional object matcher, e.g. a commit condition. */
export interface SourceSelection {
    selector: StreamSelector;
    matcher?: Record<string, unknown> | null;
}

export interface HttpSourceOptions {
    /** Dot-notation path to the event type. Default: reported by the server in `GET /health`. */
    typeAccessor?: string;
    /** Dot-notation path to the event tags. Default: reported by the server in `GET /health`. */
    tagsAccessor?: string | null;
    /** How long `follow()` waits before asking again when nothing new arrived. Default 1000. */
    pollIntervalMs?: number;
}

/** The event source of `event-storage/projections` over the HTTP API. */
export interface HttpEventSource {
    query(query: Record<string, unknown> | StreamSelector, options?: { from?: number }): Promise<{ events: AsyncIterable<SourceEnvelope>; condition: SerializedCommitCondition }>;
    read(selection: SourceSelection, options?: { from?: number; signal?: AbortSignal }): AsyncIterable<SourceEnvelope>;
    follow(selection: SourceSelection, options?: { from?: number; signal?: AbortSignal }): AsyncIterable<SourceEnvelope>;
}

/** An event source for `buildDecisionModel()` and `createReadModel()` of `event-storage/projections`. */
export function httpSource(client: EventStoreHttpClient, options?: HttpSourceOptions): HttpEventSource;
