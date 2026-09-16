import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { insertSwitchCommands, throttleContinueCheck } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

// ct-51376 (2026-09-14). A throttle parked conversation whose earlier
// automatic "continue" had not been delivered yet (the daemon read the session
// as busy for an hour, or the laptop slept) got a fresh "continue" row on every
// paced check. The client id is bucketed by minute, so each tick a minute later
// minted a new row: jx7bd0r61e0d collected one row a minute from 12:00 to
// 12:58. When the session went idle the daemon drained the backlog one refused
// turn after another, a "continue" every 1 to 2 seconds in the transcript, and
// each refusal (a 429) re-parked the session and re-armed the check.
//
// A continue that is still waiting to be delivered already asks for the retry.
// A second one adds nothing but another refused turn.

afterEach(() => setSystemTime());

function fixture(now: number) {
  const device = {
    _id: "devices_primary", user_id: "users_owner", device_id: "mac", last_seen: now,
    cc_auto_continue: true, cc_auto_switch: false, cc_auto_switch_state: {} as any,
  };
  const conv = {
    _id: "conversations_parked", user_id: "users_owner", session_id: "session-parked", agent_type: "claude_code",
    owner_device_id: "mac", pending_api_error: true, pending_api_error_kind: "throttle",
    pending_api_error_at: now - 5 * 60_000, updated_at: now - 5 * 60_000,
  };
  const tables: Record<string, any[]> = { devices: [device], conversations: [conv], daemon_commands: [], pending_messages: [] };
  const db = makeFakeDb(tables);
  const scheduler = { async runAt() {}, async runAfter() {} };
  const tick = () => (throttleContinueCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
  return { device, tables, tick };
}

describe("paced continue while an earlier continue is still undelivered", () => {
  test("a tick a minute later does not queue a second continue for the same conversation", async () => {
    const start = Date.parse("2026-09-14T12:00:02Z");
    setSystemTime(new Date(start));
    const f = fixture(start);
    await f.tick();
    const afterFirst = f.tables.pending_messages.filter((m) => m.content === "continue");
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].status).toBe("pending");

    // Still parked, still undelivered, one minute on: the next paced tick.
    setSystemTime(new Date(start + 60_000));
    f.device.last_seen = start + 60_000;
    await f.tick();
    const continues = f.tables.pending_messages.filter((m) => m.content === "continue");
    expect(continues).toHaveLength(1);
  });

  test("a delivered continue that re-parks waits for backoff, not the next minute", async () => {
    const start = Date.parse("2026-09-14T12:00:02Z");
    setSystemTime(new Date(start));
    const f = fixture(start);
    await f.tick();
    expect(f.tables.pending_messages.filter((m) => m.content === "continue")).toHaveLength(1);
    expect(f.device.cc_auto_switch_state.attempts?.some((a: any) => a.profile.startsWith("throttle-continue:"))).toBe(true);
    f.tables.pending_messages[0].status = "complete";
    setSystemTime(new Date(start + 60_000));
    f.device.last_seen = start + 60_000;
    await f.tick();
    expect(f.tables.pending_messages.filter((m) => m.content === "continue")).toHaveLength(1);
  });

  test("a painted auto-switch client id does not bypass the undelivered guard", async () => {
    const now = Date.parse("2026-09-15T14:00:00Z");
    const conv = {
      _id: "conversations_limit",
      user_id: "users_owner",
      session_id: "session-limit",
      agent_type: "claude_code",
      owner_device_id: "mac",
      pending_api_error: true,
      pending_api_error_kind: "limit",
      pending_api_error_at: now - 5 * 60_000,
      updated_at: now - 5 * 60_000,
    };
    const device = {
      _id: "devices_primary",
      user_id: "users_owner",
      device_id: "mac",
      last_seen: now,
      cc_auto_continue: true,
    };
    const tables: Record<string, any[]> = {
      devices: [device],
      conversations: [conv],
      daemon_commands: [],
      pending_messages: [
        { conversation_id: conv._id, content: "continue", status: "pending", client_id: "old" },
      ],
    };
    const db = makeFakeDb(tables);
    await insertSwitchCommands({ db }, "users_owner" as any, {
      blocked: [conv] as any,
      online: [device] as any,
      primary: device as any,
      continueBlocked: true,
      now,
      continueClientIds: { [conv._id]: `auto-switch-continue-${conv._id}-${Math.floor(now / 60_000)}` },
    });
    expect(tables.pending_messages.filter((m) => m.content === "continue")).toHaveLength(1);
  });
});
