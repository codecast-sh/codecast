// The loopback server now listens seconds into boot, but the handler for
// /hook/status only exists at the end of it: the handler closes over the
// conversation cache, the retry queue, the pending message map and the file
// sync map, none of which exist yet. This gate is what lets the two happen at
// different times.
//
// Before the handler registers, a status is DEFERRED rather than dropped. The
// deferral is a write of the same JSON to ~/.codecast/agent-status/<session>.json
// that the hook script would have written on its own, so the two drains that
// already exist pick it up: the chokidar watcher on that directory and the
// boot replay that reads it once the handler is up. The ts guards in
// handleStatusData make a replayed record safe.
//
// It has to be the daemon writing that file rather than the hook: the
// installed hook runs `curl -s ... && exit 0` with no --fail, so curl exits 0
// on a 503 and the script skips its own fallback. Adding --fail to the script
// would not help either, because a copy only gets rewritten when a `cast`
// command reinstalls it and old copies live on machines indefinitely.

export type HookStatusDelivery = "delivered" | "deferred";

export class HookStatusGate<T> {
  private sink: ((sessionId: string, data: T) => void) | null = null;

  constructor(private readonly defer: (sessionId: string, data: T) => void) {}

  ready(): boolean {
    return this.sink !== null;
  }

  setSink(sink: (sessionId: string, data: T) => void): void {
    this.sink = sink;
  }

  deliver(sessionId: string, data: T): HookStatusDelivery {
    const sink = this.sink;
    if (!sink) {
      this.defer(sessionId, data);
      return "deferred";
    }
    // A throwing handler must not take down the request that carried the
    // status: the hook has already moved on and nothing would retry it.
    try {
      sink(sessionId, data);
    } catch {}
    return "delivered";
  }
}
