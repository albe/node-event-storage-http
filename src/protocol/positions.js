/**
 * Global-position helpers for the HTTP protocol.
 *
 * A global position is a 1-based monotonic cursor over the commit log. It is
 * derived purely from fields already present on persisted events / commit
 * results, so these helpers carry no runtime dependency on the server or the
 * underlying `event-storage` package.
 */

/**
 * Compute the global position of a single persisted event.
 *
 * @param {{commitId: number, commitVersion: number}} event A persisted event. Must not be null/undefined.
 * @returns {number} The 1-based global position immediately after this event.
 */
function eventPosition(event) {
    return event.commitId + event.commitVersion + 1;
}

/**
 * Compute the global position reached by a commit (i.e. the position of its
 * last event).
 *
 * @param {{commitId: number, events: ReadonlyArray<unknown>}} commitResult A commit result with `commitId` and `events`. Must not be null/undefined.
 * @returns {number} The 1-based global position after the commit's final event.
 */
function commitPosition(commitResult) {
    return commitResult.commitId + commitResult.events.length;
}

export { eventPosition, commitPosition };
