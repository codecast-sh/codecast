// The loop freeze budget, shared between the daemon that measures it and the
// CLI that prints it. The daemon writes this shape into its state file on the
// 30s monitor tick and `cast health` reads it back, so the two sides must agree
// field for field. It lives in its own module because index.ts must never
// import daemon.ts: that module starts timers the moment it is loaded.

export interface LoopFreezeSummary {
  /** Blocked ms inside the trailing minute (what the web "under load" tier reads). */
  recentMs: number;
  /** Blocked ms, freeze count and worst single freeze inside the trailing hour. */
  hourMs: number;
  hourCount: number;
  hourMaxMs: number;
  /** Totals since boot; never pruned. */
  bootMs: number;
  bootCount: number;
  /** Hot stacks of the worst freeze in the hour, sanitized and capped. */
  top: string;
}

/** The summary as it sits in the daemon state file. `at` is when it was
 * measured, so a stale state file reads as stale rather than as current. */
export type LoopFreezeState = LoopFreezeSummary & { at: number };
