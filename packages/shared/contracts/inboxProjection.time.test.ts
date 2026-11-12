import { describe, expect, test } from "bun:test";
import {
  deriveLiveAt,
  inboxEpoch,
  inboxSortTime,
  rowLiveDeadlines,
  INBOX_CREATE_GRACE_MS,
  type InboxSortTimeInput,
  type LiveFactsRow,
} from "./inboxProjection";

const EPOCH = inboxEpoch(1_800_000_000_000);
const HOUR = 60 * 60 * 1000;

// ── deriveLiveAt (ct-47609) ──────────────────────────────────────────────────
describe("deriveLiveAt: one idle rule at any instant", () => {
  const T0 = 1_800_000_000_000;
  const S = 1_000, MIN = 60 * S, H = 60 * MIN;
  // A tiny seeded generator so the property runs the same way every time.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const maybe = <T,>(v: T): T | null => (rnd() < 0.3 ? null : v);
  const facts = (): LiveFactsRow => ({
    status: pick(["active", "active", "completed"]),
    updated_at: T0 - Math.floor(rnd() * 3 * H),
    message_count: pick([0, 3, 40]),
    has_pending_messages: rnd() < 0.2,
    inbox_dismissed_at: rnd() < 0.15 ? T0 - MIN : null,
    inbox_stashed_at: rnd() < 0.1 ? T0 - MIN : null,
    agent_status: maybe(pick(["working", "idle", "waiting", "dormant", "done", "stopped", "permission_blocked", "compacting"])),
    agent_status_updated_at: maybe(T0 - Math.floor(rnd() * 2 * H)),
    last_heartbeat: maybe(T0 - Math.floor(rnd() * 3 * MIN)),
    daemon_alive_until: maybe(T0 + Math.floor(rnd() * 10 * MIN) - 2 * MIN),
    producing_until: maybe(T0 + Math.floor(rnd() * 10 * MIN) - 2 * MIN),
    last_role_is_user: rnd() < 0.4,
    auq_open: rnd() < 0.2,
    open_tasks: rnd() < 0.3 ? [{}] : null,
    open_tasks_at: maybe(T0 - Math.floor(rnd() * 15 * MIN)),
    loop_state: null,
  });
  const live = (r: LiveFactsRow, t: number) => deriveLiveAt(r, t);

  test("re-running over the shipped (already coerced) live fields is idempotent", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      for (const t of [T0, T0 + 50 * S, T0 + 2 * MIN, T0 + 2 * H]) {
        const once = live(r, t);
        const twice = live({ ...r, agent_status: once.agent_status, awaiting_input: once.awaiting_input }, t);
        expect(twice).toEqual(once);
      }
    }
  });

  // A replica derives at its own clock from a payload the overlay shipped
  // earlier: the payload carries the daemon's raw status, never a verdict
  // coerced at the overlay's instant. A working row whose trust decayed to
  // idle while its heartbeat lived is stopped once the heartbeat lapses
  // (ct-56054).
  test("a payload shipped at one instant derives every later instant exactly as the raw facts do", () => {
    const shipped = (r: LiveFactsRow, t: number): LiveFactsRow => ({ ...r, awaiting_input: live(r, t).awaiting_input });
    for (let i = 0; i < 150; i++) {
      const r = facts();
      for (const t1 of [T0 - 2 * MIN, T0, T0 + 50 * S]) {
        const payload = shipped(r, t1);
        for (const t2 of [t1, t1 + 50 * S, t1 + 2 * MIN, t1 + 2 * H]) expect(live(payload, t2)).toEqual(live(r, t2));
      }
    }
    const decayed: LiveFactsRow = {
      status: "completed", updated_at: T0 - 14 * 24 * H, message_count: 14, agent_status: "working",
      agent_status_updated_at: T0 - 25 * MIN, last_heartbeat: T0 - 17 * S, daemon_alive_until: T0 + 103 * S,
    };
    expect(live(decayed, T0 + 35 * S).agent_status).toBe("idle");
    expect(live(shipped(decayed, T0 + 35 * S), T0 + 120 * S).agent_status).toBe("stopped");
  });

  test("for fixed facts, is_idle never returns to false as time passes; an ask and a daemon never come back", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      let prev = live(r, T0 - H);
      for (let t = T0 - H + 5 * S; t <= T0 + 3 * H; t += 25 * S) {
        const cur = live(r, t);
        if (prev.is_idle) expect(cur.is_idle).toBe(true);
        if (!prev.awaiting_input) expect(cur.awaiting_input).toBe(false);
        if (!prev.daemon_alive) expect(cur.daemon_alive).toBe(false);
        prev = cur;
      }
    }
  });

  test("rowLiveDeadlines names every instant the derivation can change: it is constant between adjacent deadlines", () => {
    for (let i = 0; i < 150; i++) {
      const r = facts();
      const ds = [...new Set(rowLiveDeadlines(r).filter((d): d is number => d != null))].sort((a, b) => a - b);
      const points = [T0 - 4 * H, ...ds, T0 + 4 * H];
      for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k], b = points[k + 1];
        if (b - a < 2) continue;
        expect(live(r, a)).toEqual(live(r, b - 1));
      }
    }
  });
});

// ── The sort time inside a bucket (ct-49550) ────────────────────────────────

describe("inboxSortTime — one stamp per class", () => {
  const MIN = 60_000;
  const sort = (partial: Partial<InboxSortTimeInput>, now = EPOCH) =>
    inboxSortTime({ work_state: "needs_input", ...partial } as InboxSortTimeInput, now);

  // The table: which stamp each class reads when every stamp is present, and
  // which one it falls back to as the ones above it go missing. Written as
  // (class, row facts) → the event the order must name.
  const CASES: Array<{ name: string; input: Partial<InboxSortTimeInput>; at: number }> = [
    // needs_input: when the state started, whatever the last turn did.
    { name: "needs_input reads the status start", input: { work_state: "needs_input", statusStartedAt: EPOCH - MIN, turnCompletedAt: EPOCH - HOUR, activityAt: EPOCH - 3 * HOUR }, at: EPOCH - MIN },
    { name: "needs_input with no daemon falls back to activity", input: { work_state: "needs_input", activityAt: EPOCH - 3 * HOUR }, at: EPOCH - 3 * HOUR },
    // done: when the turn ended — the stamp outlives later status writes.
    { name: "done reads the completed turn", input: { work_state: "done", turnCompletedAt: EPOCH - MIN, statusStartedAt: EPOCH - HOUR, activityAt: EPOCH - 3 * HOUR }, at: EPOCH - MIN },
    { name: "done without the turn stamp falls back to the status start", input: { work_state: "done", statusStartedAt: EPOCH - HOUR, activityAt: EPOCH - 3 * HOUR }, at: EPOCH - HOUR },
    // working: the most recent PRIOR attention event, so a session that just
    // came back from a settle outranks one grinding for an hour.
    { name: "working reads the previous turn's end", input: { work_state: "working", turnCompletedAt: EPOCH - MIN, statusStartedAt: EPOCH - 30 * MIN, activityAt: EPOCH }, at: EPOCH - MIN },
    { name: "working that never settled falls back to when it started working", input: { work_state: "working", statusStartedAt: EPOCH - 30 * MIN, activityAt: EPOCH }, at: EPOCH - 30 * MIN },
    // dormant: when it parked.
    { name: "dormant reads when it parked", input: { work_state: "dormant", statusStartedAt: EPOCH - MIN, activityAt: EPOCH - 3 * HOUR }, at: EPOCH - MIN },
    { name: "dormant with no daemon falls back to activity", input: { work_state: "dormant", activityAt: EPOCH - 3 * HOUR }, at: EPOCH - 3 * HOUR },
    // idle: blank or retired — plain recency.
    { name: "idle reads plain recency", input: { work_state: "idle", activityAt: EPOCH - HOUR, statusStartedAt: EPOCH - MIN, turnCompletedAt: EPOCH - MIN }, at: EPOCH - HOUR },
  ];

  for (const c of CASES) {
    test(c.name, () => {
      expect(sort(c.input).at).toBe(c.at);
    });
  }

  test("every class but dormant orders newest first", () => {
    for (const ws of ["needs_input", "done", "working", "idle"] as const) {
      const fresh = sort({ work_state: ws, statusStartedAt: EPOCH - MIN, turnCompletedAt: EPOCH - MIN, activityAt: EPOCH - MIN });
      const old = sort({ work_state: ws, statusStartedAt: EPOCH - HOUR, turnCompletedAt: EPOCH - HOUR, activityAt: EPOCH - HOUR });
      expect(fresh.key).toBeLessThan(old.key);
    }
  });

  test("dormant orders oldest park first", () => {
    const fresh = sort({ work_state: "dormant", statusStartedAt: EPOCH - MIN });
    const stale = sort({ work_state: "dormant", statusStartedAt: EPOCH - HOUR });
    expect(stale.key).toBeLessThan(fresh.key);
    expect(stale.at).toBeLessThan(fresh.at);
  });

  // A session the user just started has none of the events above, so ambient
  // output on older rows would push it out of sight (Orca CREATE_GRACE_MS).
  test("a brand new session holds the top of a freshest-first list for the grace, then rejoins", () => {
    const createdAt = EPOCH - MIN;
    const born = (now: number) => sort({ work_state: "working", statusStartedAt: EPOCH - 3 * HOUR, activityAt: EPOCH - 3 * HOUR, createdAt }, now);
    const busy = sort({ work_state: "working", turnCompletedAt: EPOCH - MIN });
    expect(born(EPOCH).key).toBeLessThan(busy.key);
    expect(born(EPOCH).key).toBe(-(createdAt + INBOX_CREATE_GRACE_MS));
    // Past the window the floor lifts and the row's own stamp speaks again.
    const after = createdAt + INBOX_CREATE_GRACE_MS;
    expect(born(after).key).toBe(-(EPOCH - 3 * HOUR));
    // Two sessions inside the window keep their creation order.
    const older = sort({ work_state: "working", createdAt: createdAt - MIN }, EPOCH);
    expect(sort({ work_state: "working", createdAt }, EPOCH).key).toBeLessThan(older.key);
  });

  // The stamp itself never moves: a queue the reader clears top-down orders by
  // it, and a floor that lifts a row in a freshest-first list would sink it
  // there — where a brand new row belongs anyway.
  test("the grace floors the key only, never the stamp", () => {
    const createdAt = EPOCH - MIN;
    expect(sort({ work_state: "needs_input", statusStartedAt: EPOCH - 3 * HOUR, createdAt }, EPOCH).at).toBe(EPOCH - 3 * HOUR);
  });

  test("the grace never applies to dormant, a section read oldest first", () => {
    const parked = sort({ work_state: "dormant", statusStartedAt: EPOCH - HOUR, createdAt: EPOCH - MIN }, EPOCH);
    expect(parked).toEqual({ at: EPOCH - HOUR, key: EPOCH - HOUR });
  });

  // An Infinity off a corrupted row would pin the session to the top of its
  // group forever; a zero or a missing stamp means "no such event".
  test("a non-finite or absent stamp reads as no event", () => {
    expect(sort({ work_state: "done", turnCompletedAt: Infinity, statusStartedAt: EPOCH - HOUR }).at).toBe(EPOCH - HOUR);
    expect(sort({ work_state: "done", turnCompletedAt: NaN, activityAt: EPOCH - HOUR }).at).toBe(EPOCH - HOUR);
    expect(sort({ work_state: "done" }).at).toBe(0);
    expect(sort({ work_state: "working", createdAt: Infinity }, EPOCH).key).toBe(0);
  });
});
