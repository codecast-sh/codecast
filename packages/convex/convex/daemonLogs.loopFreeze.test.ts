// The loop freeze alert must fire once per incident, stay quiet through the
// rest of it, and fire again on the NEXT one. Four traps live in the decision:
// a machine already alerted on keeps beating the same hour total every 5
// minutes; an old daemon that stopped reporting leaves its last value frozen on
// the device row forever; a second real incident is often smaller than the
// first; and a machine can simply stay over the bar for weeks.
// The frozen value is handled by asking whether the number moved at all, so a
// value that never changes alerts at most once. A worse number waits out the
// short cooldown; a number that moved without beating the last peak waits out
// the long one, which is what keeps a chronically broken machine reporting
// instead of going silent after day one. And the handler clears the stamp once
// the machine has been under the bar past the cooldown, so the next incident is
// judged on its own without letting a machine hovering at the bar re-alert
// every other tick.
import { describe, expect, test } from "bun:test";
import {
  shouldNotifyDeviceFreeze,
  FREEZE_NOTIFY_COOLDOWN_MS,
  FREEZE_RENOTIFY_MS,
  LOOP_FREEZE_ALERT_MS,
  checkDeviceLoopFreeze,
} from "./daemonLogs";

const NOW = 1_700_000_000_000;

describe("shouldNotifyDeviceFreeze", () => {
  const base = { thresholdMs: LOOP_FREEZE_ALERT_MS, online: true, now: NOW };

  test("stays silent under the bar and with nothing reported", () => {
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 60_000 })).toBe(false);
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: undefined })).toBe(false);
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 0 })).toBe(false);
  });

  test("notifies over the bar when the machine has never been alerted on", () => {
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000 })).toBe(true);
  });

  test("an offline machine never notifies", () => {
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, online: false })).toBe(false);
  });

  test("the same hour total inside the cooldown is already covered", () => {
    const state = { last_notified_at: NOW - 60_000, last_hour_ms: 215_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, state })).toBe(false);
  });

  test("a worse hour past the cooldown announces itself again", () => {
    const state = { last_notified_at: NOW - FREEZE_NOTIFY_COOLDOWN_MS - 1, last_hour_ms: 215_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 400_000, state })).toBe(true);
    // A worse hour INSIDE the cooldown still waits.
    expect(
      shouldNotifyDeviceFreeze({
        ...base,
        hourMs: 400_000,
        state: { last_notified_at: NOW - 60_000, last_hour_ms: 215_000 },
      }),
    ).toBe(false);
  });

  test("an unchanged value past the cooldown stays silent forever", () => {
    // This is the case where a daemon stopped reporting and left the value
    // where it was. A number that never grows is never news again.
    const state = { last_notified_at: NOW - 10 * FREEZE_NOTIFY_COOLDOWN_MS, last_hour_ms: 215_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, state })).toBe(false);
  });

  // The founder's own laptop: over the bar every hour of every day, and rarely
  // beating its own worst hour. Comparing only against the peak silenced it
  // after the first alert for the life of the row, because a value between the
  // bar and the peak is neither worse nor low enough to clear the stamp.
  test("a machine that keeps breaching without a new peak re-alerts on the long interval", () => {
    const state = { last_notified_at: NOW - 3 * 24 * 60 * 60 * 1000, last_hour_ms: 400_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 300_000, state })).toBe(true);
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 399_000, state })).toBe(true);
    // Inside the long interval it waits, so a chronic machine is heard from
    // every few hours, not every cron tick.
    const recent = { last_notified_at: NOW - FREEZE_NOTIFY_COOLDOWN_MS - 1, last_hour_ms: 400_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 300_000, state: recent })).toBe(false);
    expect(FREEZE_RENOTIFY_MS).toBeGreaterThan(FREEZE_NOTIFY_COOLDOWN_MS);
  });
});

// Hand-rolled ctx in the style of artifacts.test.ts: enough db surface for the
// handler, recording the sub-mutation calls and the order of writes.
function makeCtx(rows: Array<Record<string, any>>, emitResult: { notified: number } = { notified: 1 }) {
  const calls: Array<{ fn: any; args: Record<string, any> }> = [];
  const writes: string[] = [];
  const query = (table: string) => {
    let filtered = rows.filter((r) => r._table === table);
    return {
      withIndex(_name: string, cb: (q: any) => any) {
        const eqs: Record<string, any> = {};
        const gtes: Record<string, any> = {};
        const q = {
          eq(field: string, value: any) { eqs[field] = value; return q; },
          gte(field: string, value: any) { gtes[field] = value; return q; },
        };
        cb(q);
        filtered = filtered.filter(
          (r) =>
            Object.entries(eqs).every(([k, v]) => r[k] === v) &&
            Object.entries(gtes).every(([k, v]) => (r[k] ?? 0) >= (v as number)),
        );
        return {
          collect: async () => filtered,
          unique: async () => filtered[0] ?? null,
        };
      },
    };
  };
  return {
    ctx: {
      db: {
        query,
        get: async (id: string) => rows.find((r) => r._id === id) ?? null,
        patch: async (id: string, patch: Record<string, any>) => {
          writes.push(`patch:${id}`);
          Object.assign(rows.find((r) => r._id === id)!, patch);
        },
        insert: async () => "x",
      },
      runMutation: async (fn: any, args: Record<string, any>) => {
        writes.push("emit");
        calls.push({ fn, args });
        return emitResult;
      },
    } as any,
    calls,
    writes,
  };
}

describe("checkDeviceLoopFreeze", () => {
  const handler = (checkDeviceLoopFreeze as any)._handler ?? (checkDeviceLoopFreeze as any).handler;

  function fixture(): Array<Record<string, any>> {
    return [
      { _table: "users", _id: "u1", last_heartbeat: Date.now() },
      {
        _table: "devices",
        _id: "d1",
        user_id: "u1",
        label: "Ashots MacBook",
        platform: "darwin",
        last_seen: Date.now(),
        loop_freeze_1h_ms: 215_000,
        loop_freeze_max_ms: 42_000,
        loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
      },
    ];
  }

  test("alerts once across two consecutive ticks, stamping before it delivers", async () => {
    const rows = fixture();
    const { ctx, calls, writes } = makeCtx(rows);
    const first = await handler(ctx, {});
    expect(first.notified).toBe(1);
    // The stamp lands BEFORE the emit, so a racing tick cannot double-push.
    expect(writes).toEqual(["patch:d1", "emit"]);
    expect(rows[1].freeze_notify_state.last_hour_ms).toBe(215_000);

    const second = await handler(ctx, {});
    expect(second.notified).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test("the notification names the machine, the hour, the worst freeze and the cause", async () => {
    const { ctx, calls } = makeCtx(fixture());
    await handler(ctx, {});
    const args = calls[0].args;
    expect(args.event_type).toBe("daemon_overloaded");
    expect(args.entity_type).toBe("device");
    expect(args.direct_recipient_id).toBe("u1");
    expect(args.actor_name).toBe("Ashots MacBook");
    // No `link`: the bell opens that field in a new tab, and a device routes
    // in-app through its entity type instead.
    expect(args.link).toBeUndefined();
    expect(args.message).toContain("215s in the last hour");
    expect(args.message).toContain("42s");
    expect(args.message).toContain("walk@recursiveWatcher.ts:138");
  });

  test("a machine that recovers alerts again on its next, smaller incident", async () => {
    const rows = fixture();
    const { ctx, calls } = makeCtx(rows);
    expect((await handler(ctx, {})).notified).toBe(1);

    // The incident ends: the freezes roll out of the trailing hour. Inside the
    // cooldown the stamp holds, so the dip alone cannot reset the debounce.
    rows[1].loop_freeze_1h_ms = 60_000;
    expect((await handler(ctx, {})).notified).toBe(0);
    expect(rows[1].freeze_notify_state).toBeDefined();

    // Quiet past the cooldown: now the stamp is dropped and the next incident
    // is judged on its own.
    rows[1].freeze_notify_state.last_notified_at = Date.now() - FREEZE_NOTIFY_COOLDOWN_MS - 1;
    expect((await handler(ctx, {})).notified).toBe(0);
    expect(rows[1].freeze_notify_state).toBeUndefined();

    // A new incident, smaller than the first but still past the bar.
    rows[1].loop_freeze_1h_ms = 150_000;
    expect((await handler(ctx, {})).notified).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.message).toContain("150s in the last hour");
  });

  test("a machine hovering at the bar is announced once, not every other tick", async () => {
    const rows = fixture();
    const { ctx, calls } = makeCtx(rows);
    expect((await handler(ctx, {})).notified).toBe(1);

    // Five minutes of crossing the bar and falling back under it. Every one of
    // these ticks is inside the cooldown, so none of them may announce again.
    for (const hour of [60_000, 215_000, 90_000, 230_000, 100_000, 215_000]) {
      rows[1].loop_freeze_1h_ms = hour;
      expect((await handler(ctx, {})).notified).toBe(0);
    }
    expect(calls).toHaveLength(1);
  });

  // The founder's laptop again, at the handler level: past the bar on every
  // tick, never beating its own peak. The count is what the cron returns, so a
  // machine going silent here is a machine the SLO stopped watching.
  test("a machine that stays over the bar for days keeps being reported", async () => {
    const rows = fixture();
    rows[1].loop_freeze_1h_ms = 400_000;
    const { ctx, calls } = makeCtx(rows);
    expect((await handler(ctx, {})).notified).toBe(1);

    // Every later hour is over the bar and under that first peak.
    rows[1].loop_freeze_1h_ms = 300_000;
    expect((await handler(ctx, {})).notified).toBe(0);

    // A few hours later the same breach is news again, and the stamp follows
    // the number down so the next comparison is against what we just said.
    rows[1].freeze_notify_state.last_notified_at = Date.now() - FREEZE_RENOTIFY_MS - 1;
    expect((await handler(ctx, {})).notified).toBe(1);
    expect(rows[1].freeze_notify_state.last_hour_ms).toBe(300_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.message).toContain("300s in the last hour");
  });

  // notificationRouter.emit drops the row when the recipient muted the
  // preference this event maps to. The cron reports deliveries, so it must
  // count what the router wrote, not what it tried to write.
  test("a muted recipient is not counted as notified", async () => {
    const { ctx } = makeCtx(fixture(), { notified: 0 });
    expect((await handler(ctx, {})).notified).toBe(0);
  });

  test("a machine that is offline or under the bar is never alerted on", async () => {
    const quiet = fixture();
    quiet[1].loop_freeze_1h_ms = 30_000;
    expect((await handler(makeCtx(quiet).ctx, {})).notified).toBe(0);

    const gone = fixture();
    gone[1].last_seen = Date.now() - 10 * 60_000;
    expect((await handler(makeCtx(gone).ctx, {})).notified).toBe(0);
  });
});
