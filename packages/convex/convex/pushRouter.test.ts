import { afterEach, describe, expect, test } from "bun:test";
import {
  enqueuePush,
  performPushFlush,
  summarizePushBatch,
  isDesktopActivePresence,
  isMachineActivePresence,
  AWAY_DEBOUNCE_MS,
  HOLD_WHILE_ACTIVE_MS,
  PRESENCE_FRESH_MS,
  INPUT_ACTIVE_MS,
  MAX_MACHINE_HOLD_MS,
} from "./pushRouter";

// ── In-memory Convex-ish ctx ─────────────────────────────────────────────────
// Same pattern as notifications.needsInput.test.ts: a fake ctx.db faithful
// enough to run the REAL enqueue/flush logic. withIndex ignores the index name
// and matches on eq constraints; scheduler.runAfter records calls.

type Rec = Record<string, any>;

function createCtx(seed: Record<string, Rec[]> = {}) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }
  const allRows = () => Object.values(tables).flat();
  const scheduled: Array<{ delay: number; fn: any; args: Rec }> = [];

  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      (tables[table] ??= []).push({ _id, ...doc });
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    async delete(id: string) {
      for (const rows of Object.values(tables)) {
        const i = rows.findIndex((r) => r._id === id);
        if (i !== -1) {
          rows.splice(i, 1);
          return;
        }
      }
      throw new Error(`delete: no row ${id}`);
    },
    query(table: string) {
      const constraints: Array<{ field: string; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, val });
          return q;
        },
      };
      const run = () =>
        (tables[table] ?? []).filter((r) =>
          constraints.every((c) => String(r[c.field]) === String(c.val))
        );
      const chain: any = {
        withIndex(_name: string, builder?: (qq: any) => unknown) {
          if (builder) builder(q);
          return chain;
        },
        async collect() {
          return run();
        },
        async first() {
          return run()[0] ?? null;
        },
      };
      return chain;
    },
  };

  return {
    db,
    scheduler: {
      async runAfter(delay: number, fn: any, args: Rec) {
        scheduled.push({ delay, fn, args });
      },
    },
    tables,
    scheduled,
  };
}

const NOW = 1_754_000_000_000;
const realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
});
function freezeTime(at: number) {
  Date.now = () => at;
}

const USER = { _id: "users_1", push_token: "ExponentPushToken[x]", notifications_enabled: true };

function activePresence(now: number): Rec {
  return {
    _id: "user_presence_1",
    user_id: "users_1",
    surface: "desktop",
    last_seen: now - 10_000,
    last_input_at: now - 5_000,
    focused: true,
    updated_at: now - 10_000,
  };
}

// Pushes recorded by the fake scheduler (the flush's terminal Expo send has
// delay 0 and a push_token arg; re-flushes have a user_id arg instead).
const sentPushes = (ctx: any) => ctx.scheduled.filter((s: Rec) => s.args.push_token);
const reflushes = (ctx: any) => ctx.scheduled.filter((s: Rec) => s.args.user_id);

describe("isDesktopActivePresence", () => {
  test("fresh heartbeat + recent input = active", () => {
    expect(isDesktopActivePresence(activePresence(NOW) as any, NOW)).toBe(true);
  });
  test("stale heartbeat (sleep/closed tab) = inactive even with recent input", () => {
    const p = { last_seen: NOW - PRESENCE_FRESH_MS - 1, last_input_at: NOW - 1000 };
    expect(isDesktopActivePresence(p, NOW)).toBe(false);
  });
  test("fresh heartbeat but idle human = inactive", () => {
    const p = { last_seen: NOW - 10_000, last_input_at: NOW - INPUT_ACTIVE_MS - 1 };
    expect(isDesktopActivePresence(p, NOW)).toBe(false);
  });
  test("no presence row = inactive", () => {
    expect(isDesktopActivePresence(null, NOW)).toBe(false);
  });
});

describe("enqueuePush routing", () => {
  test("desktop away: short debounce, not deferred", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    const row = ctx.tables.push_outbox[0];
    expect(row.due_at).toBe(NOW + AWAY_DEBOUNCE_MS);
    expect(row.deferred).toBe(false);
    expect(ctx.scheduled[0].delay).toBe(AWAY_DEBOUNCE_MS);
  });

  test("desktop active: held for the escalation window", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER], user_presence: [activePresence(NOW)] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    const row = ctx.tables.push_outbox[0];
    expect(row.due_at).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
    expect(row.deferred).toBe(true);
  });

  test("no push token: nothing queued", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [{ _id: "users_1" }] });
    await enqueuePush(ctx, { user: { _id: "users_1" } as any, title: "t", body: "b" });
    expect(ctx.tables.push_outbox).toBeUndefined();
  });
});

describe("performPushFlush", () => {
  test("single due row sends verbatim and clears the outbox", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER] });
    await enqueuePush(ctx, {
      user: USER,
      type: "session_idle",
      title: "Session ready",
      body: "fix-auth is waiting",
      data: { conversationId: "c1" },
    });
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    const pushes = sentPushes(ctx);
    expect(pushes.length).toBe(1);
    expect(pushes[0].args.title).toBe("Session ready");
    expect(pushes[0].args.body).toBe("fix-auth is waiting");
    expect(pushes[0].args.data.conversationId).toBe("c1");
    expect(ctx.tables.push_outbox.length).toBe(0);
  });

  test("a storm aggregates into ONE push", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER] });
    for (let i = 0; i < 20; i++) {
      await enqueuePush(ctx, {
        user: USER,
        type: "session_error",
        title: "Session error",
        body: `session ${i} hit the usage limit`,
      });
    }
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    const pushes = sentPushes(ctx);
    expect(pushes.length).toBe(1);
    expect(pushes[0].args.title).toBe("20 notifications");
    expect(pushes[0].args.body).toBe("20 session errors");
    expect(pushes[0].args.data.type).toBe("aggregate");
    expect(ctx.tables.push_outbox.length).toBe(0);
    // Later wakeups from the storm's other 19 schedules find nothing.
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(1);
  });

  test("mixed-type storm groups by type in the body", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER] });
    const mk = (type: string) =>
      enqueuePush(ctx, { user: USER, type, title: "t", body: "b" });
    await mk("session_idle");
    await mk("session_idle");
    await mk("permission_request");
    await mk("doc_commented");
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    const pushes = sentPushes(ctx);
    expect(pushes.length).toBe(1);
    expect(pushes[0].args.body).toBe(
      "2 sessions waiting for input · 1 permission request · 1 update"
    );
  });

  test("not yet due: flush is a no-op", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER], user_presence: [activePresence(NOW)] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    freezeTime(NOW + AWAY_DEBOUNCE_MS); // held row is due much later
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(0);
    expect(ctx.tables.push_outbox.length).toBe(1);
  });

  test("reading the notification cancels the held push", async () => {
    freezeTime(NOW);
    const ctx = createCtx({
      users: [USER],
      user_presence: [activePresence(NOW)],
      notifications: [{ _id: "notifications_1", recipient_user_id: "users_1", read: false }],
    });
    await enqueuePush(ctx, {
      user: USER,
      notification_id: "notifications_1",
      type: "session_idle",
      title: "t",
      body: "b",
    });
    await ctx.db.patch("notifications_1", { read: true });
    freezeTime(NOW + HOLD_WHILE_ACTIVE_MS);
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(0);
    expect(ctx.tables.push_outbox.length).toBe(0);
  });

  test("unread after the hold window escalates to the phone even while active", async () => {
    freezeTime(NOW);
    const ctx = createCtx({
      users: [USER],
      user_presence: [activePresence(NOW)],
      notifications: [{ _id: "notifications_1", recipient_user_id: "users_1", read: false }],
    });
    await enqueuePush(ctx, {
      user: USER,
      notification_id: "notifications_1",
      type: "session_idle",
      title: "t",
      body: "b",
    });
    const later = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(later);
    // Still active at flush time — escalation must fire anyway.
    await ctx.db.patch("user_presence_1", { last_seen: later - 1000, last_input_at: later - 1000 });
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(1);
  });

  test("superseded (deleted) notification drops its pending push", async () => {
    freezeTime(NOW);
    const ctx = createCtx({
      users: [USER],
      notifications: [{ _id: "notifications_1", recipient_user_id: "users_1", read: false }],
    });
    await enqueuePush(ctx, {
      user: USER,
      notification_id: "notifications_1",
      type: "session_idle",
      title: "t",
      body: "b",
    });
    await ctx.db.delete("notifications_1");
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(0);
    expect(ctx.tables.push_outbox.length).toBe(0);
  });

  test("user sits down during the away debounce: one deferral, then send", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    // Presence appears before the debounce elapses.
    await ctx.db.insert("user_presence", {
      user_id: "users_1",
      surface: "desktop",
      last_seen: NOW + AWAY_DEBOUNCE_MS - 1000,
      last_input_at: NOW + AWAY_DEBOUNCE_MS - 1000,
      focused: true,
      updated_at: NOW + AWAY_DEBOUNCE_MS - 1000,
    });
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(0);
    const row = ctx.tables.push_outbox[0];
    expect(row.deferred).toBe(true);
    expect(row.due_at).toBe(NOW + AWAY_DEBOUNCE_MS + HOLD_WHILE_ACTIVE_MS);
    expect(reflushes(ctx).length).toBeGreaterThan(1); // the deferral rescheduled
    // At the escalated due time, still unread → send (no second deferral).
    freezeTime(NOW + AWAY_DEBOUNCE_MS + HOLD_WHILE_ACTIVE_MS);
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(1);
  });

  test("push token revoked while pending: rows dropped silently", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [{ ...USER }] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    await ctx.db.patch("users_1", { notifications_enabled: false });
    freezeTime(NOW + AWAY_DEBOUNCE_MS);
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx).length).toBe(0);
    expect(ctx.tables.push_outbox.length).toBe(0);
  });
});

describe("summarizePushBatch", () => {
  test("single row passes through, keeping its deep-link data", () => {
    const out = summarizePushBatch([
      { type: "session_idle", title: "T", body: "B", data: { conversationId: "c" } },
    ]);
    expect(out).toEqual({ title: "T", body: "B", data: { conversationId: "c" } });
  });
  test("aggregate carries no conversation deep link", () => {
    const out = summarizePushBatch([
      { type: "session_idle", title: "a", body: "a" },
      { type: "session_idle", title: "b", body: "b" },
    ]);
    expect(out.data.conversationId).toBeUndefined();
    expect(out.body).toBe("2 sessions waiting for input");
  });
});

// ── Machine-wide presence (opt-in) ───────────────────────────────────────────
// Widens "the user is here" from "active in Codecast" to "touching this Mac at
// all", and — unlike client presence — keeps holding rather than escalating on
// a timer. Opted-out users must be completely unaffected.

const MACHINE_USER = { ...USER, machine_wide_presence: true };

function machineDevice(now: number, over: Rec = {}): Rec {
  return {
    _id: "devices_1",
    user_id: "users_1",
    device_id: "dev-1",
    last_seen: now - 10_000,
    last_input_at: now - 30_000,
    ...over,
  };
}

describe("isMachineActivePresence", () => {
  test("live daemon + recent input = active", () => {
    expect(isMachineActivePresence([machineDevice(NOW)] as any, NOW)).toBe(true);
  });
  test("no devices = away", () => {
    expect(isMachineActivePresence([], NOW)).toBe(false);
  });
  test("input older than the window = away", () => {
    const d = machineDevice(NOW, { last_input_at: NOW - INPUT_ACTIVE_MS - 1 });
    expect(isMachineActivePresence([d] as any, NOW)).toBe(false);
  });
  // A slept Mac freezes its daemon, so last_input_at can still look recent.
  // Heartbeat staleness is what catches it.
  test("stale heartbeat = away even with recent input", () => {
    const d = machineDevice(NOW, {
      last_seen: NOW - PRESENCE_FRESH_MS - 1,
      last_input_at: NOW - 1_000,
    });
    expect(isMachineActivePresence([d] as any, NOW)).toBe(false);
  });
  // nose and the hosted agent Macs are servers, not where the human sits.
  test("remote devices never count", () => {
    const d = machineDevice(NOW, { is_remote: true });
    expect(isMachineActivePresence([d] as any, NOW)).toBe(false);
  });
  test("a device reporting no input contributes nothing", () => {
    const d = machineDevice(NOW, { last_input_at: undefined });
    expect(isMachineActivePresence([d] as any, NOW)).toBe(false);
  });
  test("one active machine is enough among idle ones", () => {
    const devices = [
      machineDevice(NOW, { _id: "d1", last_input_at: NOW - INPUT_ACTIVE_MS - 1 }),
      machineDevice(NOW, { _id: "d2", is_remote: true, last_input_at: NOW - 1_000 }),
      machineDevice(NOW, { _id: "d3", last_input_at: NOW - 1_000 }),
    ];
    expect(isMachineActivePresence(devices as any, NOW)).toBe(true);
  });
});

// Codecast is open but you haven't touched it in a while — you're typing in an
// editor. Client presence alone reads "away"; machine presence is what holds.
function idleClientPresence(now: number): Rec {
  return { ...activePresence(now), last_input_at: now - INPUT_ACTIVE_MS - 1 };
}

describe("machine presence routing", () => {
  test("opted in, at the Mac but not in Codecast: held", async () => {
    freezeTime(NOW);
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [idleClientPresence(NOW)],
      devices: [machineDevice(NOW)],
    });
    // Sanity: client presence alone would NOT have held this.
    expect(isDesktopActivePresence(idleClientPresence(NOW) as any, NOW)).toBe(false);
    await enqueuePush(ctx, { user: MACHINE_USER, type: "session_idle", title: "t", body: "b" });
    const row = ctx.tables.push_outbox[0];
    expect(row.due_at).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
    expect(row.deferred).toBe(true);
  });

  test("opted OUT with the same active Mac: unchanged away debounce", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [USER], devices: [machineDevice(NOW)] });
    await enqueuePush(ctx, { user: USER, type: "session_idle", title: "t", body: "b" });
    const row = ctx.tables.push_outbox[0];
    expect(row.due_at).toBe(NOW + AWAY_DEBOUNCE_MS);
    expect(row.deferred).toBe(false);
  });

  // The point of the opt-in: a held push must NOT escalate to the phone just
  // because a timer expired while the user is demonstrably still at the machine.
  test("still at the Mac when the hold expires: re-deferred, no push", async () => {
    const later = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(later);
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [idleClientPresence(later)],
      devices: [machineDevice(later)],
      push_outbox: [
        {
          _id: "push_outbox_1",
          user_id: "users_1",
          type: "session_idle",
          title: "t",
          body: "b",
          created_at: NOW,
          due_at: later,
          deferred: true,
        },
      ],
    });
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx)).toHaveLength(0);
    expect(ctx.tables.push_outbox).toHaveLength(1);
    expect(ctx.tables.push_outbox[0].due_at).toBe(later + HOLD_WHILE_ACTIVE_MS);
    expect(reflushes(ctx)).toHaveLength(1);
  });

  // Same state, opted out: the shipped escalation still fires.
  test("opted out, held row past its window: escalates as before", async () => {
    const later = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(later);
    const ctx = createCtx({
      users: [USER],
      devices: [machineDevice(later)],
      push_outbox: [
        {
          _id: "push_outbox_1",
          user_id: "users_1",
          type: "session_idle",
          title: "t",
          body: "b",
          created_at: NOW,
          due_at: later,
          deferred: true,
        },
      ],
    });
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx)).toHaveLength(1);
    expect(ctx.tables.push_outbox).toHaveLength(0);
  });

  // Walked away: the re-defer stops and the batch ships.
  test("opted in, machine now idle: the held batch ships", async () => {
    const later = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(later);
    const ctx = createCtx({
      users: [MACHINE_USER],
      devices: [machineDevice(later, { last_input_at: later - INPUT_ACTIVE_MS - 1 })],
      push_outbox: [
        {
          _id: "push_outbox_1",
          user_id: "users_1",
          type: "session_idle",
          title: "t",
          body: "b",
          created_at: NOW,
          due_at: later,
          deferred: true,
        },
      ],
    });
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx)).toHaveLength(1);
    expect(ctx.tables.push_outbox).toHaveLength(0);
  });
});

// ── Machine hold: the safety properties ──────────────────────────────────────
// The three the earlier tests missed by only ever using one row and one cycle:
// bounded scheduling, guaranteed eventual delivery, and one buzz on walk-away.

function outboxRow(id: string, createdAt: number, dueAt: number): Rec {
  return {
    _id: id,
    user_id: "users_1",
    type: "session_idle",
    title: "t",
    body: "b",
    created_at: createdAt,
    due_at: dueAt,
    deferred: true,
  };
}

describe("machine hold safety properties", () => {
  // Scheduling must be per-flush, not per-row: per-row makes the churn grow
  // with how long the user sits at the desk.
  test("20 held rows schedule exactly ONE reflush", async () => {
    const at = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(at);
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [activePresence(at)],
      devices: [machineDevice(at)],
      push_outbox: Array.from({ length: 20 }, (_, i) =>
        outboxRow(`push_outbox_${i + 1}`, NOW, at),
      ),
    });
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx)).toHaveLength(0);
    expect(reflushes(ctx)).toHaveLength(1);
    expect(ctx.tables.push_outbox).toHaveLength(20);
  });

  // THE property. Without a ceiling a push can be held forever — synthetic HID
  // input (jigglers, screen sharing, UI automation) pins the machine "present"
  // with nobody there. This test must fail if the cap is ever removed.
  test("a held push is eventually delivered even if the Mac never goes idle", async () => {
    let at = NOW;
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [activePresence(NOW)],
      devices: [machineDevice(NOW)],
      push_outbox: [outboxRow("push_outbox_1", NOW, NOW)],
    });
    // Machine stays active forever; walk the clock in hold-sized steps.
    for (let i = 0; i < 40 && sentPushes(ctx).length === 0; i++) {
      at += HOLD_WHILE_ACTIVE_MS;
      freezeTime(at);
      ctx.tables.user_presence[0].last_seen = at - 10_000;
      ctx.tables.user_presence[0].last_input_at = at - 5_000;
      ctx.tables.devices[0].last_seen = at - 10_000;
      ctx.tables.devices[0].last_input_at = at - 5_000;
      await performPushFlush(ctx, "users_1");
    }
    expect(sentPushes(ctx)).toHaveLength(1);
    expect(at - NOW).toBeLessThanOrEqual(MAX_MACHINE_HOLD_MS + HOLD_WHILE_ACTIVE_MS);
    expect(ctx.tables.push_outbox).toHaveLength(0);
  });

  // Rows enqueued minutes apart drift onto separate due_at phases; without
  // collapsing them, walking away buzzes once per phase.
  test("walking away after a long hold sends ONE aggregated push", async () => {
    const at = NOW + HOLD_WHILE_ACTIVE_MS;
    freezeTime(at);
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [activePresence(at)],
      devices: [machineDevice(at)],
      push_outbox: [
        outboxRow("push_outbox_1", NOW, at),
        outboxRow("push_outbox_2", NOW + 60_000, at + 60_000),
        outboxRow("push_outbox_3", NOW + 120_000, at + 120_000),
      ],
    });
    // Still at the desk: everything holds and lands on one shared deadline.
    await performPushFlush(ctx, "users_1");
    const phases = new Set(ctx.tables.push_outbox.map((r: Rec) => r.due_at));
    expect(phases.size).toBe(1);

    // Now walk away: one flush, one push, covering all three.
    const later = at + HOLD_WHILE_ACTIVE_MS;
    freezeTime(later);
    ctx.tables.devices[0].last_seen = later - 10_000;
    ctx.tables.devices[0].last_input_at = later - INPUT_ACTIVE_MS - 1;
    ctx.tables.user_presence[0].last_seen = later - 10_000;
    ctx.tables.user_presence[0].last_input_at = later - INPUT_ACTIVE_MS - 1;
    await performPushFlush(ctx, "users_1");
    expect(sentPushes(ctx)).toHaveLength(1);
    expect(sentPushes(ctx)[0].args.title).toBe("3 notifications");
    expect(ctx.tables.push_outbox).toHaveLength(0);
  });

  // The daemon runs under launchd, independent of the app. With no live Codecast
  // surface there is nowhere to show the notification, so holding would black it
  // out entirely — machine presence requires a running client.
  test("no live Codecast surface: machine presence does not hold", async () => {
    freezeTime(NOW);
    const ctx = createCtx({ users: [MACHINE_USER], devices: [machineDevice(NOW)] });
    await enqueuePush(ctx, { user: MACHINE_USER, type: "session_idle", title: "t", body: "b" });
    expect(ctx.tables.push_outbox[0].due_at).toBe(NOW + AWAY_DEBOUNCE_MS);
    expect(ctx.tables.push_outbox[0].deferred).toBe(false);
  });

  // Client alive but its input stale (heads-down in an editor) is the whole
  // point of the opt-in — that must still hold.
  test("client open but idle + Mac active: holds", async () => {
    freezeTime(NOW);
    const stalePresence = {
      ...activePresence(NOW),
      last_input_at: NOW - INPUT_ACTIVE_MS - 1,
    };
    const ctx = createCtx({
      users: [MACHINE_USER],
      user_presence: [stalePresence],
      devices: [machineDevice(NOW)],
    });
    await enqueuePush(ctx, { user: MACHINE_USER, type: "session_idle", title: "t", body: "b" });
    expect(ctx.tables.push_outbox[0].due_at).toBe(NOW + HOLD_WHILE_ACTIVE_MS);
    expect(ctx.tables.push_outbox[0].deferred).toBe(true);
  });
});
