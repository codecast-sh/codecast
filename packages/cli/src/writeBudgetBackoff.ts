// The Convex deployment caps bytes written per second across every caller.
// When a whole fleet of daemons catches up at once (v1.1.219, 2026-11-11: a
// validator fix let every daemon upload its backlog of Codex subagent threads
// within a minute of the release, 150 MB a minute of addMessages), the cap
// refuses writes for everyone: heartbeats, delivery claims and new messages
// alike, about 1,500 refusals in six minutes. Each daemon kept sending at its
// usual pace, so the refusals did nothing to drain the overload.
//
// A refusal now pauses this daemon's bulk sync (the throttled paths in
// SyncService). Writes that skip the throttle (heartbeats, delivery state) keep
// going, so the budget left goes to them. The pause grows while refusals keep
// coming and is jittered, so daemons refused in the same second do not all
// return in the same second.

const BASE_MS = 2_000;
const MAX_MS = 30_000;
// A refusal this long after the previous one starts a fresh streak.
const STREAK_RESET_MS = 60_000;

export function isWriteBudgetRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return message.includes("Too many writes per second");
}

export class WriteBudgetBackoff {
  private pausedUntil = 0;
  private streak = 0;
  private lastRefusalAt = -Infinity;

  constructor(private readonly random: () => number = Math.random) {}

  /** Record a refusal; returns how long bulk sync now pauses. */
  refused(now = Date.now()): number {
    this.streak = now - this.lastRefusalAt > STREAK_RESET_MS ? 1 : this.streak + 1;
    this.lastRefusalAt = now;
    const ceiling = Math.min(MAX_MS, BASE_MS * 2 ** (this.streak - 1));
    const delay = Math.round(ceiling * (0.5 + 0.5 * this.random()));
    this.pausedUntil = Math.max(this.pausedUntil, now + delay);
    return this.pausedUntil - now;
  }

  /** Milliseconds bulk sync must still wait, 0 when not paused. */
  waitMs(now = Date.now()): number {
    return Math.max(0, this.pausedUntil - now);
  }
}
