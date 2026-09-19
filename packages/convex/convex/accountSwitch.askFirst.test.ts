import { describe, expect, test } from "bun:test";
import { autoSwitchCheck } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

// Ask-first recovery: a usage limit must never move the machine's login on its
// own. The loop records what it RECOMMENDS and waits for the human to approve
// through the ordinary requestAccountSwitch path. The regression these guard is
// the one that prompted the mode: on 2026-09-17 a machine rotated its login
// five times in nineteen minutes with nobody asking for any of it.

function fixture(deviceOverrides: Record<string, unknown> = {}) {
  const now = Date.now();
  const device = {
    _id: "devices_primary",
    user_id: "users_owner",
    device_id: "mac",
    last_seen: now,
    cc_auto_continue: true,
    cc_auto_switch: false,
    cc_recovery_ask: true,
    cc_accounts: {
      active_email: "spent@example.com",
      active_since: now - 6 * 3_600_000,
      profiles: [
        {
          name: "spent",
          email: "spent@example.com",
          // Pegged and not yet reset: no headroom, so the loop reaches the
          // switch decision rather than a free continue.
          usage: {
            fetched_at: now - 1_000,
            session: { percent: 100, resets_at: now + 3_600_000 },
            weekly_scoped: { percent: 100, resets_at: now + 86_400_000, label: "Fable" },
          },
        },
        {
          name: "fresh",
          email: "fresh@example.com",
          usage: {
            fetched_at: now - 1_000,
            session: { percent: 4, resets_at: now + 3_600_000 },
            weekly: { percent: 41, resets_at: now + 86_400_000 },
          },
        },
      ],
    },
    cc_auto_switch_state: {} as any,
    ...deviceOverrides,
  };
  const parked = {
    _id: "conversations_p1",
    user_id: "users_owner",
    session_id: "session-p1",
    agent_type: "claude_code",
    owner_device_id: "mac",
    pending_api_error: true,
    pending_api_error_kind: "limit",
    pending_api_error_at: now - 30_000,
    updated_at: now - 30_000,
  };
  const tables: Record<string, any[]> = {
    users: [{ _id: "users_owner", name: "Owner" }],
    notifications: [],
    devices: [device],
    conversations: [parked],
    daemon_commands: [],
    pending_messages: [],
  };
  const db = makeFakeDb(tables);
  const scheduler = { async runAt() {}, async runAfter() {} };
  const run = () => (autoSwitchCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
  return { now, device, tables, db, run };
}

describe("ask-first recovery", () => {
  test("a limit park proposes the freshest account and changes NOTHING", async () => {
    const f = fixture();
    const res = await f.run();

    expect(res).toMatchObject({ acted: "proposed", profile: "fresh" });
    // The machine did not move: no switch command, and no continue was sent.
    expect(f.tables.daemon_commands).toHaveLength(0);
    expect(f.tables.pending_messages).toHaveLength(0);
    expect(f.device.cc_accounts.active_email).toBe("spent@example.com");
    // The session stays parked for the human to act on.
    expect(f.tables.conversations[0].pending_api_error).toBe(true);
  });

  test("the proposal records WHY, so the card can explain it", async () => {
    const f = fixture();
    await f.run();

    const d = f.device.cc_auto_switch_state.last_decision;
    expect(d.kind).toBe("propose");
    expect(d.target_name).toBe("fresh");
    expect(d.target_email).toBe("fresh@example.com");
    expect(d.from_email).toBe("spent@example.com");
    expect(d.parked_count).toBe(1);
    // The window the human sees closed on the meter — named, not guessed.
    expect(d.pegged_window).toBe("Fable (7d)");
    // The target's standing is the one the bars show for that account.
    expect(Math.round(d.target_percent)).toBe(41);
  });

  test("re-checking does not stamp a new proposal when the recommendation is unchanged", async () => {
    const f = fixture();
    await f.run();
    const first = f.device.cc_auto_switch_state.last_decision;
    await f.run();
    // Same object identity: the row was not re-patched for an identical ask.
    expect(f.device.cc_auto_switch_state.last_decision).toBe(first);
  });

  test("auto mode still switches without asking — ask-first is the only gate", async () => {
    const f = fixture({ cc_recovery_ask: false, cc_auto_switch: true });
    const res = await f.run();

    expect(res).toMatchObject({ acted: "switch", profile: "fresh" });
    expect(f.tables.daemon_commands).toHaveLength(1);
    // And the switch records the same reason a proposal would have.
    const d = f.device.cc_auto_switch_state.last_decision;
    expect(d.kind).toBe("switch");
    expect(d.target_name).toBe("fresh");
    expect(d.pegged_window).toBe("Fable (7d)");
  });

  test("ask-first with no account to offer falls through to exhausted, never a silent switch", async () => {
    const f = fixture();
    // Peg the only alternative too.
    f.device.cc_accounts.profiles[1].usage = {
      fetched_at: f.now - 1_000,
      session: { percent: 100, resets_at: f.now + 3_600_000 },
    } as any;
    const res = await f.run();

    expect(res).toMatchObject({ acted: "exhausted" });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });
});

describe("the ask reaches the person, once, and does not outlive its incident", () => {
  test("a new proposal writes a notification; an unchanged re-check does not", async () => {
    const f = fixture();
    await f.run();
    const notes = () => f.tables.notifications;
    expect(notes()).toHaveLength(1);
    expect(notes()[0].message).toStartWith("Switch to fresh? ");
    expect(notes()[0].message).toContain("Fable (7d) hit its limit");
    await f.run();
    expect(notes()).toHaveLength(1);
  });

  test("once nothing is parked, the stale proposal is cleared", async () => {
    const f = fixture();
    await f.run();
    expect(f.device.cc_auto_switch_state.last_decision.kind).toBe("propose");
    f.tables.conversations[0].pending_api_error = false;
    f.tables.conversations[0].pending_api_error_kind = undefined;
    const res = await f.run();
    expect(res).toMatchObject({ acted: "nothing_blocked" });
    expect(f.device.cc_auto_switch_state.last_decision).toBeUndefined();
  });
});
