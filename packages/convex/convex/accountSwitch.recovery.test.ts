import { describe, expect, test } from "bun:test";
import { autoSwitchCheck, onFreshApiErrorPark, reclassifyParkedApiErrorFlags, reviveAuthBlockedOnRemotes, throttleContinueCheck } from "./accountSwitch";
import { AUTO_SWITCH_CODEX_CONTINUE_KEY, AUTO_SWITCH_CONTINUE_KEY, authRestartAttemptKey, resetCreditAttemptKey } from "./ccAccountsShared";
import { blockedKindsForAgent } from "@codecast/shared/contracts";
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

// ct-49676. Before this, isBlockedConversation admitted a codex row only for a
// safety banner, so a Codex session parked on its plan limit never reached
// autoSwitchCheck at all: no continue, no reset-credit redeem, nothing. These
// drive the real handler to prove the park now arrives AND that it is decided
// against Codex's own account rather than the Claude one sitting next to it.
describe("Codex limit parks through the backend handler", () => {
  function codexFixture(opts: { credit?: number; optIn?: boolean; codexResetsAt?: number } = {}) {
    const f = fixture();
    (f.device as any).codex_accounts = {
      active_email: "codex@example.com",
      active_since: f.now - 600_000,
      profiles: [{
        name: "codex-a",
        email: "codex@example.com",
        usage: {
          fetched_at: f.now - 1_000,
          session: { percent: 100, resets_at: opts.codexResetsAt ?? f.now + 3_600_000 },
          ...(opts.credit ? { reset_credits: { available: opts.credit } } : {}),
        },
      }],
    } as any;
    if (opts.optIn) (f.device as any).settings = { codex_reset_credit_auto: true };
    // A codex session never carries `cc_account`: the daemon gates that pin on
    // agentType "claude", so a plain continue always reaches it.
    const park = (id = "conversations_codex") =>
      f.conversation(id, "limit", { agent_type: "codex", cc_account: undefined });
    return { ...f, park };
  }
  const commandArgs = (f: any) => f.tables.daemon_commands.map((c: any) => JSON.parse(c.args));

  test("a parked Codex row reaches the loop instead of falling out as 'nothing blocked'", async () => {
    const f = codexFixture();
    f.tables.conversations.push(f.park());
    const res = await f.run();
    // The park is SEEN: the loop decided about it (its window is pegged and
    // there is nothing else to try) rather than reporting nothing blocked.
    expect(res).toMatchObject({ acted: "exhausted" });
    expect((res as any).next_check_at).toBe(f.now + 3_600_000 + 2 * 60_000); // Codex's reset, not Claude's
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("the reset credit is offered only with the opt-in on", async () => {
    const off = codexFixture({ credit: 2 });
    off.tables.conversations.push(off.park());
    expect(await off.run()).toMatchObject({ acted: "exhausted" });
    expect(off.tables.daemon_commands).toHaveLength(0);

    const on = codexFixture({ credit: 2, optIn: true });
    const park = on.park();
    on.tables.conversations.push(park);
    expect(await on.run()).toMatchObject({ acted: "redeem_reset_credit", profile: "codex-a", conversations: 1 });
    expect(commandArgs(on)[0]).toMatchObject({
      codex_reset_credit: { profile: "codex-a" },
      conversation_ids: [park._id],
      continue_blocked: true,
    });
    expect(on.device.cc_auto_switch_state.attempts).toContainEqual({ profile: resetCreditAttemptKey("codex-a"), at: expect.any(Number) });
    // Once per park: a redeem still settling must not trigger a second one.
    expect(await on.run()).toEqual({ acted: "cooldown" });
    expect(on.tables.daemon_commands).toHaveLength(1);
  });

  test("a Codex park never spends a Claude account — a Claude swap cannot reach it", async () => {
    const f = codexFixture();
    f.device.cc_auto_switch = true;
    f.device.cc_accounts.profiles.push({
      name: "spare", email: "spare@example.com", token: { expires_at: f.now + 86_400_000 },
      usage: { fetched_at: f.now, session: { percent: 4, resets_at: f.now + 3_600_000 } },
    } as any);
    f.tables.conversations.push(f.park());
    expect(await f.run()).toMatchObject({ acted: "exhausted" });
    // The idle Claude account with 4% used is right there and must stay put.
    expect(commandArgs(f).some((a: any) => a.profile === "spare")).toBe(false);
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("the free continue reads CODEX's window, not the healthy Claude one beside it", async () => {
    // Claude's account has headroom the whole time; only the codex window
    // moving is allowed to un-park a codex session. Continuing on Claude's
    // meter would send it straight back into its own spent window.
    const pegged = codexFixture();
    pegged.device.cc_accounts.profiles[0].usage = { fetched_at: pegged.now, session: { percent: 5, resets_at: pegged.now + 3_600_000 } } as any;
    pegged.tables.conversations.push(pegged.park());
    expect(await pegged.run()).toMatchObject({ acted: "exhausted" });
    expect(pegged.db._inserted.filter((i: any) => i.table === "pending_messages")).toHaveLength(0);

    // Same machine, codex's own window has now rolled: continue for free.
    const rolled = codexFixture({ codexResetsAt: Date.now() - 10_000 });
    const park = rolled.park();
    rolled.tables.conversations.push(park);
    expect(await rolled.run()).toMatchObject({ acted: "codex_continue", conversations: 1 });
    const sent = rolled.db._inserted.filter((i: any) => i.table === "pending_messages");
    expect(sent.map((i: any) => i.doc.conversation_id)).toEqual([park._id]);
    expect(sent[0].doc.content).toBe("continue");
    expect(rolled.tables.daemon_commands).toHaveLength(0); // a message, not a restart: codex carries no pin
  });

  test("the two providers' free continues are independent", async () => {
    // A Claude continue moments ago must not consume Codex's one free continue.
    const f = codexFixture({ codexResetsAt: Date.now() - 10_000 });
    f.device.cc_auto_switch_state = { attempts: [{ profile: AUTO_SWITCH_CONTINUE_KEY, at: f.now }] } as any;
    f.tables.conversations.push(f.park());
    expect(await f.run()).toMatchObject({ acted: "codex_continue" });
    expect(f.device.cc_auto_switch_state.attempts).toContainEqual({ profile: AUTO_SWITCH_CODEX_CONTINUE_KEY, at: expect.any(Number) });

    // And its own key does hold it back, so the codex continue is once per park.
    const already = codexFixture({ codexResetsAt: Date.now() - 10_000 });
    already.device.cc_auto_switch_state = { attempts: [{ profile: AUTO_SWITCH_CODEX_CONTINUE_KEY, at: already.now }] } as any;
    already.tables.conversations.push(already.park());
    expect(await already.run()).toMatchObject({ acted: "exhausted" });
  });

  test("with both parked, the next look is booked on whichever window rolls first", async () => {
    // Codex resets in 30 minutes, Claude in three hours, and neither can act
    // yet. Sleeping the Codex park on Claude's clock is the 2026-09-03 "booked
    // at the wrong account's reset" gap one provider over.
    const f = codexFixture({ codexResetsAt: Date.now() + 30 * 60_000 });
    f.device.cc_accounts.profiles[0].usage = { fetched_at: f.now, session: { percent: 100, resets_at: f.now + 3 * 3_600_000 } } as any;
    f.tables.conversations.push(f.park(), f.conversation("conversations_claude", "limit", { cc_account: undefined }));
    const res = await f.run();
    expect(res).toMatchObject({ acted: "exhausted" });
    expect((res as any).next_check_at).toBe(f.now + 30 * 60_000 + 2 * 60_000);
    expect(f.tables.daemon_commands).toHaveLength(0);
  });

  test("a Claude action books the follow-up that comes back for the Codex park", async () => {
    // Both parked, Claude's window rolled: Claude recovers first (one action
    // per cooldown), and the Codex rows are already stamped, so nothing else
    // would ever wake the loop for them.
    const f = codexFixture();
    f.device.cc_accounts.profiles[0].usage = { fetched_at: f.now, session: { percent: 100, resets_at: f.now - 5_000 } } as any;
    f.tables.conversations.push(f.park(), f.conversation("conversations_claude", "limit", { cc_account: undefined }));
    expect(await f.run()).toMatchObject({ acted: "continue", conversations: 1 });
    // Only the Claude row was continued.
    const sent = f.db._inserted.filter((i: any) => i.table === "pending_messages");
    expect(sent.map((i: any) => i.doc.conversation_id)).toEqual(["conversations_claude"]);
    const followUp = f.now + 3 * 60_000 + 5_000;
    expect(f.device.cc_auto_switch_state.next_check_at).toBe(followUp);
    expect(f.scheduled.some((s) => s.at === followUp)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ct-49793 — codex plan-window parks stamped before the classifier could read
// codex's structured code. They hold only the provider's prose, so they never
// heal on their own; reclassifyParkedApiErrorFlags is the one-off that frees
// them, and it must do so without disturbing anything else.
// ─────────────────────────────────────────────────────────────────────────────

// Verbatim from the four stranded production rows (ct-49676 found them live).
const STRANDED_CODEX_LIMIT_BANNER =
  "⚠ Turn stopped: You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Sep 12th, 2026 9:10 PM.";

describe("classifying a stranded codex plan-window park", () => {
  test("the production banner reads as a limit park", () => {
    expect(classifyApiErrorBanner(STRANDED_CODEX_LIMIT_BANNER)).toBe("limit");
  });

  test("the per-minute cap is NOT swept up with it", () => {
    // Codex sends the identical opening sentence for rate_limit_exceeded. Only
    // the purchase-credits remedy means the plan window is spent, so the bare
    // sentence must stay out of "limit" — reading a burst as a quota park is
    // what sent the fleet rotating accounts on 2026-09-04.
    expect(classifyApiErrorBanner("⚠ Turn stopped: You've hit your usage limit.")).toBe("error");
    expect(classifyApiErrorBanner("⚠ Turn stopped: You've hit your usage limit. Try again in 3 minutes.")).toBe("error");
    expect(
      classifyApiErrorBanner("⚠ Turn stopped: You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again later."),
    ).toBe("error");
  });

  test("the marker is what makes matching the prose safe", () => {
    // The same words in an ordinary assistant turn are not a banner at all.
    expect(
      classifyApiErrorBanner("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits."),
    ).toBe(null);
  });

  test("the other marked client-error kinds are unchanged", () => {
    expect(classifyApiErrorBanner("⚠ Turn stopped: no API key configured for provider anthropic")).toBe("auth");
    expect(classifyApiErrorBanner("⚠ Turn stopped: the model returned an empty response")).toBe("error");
  });
});

function parkFixture() {
  const now = Date.now();
  const tables: Record<string, any[]> = { conversations: [], messages: [] };
  const db = makeFakeDb(tables);
  let seq = 0;
  const park = (id: string, extra: Record<string, unknown> = {}, banner = STRANDED_CODEX_LIMIT_BANNER) => {
    tables.conversations.push({
      _id: id, user_id: "users_owner", agent_type: "codex", status: "active",
      pending_api_error: true, pending_api_error_kind: "error", pending_api_error_at: now - 60_000,
      updated_at: now - 60_000, title: id, ...extra,
    });
    tables.messages.push({
      _id: `messages_${++seq}`, conversation_id: id, role: "assistant", content: banner, timestamp: now - 60_000,
    });
    return id;
  };
  const run = (args: Record<string, unknown> = {}) =>
    (reclassifyParkedApiErrorFlags as any)._handler({ db }, args);
  return { now, tables, db, park, run };
}

describe("reclassifyParkedApiErrorFlags", () => {
  test("a dry run names the rows and writes nothing", async () => {
    const f = parkFixture();
    f.park("conversations_a");
    f.park("conversations_b");
    const res = await f.run();
    expect(res).toMatchObject({ dry_run: true, scanned: 2, changed: 2, is_done: true });
    expect(res.changes.map((c: any) => c.id).sort()).toEqual(["conversations_a", "conversations_b"]);
    expect(res.changes[0]).toMatchObject({ from: "error", to: "limit", agent_type: "codex" });
    // The point of a dry run: the rows still say what they said.
    expect(f.tables.conversations.every((c) => c.pending_api_error_kind === "error")).toBe(true);
  });

  test("dry run is what you get unless you ask for a write", async () => {
    const f = parkFixture();
    f.park("conversations_a");
    expect((await f.run({})).dry_run).toBe(true);
    expect((await f.run({ dry_run: true })).dry_run).toBe(true);
    expect(f.tables.conversations[0].pending_api_error_kind).toBe("error");
  });

  test("a real run re-stamps the park, and running it again changes nothing", async () => {
    const f = parkFixture();
    f.park("conversations_a");
    const first = await f.run({ dry_run: false });
    expect(first).toMatchObject({ dry_run: false, changed: 1 });
    expect(f.tables.conversations[0]).toMatchObject({
      pending_api_error: true, pending_api_error_kind: "limit", pending_api_error_at: f.now - 60_000,
    });
    // Idempotent: the second pass finds nothing left to do.
    const second = await f.run({ dry_run: false });
    expect(second.changed).toBe(0);
    expect(second.changes).toEqual([]);
  });

  test("the pass is bounded and resumes from its cursor", async () => {
    const f = parkFixture();
    for (let i = 0; i < 5; i++) f.park(`conversations_${i}`);
    const first = await f.run({ batch: 2 });
    expect(first).toMatchObject({ scanned: 2, changed: 2, is_done: false });
    const second = await f.run({ batch: 2, cursor: first.cursor });
    expect(second).toMatchObject({ scanned: 2, is_done: false });
    // The second page reaches rows the first did not.
    const seen = [...first.changes, ...second.changes].map((c: any) => c.id);
    expect(new Set(seen).size).toBe(4);
    const third = await f.run({ batch: 2, cursor: second.cursor });
    expect(third.is_done).toBe(true);
  });

  test("an operator cannot ask for an unbounded pass", async () => {
    // The hard cap is the whole reason this exists: the sibling backfill reads
    // 1000 rows in one transaction and dies on prod with "too many system
    // operations". A caller asking for more must still get a bounded page.
    const f = parkFixture();
    for (let i = 0; i < 520; i++) f.park(`conversations_${i}`);
    const huge = await f.run({ batch: 10_000 });
    expect(huge.scanned).toBe(500);
    expect(huge.is_done).toBe(false);
    // And the default is smaller still.
    expect((await f.run({})).scanned).toBe(100);
  });

  test("a nonsense batch size is coerced, never trusted", async () => {
    const f = parkFixture();
    for (let i = 0; i < 12; i++) f.park(`conversations_${i}`);
    expect((await f.run({ batch: 0 })).scanned).toBe(1);
    expect((await f.run({ batch: -5 })).scanned).toBe(1);
    expect((await f.run({ batch: 3.7 })).scanned).toBe(3);
  });

  test("a session the human already continued is left alone", async () => {
    const f = parkFixture();
    f.park("conversations_continued");
    // A real turn after the banner: the session moved on under its own power.
    f.tables.messages.push({
      _id: "messages_later", conversation_id: "conversations_continued", role: "assistant",
      content: "Picking the migration back up.", timestamp: f.now - 10_000,
    });
    const res = await f.run({ dry_run: false });
    expect(res.changed).toBe(0);
    expect(f.tables.conversations[0].pending_api_error_kind).toBe("error");
  });

  test("a killed or completed session is left alone", async () => {
    const f = parkFixture();
    f.park("conversations_killed", { inbox_killed_at: f.now - 5_000 });
    f.park("conversations_done", { status: "completed" });
    const res = await f.run({ dry_run: false });
    expect(res).toMatchObject({ changed: 0, skipped_settled: 2 });
    expect(f.tables.conversations.every((c) => c.pending_api_error_kind === "error")).toBe(true);
  });

  test("a park of another kind keeps its own stamp", async () => {
    const f = parkFixture();
    f.park("conversations_auth", { pending_api_error_kind: "auth" }, "Login expired · Please run /login");
    f.park("conversations_throttle", { pending_api_error_kind: "throttle" },
      "Rate limited · the request burst exceeded the account's per-minute rate limit · retried automatically");
    const res = await f.run({ dry_run: false });
    expect(res.changed).toBe(0);
    expect(f.tables.conversations.map((c) => c.pending_api_error_kind)).toEqual(["auth", "throttle"]);
  });

  test("a re-stamped codex park is admitted by the recovery loop", async () => {
    // The whole point: kind "error" is outside the blocked set for every agent,
    // and "limit" is inside codex's. Re-stamping is what puts the row in front
    // of autoSwitchCheck.
    expect(blockedKindsForAgent("codex").has("error")).toBe(false);
    expect(blockedKindsForAgent("codex").has("limit")).toBe(true);
  });
});
