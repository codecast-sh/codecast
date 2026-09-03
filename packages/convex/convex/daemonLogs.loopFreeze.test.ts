// The loop freeze alert must fire once per incident, stay quiet through the
// rest of it, and fire again on the NEXT one. Three traps live in the decision:
// a machine already alerted on keeps beating the same hour total every 5
// minutes; an old daemon that stopped reporting leaves its last value frozen on
// the device row forever; and a second real incident is often smaller than the
// first. The first two are handled by comparing hour totals rather than only
// timing out, so a value that never grows can alert at most once. The third is
// handled by the handler clearing the stamp once the machine has been under the
// bar past the cooldown, which frees the next incident to be judged on its own
// without letting a machine hovering at the bar re-alert every other tick.
import { describe, expect, test } from "bun:test";
import {
  shouldNotifyDeviceFreeze,
  FREEZE_NOTIFY_COOLDOWN_MS,
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
    // This is the frozen-field case: a daemon that stopped reporting leaves the
    // number where it was, and a number that never grows is never news again.
    const state = { last_notified_at: NOW - 10 * FREEZE_NOTIFY_COOLDOWN_MS, last_hour_ms: 215_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, state })).toBe(false);
  });
});

// Hand-rolled ctx in the style of artifacts.test.ts: enough db surface for the
// handler, recording the sub-mutation calls and the order of writes.
function makeCtx(rows: Array<Record<string, any>>) {
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
        return { notified: 1 };
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

  test("a machine that is offline or under the bar is never alerted on", async () => {
    const quiet = fixture();
    quiet[1].loop_freeze_1h_ms = 30_000;
    expect((await handler(makeCtx(quiet).ctx, {})).notified).toBe(0);

    const gone = fixture();
    gone[1].last_seen = Date.now() - 10 * 60_000;
    expect((await handler(makeCtx(gone).ctx, {})).notified).toBe(0);
  });
});
