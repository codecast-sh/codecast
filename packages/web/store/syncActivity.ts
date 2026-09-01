// SYNC ACTIVITY — the quiescence inputs for the digest compare
// (docs/architecture/sync-convergence.md C6, gate 4).
//
// A compare that runs mid catch-up reports ordinary eventual consistency as
// drift, so the compare waits until the appliers are quiet: no ROW-channel
// apply for the last few coarse ticks, and nothing in flight that will apply
// more (a sync-log range, a reconcile crawl page, a recovery poll). This
// module is that clock and that counter, and nothing else. It is a LEAF
// (no store import) so the store's syncTable, the hooks and the compare can
// all reach it without a cycle.
//
// Not counted: the liveness overlay apply. The overlay is the compare's own
// input (facts and stamps from ONE payload), so applying it moves both sides
// of the comparison together and proves nothing about catch-up state.

export type SyncInflightKind = "range" | "crawl" | "poll";

let _lastApplyMono = Number.NEGATIVE_INFINITY;
let _applySeq = 0;
const _inflight: Record<SyncInflightKind, number> = { range: 0, crawl: 0, poll: 0 };

// Receipt clock for payload age (sync-convergence C2): monotonic where
// available — immune to wall-clock jumps across sleep/NTP — with Date.now()
// as the last resort. The ONE receipt clock: the store's applier, the compare
// and this module all read it from here.
export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** A row channel applied a payload (syncTable on a replica collection). */
export function noteSyncApply(): void {
  _lastApplyMono = monotonicNow();
  _applySeq++;
}

/** Monotonic time of the last row apply; -Infinity when none happened yet. */
export function lastSyncApplyMono(): number {
  return _lastApplyMono;
}

/** Bumps on every apply — a cheap "anything applied since?" token. */
export function syncApplySeq(): number {
  return _applySeq;
}

/** Mark a catch-up operation in flight; call the returned release exactly once. */
export function beginSyncInflight(kind: SyncInflightKind): () => void {
  _inflight[kind]++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _inflight[kind] = Math.max(0, _inflight[kind] - 1);
  };
}

export function syncInflightCount(): number {
  return _inflight.range + _inflight.crawl + _inflight.poll;
}

export function __resetSyncActivityForTests(): void {
  _lastApplyMono = Number.NEGATIVE_INFINITY;
  _applySeq = 0;
  _inflight.range = 0;
  _inflight.crawl = 0;
  _inflight.poll = 0;
}
