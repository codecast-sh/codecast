import { describe, expect, test } from "bun:test";
import { autoSwitchCheck, onFreshApiErrorPark, reviveAuthBlockedOnRemotes, throttleContinueCheck } from "./accountSwitch";
import { authRestartAttemptKey } from "./ccAccountsShared";
import { classifyApiErrorBanner } from "./inboxFilters";
import { makeFakeDb } from "./testDb";

function fixture() {
  const now = Date.now();
  const device = {
    _id: "devices_primary", user_id: "users_owner", device_id: "mac", last_seen: now,
    cc_auto_continue: true, cc_auto_switch: false,
    cc_accounts: {
      active_email: "current@example.com", active_since: now - 600_000,
      profiles: [{ name: "current", email: "current@example.com", token: { expires_at: now + 86_400_000 },
        usage: { fetched_at: now - 1_000, session: { percent: 100, resets_at: now + 3_600_000 } } }],
    },
    cc_auto_switch_state: {} as any,
  };
  const conversation = (id: string, kind = "auth", extra = {}) => ({
    _id: id, user_id: "users_owner", session_id: `session-${id}`, agent_type: "claude_code",
    owner_device_id: "mac", pending_api_error: true, pending_api_error_kind: kind,
    pending_api_error_at: now - 30_000, updated_at: now - 30_000, cc_account: "previous", ...extra,
  });
  const tables: Record<string, any[]> = { devices: [device], conversations: [], daemon_commands: [], pending_messages: [] };
  const db = makeFakeDb(tables);
  const scheduled: Array<{ at?: number; delay?: number }> = [];
  const scheduler = {
    async runAt(at: number) { scheduled.push({ at }); },
    async runAfter(delay: number) { scheduled.push({ delay }); },
  };
  const run = () => (autoSwitchCheck as any)._handler({ db, scheduler }, { user_id: "users_owner" });
  return { now, device, conversation, tables, db, scheduler, scheduled, run };
}

describe("burst-throttle recovery through the backend handler", () => {
  test("a throttle park books one paced continue check and never the switch loop", async () => {
    const f = fixture();
    const kind = classifyApiErrorBanner("Rate limited · the request burst exceeded the account's per-minute rate limit · retried automatically · Claude Code showed: You've reached your Fable limit.");
    expect(kind).toBe("throttle");
    await onFreshApiErrorPark({ db: f.db, scheduler: f.scheduler }, "users_owner" as any, kind!);
    expect(f.scheduled).toEqual([{ delay: 60_000 }, { delay: 60_000 }]); // the check + the blocked-notify debounce
    expect(f.device.cc_auto_switch_state.throttle_check_at).toBeGreaterThan(f.now);
    // A second park while the check is booked adds nothing.
    await onFreshApiErrorPark({ db: f.db, scheduler: f.scheduler }, "users_owner" as any, kind!);
    expect(f.scheduled.filter((s) => s.delay === 60_000)).toHaveLength(3);
    expect(f.scheduled.some((s) => s.delay === 45_000)).toBe(false);
  });

  test("the check continues due parks a few at a time and books the next tick for the rest", async () => {
    const f = fixture();
    const parked = (id: string, agoMs: number) =>
      f.conversation(id, "throttle", { pending_api_error_at: f.now - agoMs, updated_at: f.now - agoMs, cc_account: undefined });
    f.tables.conversations.push(
      parked("conversations_t1", 5 * 60_000), parked("conversations_t2", 4 * 60_000), parked("conversations_t3", 3 * 60_000),
      parked("conversations_t4", 2 * 60_000), parked("conversations_fresh", 10_000),
      f.conversation("conversations_limit", "limit"),
    );
    const res = await (throttleContinueCheck as any)._handler({ db: f.db, scheduler: f.scheduler }, { user_id: "users_owner" });
    expect(res).toMatchObject({ acted: "continued", continued: 3, remaining: 1, waiting: 1 });
    // Plain continues (the processes are alive at the prompt), oldest parks first, no switch command.
    const sent = f.db._inserted.filter((i: any) => i.table === "pending_messages");
    expect(sent.map((i: any) => i.doc.conversation_id)).toEqual(["conversations_t1", "conversations_t2", "conversations_t3"]);
    expect(sent.every((i: any) => i.doc.content === "continue")).toBe(true);
    expect(f.tables.daemon_commands).toHaveLength(0);
    expect(f.scheduled.some((s) => s.at === f.now + 20_000 || (s.at! >= f.now + 19_000 && s.at! <= f.now + 21_000))).toBe(true);
    expect(f.device.cc_auto_switch_state.throttle_check_at).toBeGreaterThan(f.now);
  });
});

describe("auth recovery through the backend handler", () => {
  test("login banner queues a restart on the current account despite another session's usage limit", async () => {
    const f = fixture();
    const kind = classifyApiErrorBanner("Not logged in · Please run /login");
    expect(kind).toBe("auth");
    await onFreshApiErrorPark({ scheduler: f.scheduler }, "users_owner" as any, kind!);
    expect(f.scheduled.some((s) => s.delay === 45_000)).toBe(true);
    const auth = f.conversation("conversations_auth", kind!);
    f.tables.conversations.push(auth, f.conversation("conversations_limit", "limit"));
    expect(await f.run()).toEqual({ acted: "auth_restart", conversations: 1 });
    const command = f.tables.daemon_commands[0];
    expect(command.command).toBe("switch_account");
    expect(command.target_device_id).toBe("mac");
    expect(JSON.parse(command.args)).toMatchObject({
      conversation_ids: [auth._id], session_ids: { [auth._id]: auth.session_id }, continue_blocked: true,
    });
    expect(JSON.parse(command.args).profile).toBeUndefined();
    expect(auth.cc_account).toBe("current");
    expect(f.device.cc_auto_switch_state.attempts).toContainEqual({ profile: authRestartAttemptKey(auth._id), at: expect.any(Number) });
    expect(f.scheduled.some((s) => s.at! > f.now)).toBe(true);
    expect(await f.run()).toEqual({ acted: "cooldown" });
    expect(f.tables.daemon_commands).toHaveLength(1);
  });

  test("an unrelated session parking after an earlier retry gets its own restart", async () => {
    const f = fixture();
    f.device.cc_auto_switch_state = { attempts: [{ profile: authRestartAttemptKey("conversations_old"), at: f.now - 300_000 }] };
    f.tables.conversations.push(f.conversation("conversations_new"));
    expect(await f.run()).toEqual({ acted: "auth_restart", conversations: 1 });
    expect(JSON.parse(f.tables.daemon_commands[0].args).profile).toBeUndefined();
  });

  test("a remote or another local machine cannot invalidate this machine's login", async () => {
    const f = fixture();
    f.device.cc_auto_switch = true;
    f.tables.devices.push({ _id: "devices_other", user_id: "users_owner", device_id: "other", last_seen: f.now - 1 });
    f.tables.conversations.push(f.conversation("conversations_other", "auth", { owner_device_id: "other" }),
      f.conversation("conversations_remote", "auth", { owner_device_id: "remote" }));
    expect(await f.run()).toEqual({ acted: "nothing_blocked" });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("waits for a fresh login probe and retries when it arrives", async () => {
    const f = fixture();
    f.device.cc_accounts.profiles[0].usage.fetched_at = f.device.cc_accounts.active_since - 1;
    f.tables.conversations.push(f.conversation("conversations_auth"));
    expect(await f.run()).toMatchObject({ acted: "wait" });
    expect(f.tables.daemon_commands).toHaveLength(0);
    f.device.cc_accounts.profiles[0].usage.fetched_at = f.now;
    expect(await f.run()).toEqual({ acted: "auth_restart", conversations: 1 });
  });

  test("respects opt-out, dismissed work, subagents, and other backends", async () => {
    const f = fixture();
    f.device.cc_auto_continue = false;
    f.tables.conversations.push(f.conversation("conversations_auth"));
    expect(await f.run()).toEqual({ acted: "off" });
    f.device.cc_auto_continue = true;
    f.tables.conversations.splice(0, 1,
      f.conversation("conversations_dismissed", "auth", { inbox_dismissed_at: f.now }),
      f.conversation("conversations_sub", "auth", { is_subagent: true }),
      f.conversation("conversations_codex", "auth", { agent_type: "codex" }));
    expect(await f.run()).toEqual({ acted: "nothing_blocked" });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("remote credential recovery handles a fleet without remote devices", async () => {
    const f = fixture();
    f.tables.conversations.push(f.conversation("conversations_auth"));
    const auth = { async getUserIdentity() { return { subject: "users_owner|session" }; } };
    expect(await (reviveAuthBlockedOnRemotes as any)._handler({ db: f.db, auth }, {})).toEqual({ continued: 0 });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("a credential push revives only remote auth parks, once per incident bucket", async () => {
    const f = fixture();
    f.tables.devices.push({ _id: "devices_remote", user_id: "users_owner", device_id: "remote", is_remote: true });
    f.tables.conversations.push(f.conversation("conversations_local"),
      f.conversation("conversations_remote", "auth", { owner_device_id: "remote" }),
      f.conversation("conversations_limit", "limit", { owner_device_id: "remote" }));
    const auth = { async getUserIdentity() { return { subject: "users_owner|session" }; } };
    const run = () => (reviveAuthBlockedOnRemotes as any)._handler({ db: f.db, auth }, {});
    expect(await run()).toEqual({ continued: 1 });
    expect(await run()).toEqual({ continued: 1 });
    expect(f.tables.pending_messages).toHaveLength(1);
    expect(f.tables.pending_messages[0]).toMatchObject({ conversation_id: "conversations_remote", content: "continue" });
    expect(f.tables.daemon_commands).toHaveLength(0);
  });
});
