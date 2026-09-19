import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { autoSwitchCheck } from "./accountSwitch";
import { enqueuePendingMessage } from "./pendingMessages";
import { AUTO_CONTINUE_WINDOW_MS, AUTO_SWITCH_CONTINUE_KEY } from "./ccAccountsShared";
import { makeFakeDb } from "./testDb";

afterEach(() => setSystemTime());

function fixture() {
  const now = Date.parse("2026-09-19T15:04:37.390Z");
  setSystemTime(new Date(now));
  const activation = Date.parse("2026-09-19T15:01:34.705Z");
  const device = {
    _id: "devices_primary", user_id: "users_owner", device_id: "mac", last_seen: now,
    cc_auto_switch: true, cc_recovery_ask: false,
    cc_accounts: {
      active_email: "claude3@example.com", active_since: activation,
      profiles: [
        { name: "claude3", email: "claude3@example.com", token: { expires_at: now + 86_400_000 },
          usage: { fetched_at: activation + 2_000, session: { percent: 7, resets_at: now + 3_600_000 } } },
        { name: "claude2", email: "claude2@example.com", token: { expires_at: now + 86_400_000 },
          usage: { fetched_at: now - 10_000, session: { percent: 96, resets_at: now + 3_600_000 } } },
      ],
    },
    cc_auto_switch_state: {
      last_action_at: activation - 2_320,
      attempts: [{ profile: "claude3", at: activation - 2_320 }],
    } as any,
  };
  const conversation = {
    _id: "conversations_parked", user_id: "users_owner", session_id: "session-parked", owner_device_id: "mac",
    agent_type: "claude_code", cc_account: "claude3", pending_api_error: true, pending_api_error_kind: "limit",
    pending_api_error_at: Date.parse("2026-09-19T15:00:38.430Z"), updated_at: now - 240_000,
  };
  const tables: Record<string, any[]> = { devices: [device], conversations: [conversation], daemon_commands: [], pending_messages: [] };
  const db = makeFakeDb(tables);
  const scheduled: number[] = [];
  const ctx = { db, scheduler: { async runAt(at: number) { scheduled.push(at); }, async runAfter() {} } };
  const run = () => (autoSwitchCheck as any)._handler(ctx, { user_id: "users_owner" });
  return { now, activation, device, conversation, tables, ctx, run, scheduled };
}

describe("account recovery keeps limit evidence separate from activity", () => {
  test("a paced continue cannot turn an old park into a limit on the new account", async () => {
    const f = fixture();
    setSystemTime(new Date(f.now - 3_725));
    await enqueuePendingMessage(f.ctx as any, f.conversation as any, "users_owner" as any, {
      content: "continue", client_id: "first-switch-continue",
    });
    expect(f.conversation.updated_at).toBe(f.now - 3_725);
    expect(f.conversation.pending_api_error_at).toBeLessThan(f.activation);
    setSystemTime(new Date(f.now));
    expect(await f.run()).toMatchObject({ acted: "continue" });
    expect(f.tables.daemon_commands).toHaveLength(0);
    expect(f.tables.pending_messages).toHaveLength(1);
    expect(f.conversation.cc_account).toBe("claude3");

    setSystemTime(new Date(f.now + 185_000));
    f.device.last_seen = Date.now();
    expect(await f.run()).toMatchObject({ acted: "wait" });
    expect(f.tables.daemon_commands).toHaveLength(0);
    expect(f.tables.pending_messages).toHaveLength(1);
    expect(f.scheduled.at(-1)).toBeGreaterThan(Date.now());
  });

  test("a new limit after recovery still switches and remembers the exhausted outgoing account", async () => {
    const f = fixture();
    f.device.cc_auto_switch_state.attempts.push({ profile: AUTO_SWITCH_CONTINUE_KEY, at: f.now - 185_000 });
    f.conversation.pending_api_error_at = f.now - 1_000;
    f.conversation.updated_at = f.now;
    f.device.cc_accounts.profiles[0].usage.session.percent = 100;
    expect(await f.run()).toMatchObject({ acted: "switch", profile: "claude2" });
    expect(f.device.cc_auto_switch_state.attempts).toContainEqual({ profile: "claude3", at: f.now });
    expect(f.device.cc_auto_switch_state.attempts).toContainEqual({ profile: "claude2", at: f.now });
    expect(JSON.parse(f.tables.daemon_commands[0].args).profile).toBe("claude2");
  });

  test("the Codex pass also uses the original park when later activity changes updated_at", async () => {
    const f = fixture();
    f.conversation.agent_type = "codex";
    f.conversation.updated_at = f.now;
    Object.assign(f.device, { codex_accounts: f.device.cc_accounts });
    expect(await f.run()).toMatchObject({ acted: "codex_continue" });
    expect(f.tables.pending_messages).toHaveLength(1);
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("recent activity does not revive an expired incident in resume-only mode", async () => {
    const f = fixture();
    f.device.cc_auto_switch = false;
    f.conversation.pending_api_error_at = f.now - AUTO_CONTINUE_WINDOW_MS - 1;
    f.conversation.updated_at = f.now;
    expect(await f.run()).toMatchObject({ acted: "nothing_blocked" });
    expect(f.tables.pending_messages).toHaveLength(0);
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("a legacy park without a dedicated timestamp still uses its activity timestamp", async () => {
    const f = fixture();
    delete (f.conversation as any).pending_api_error_at;
    f.conversation.updated_at = f.activation - 10_000;
    expect(await f.run()).toMatchObject({ acted: "continue" });
  });
});
