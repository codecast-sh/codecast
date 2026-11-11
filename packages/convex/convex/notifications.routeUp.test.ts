import { describe, expect, test } from "bun:test";
import {
  performNeedsInputCheck,
  performIdleDigestFlush,
  summarizeIdleDigest,
  IDLE_DIGEST_WINDOW_MS,
} from "./notifications";
import { applyPause, applyResume, ensureRoleNeedsInputTrigger, settleRunConversation } from "./agentTasks";
import { parseScheduledTask, runResultThreadOf } from "@codecast/shared/contracts";
import { performSetIdleSummary } from "./idleSummary";
import { performPushFlush } from "./pushRouter";

import { createCtx, settledIdleWorld, type Rec } from "./notifications.needsInput.testkit";

// The route up (org-staffing.md S28). A request for a person travels up the
// reporting line as ordinary messages: a hand that is blocked tells its role,
// a role's standing session that is blocked tells the role it reports to, and
// the role that reports to a person is that person's own card (the anchor
// rule), so it tells nobody. What it tells is the role's own needs-input
// trigger, one run per waiting episode, which the person pauses, edits and
// cancels like any trigger.
describe("the route up", () => {
  const now = Date.now();
  const org = () => ({
    teams: [{ _id: "team1", features: { org: true } }],
    org_roles: [
      { _id: "role_top", handle: "growth", name: "Growth lead", status: "active", team_id: "team1", anchor_id: "anchor_top", reports_to: { kind: "user", user_id: "u1" } },
      { _id: "role_sub", handle: "calling", name: "Calling lead", status: "active", team_id: "team1", anchor_id: "anchor_sub", reports_to: { kind: "role", role_id: "role_top" } },
    ],
    anchors: [
      { _id: "anchor_top", conversation_id: "standing_top", status: "active" },
      { _id: "anchor_sub", conversation_id: "standing_sub", status: "active" },
    ],
    pending_messages: [],
  });
  const standing = (id: string, role: string, extra: Rec = {}) => ({ _id: id, user_id: "u1", title: `${role} lead`, status: "active", message_count: 40, updated_at: now - 60_000, last_message_role: "assistant", standing_role_id: role, anchor_id: `anchor_${id.replace("standing_", "")}`, persistent: true, ...extra });
  const told = (tables: Record<string, Rec[]>, conv: string) => (tables.pending_messages ?? []).filter((m) => m.conversation_id === conv).map((m) => parseScheduledTask(m.content));
  const triggerOn = (tables: Record<string, Rec[]>, conv: string) => (tables.agent_tasks ?? []).find((t) => t.originating_conversation_id === conv && t.event_filter?.event_type === "session_needs_input");
  const blockedHand = () => {
    const world = settledIdleWorld({
      conv: { org_role_id: "role_sub", short_id: "jx7hand", thread_state_status: "blocked", thread_state: "Which price band for Texas?\nMore detail here.", thread_state_at: now - 30_000 },
      extra: { ...org(), agent_tasks: [] },
    });
    world.tables.conversations.push(standing("standing_top", "role_top"), standing("standing_sub", "role_sub"));
    return world;
  };

  test("a hand that declares itself blocked fires its role's trigger once, naming the session and the first line of its state", async () => {
    const { ctx, tables } = blockedHand();
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("under_role");
    const trigger = triggerOn(tables, "standing_sub")!;
    expect(told(tables, "standing_sub")).toEqual([{
      title: "A session under you needs input",
      task_id: trigger._id,
      trigger: trigger.short_id,
      event: "session_needs_input",
      waiting: { short_id: "jx7hand", title: "Fix the parser", why: "blocked", since: now - 30_000, state: "Which price band for Texas?" },
      // The run reminds the role who it is, read fresh at firing.
      role: { handle: "calling", name: "Calling lead", reports_to: "@growth", scope: [], goals: [] },
      body: trigger.prompt,
    }]);
    // A machine run, never a person's message.
    expect(tables.pending_messages[0].origin).toBe("scheduler");
    expect(trigger.run_count).toBe(1);
    expect(trigger.status).toBe("scheduled");
    expect(trigger.run_at).toBeUndefined();
    expect(told(tables, "standing_top")).toEqual([]);
  });

  test("one run per ask: a second check, a reason that changes while it waits, the same block declared again after more work, and the declaration itself add nothing", async () => {
    const { ctx, tables } = blockedHand();
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    // The process stops while the hand still waits on the same question.
    tables.managed_sessions[0].agent_status = "stopped";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(1);
    // More work that ends on the same pinned ask is the same request.
    tables.managed_sessions[0].agent_status = "idle";
    tables.conversations[0].message_count = 9;
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(1);
    // A new ask is a new request.
    tables.conversations[0].message_count = 12;
    tables.conversations[0].thread_state = "Which price band for Ohio?";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(2);
  });

  test("a permission prompt or a stopped process wakes the role only once it outlasts the grace; one that clears never does", async () => {
    for (const status of ["permission_blocked", "stopped"]) {
      const { ctx, tables, scheduled } = blockedHand();
      Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
      Object.assign(tables.managed_sessions[0], { agent_status: status, agent_status_updated_at: now - 10_000 });
      const statusTs = tables.managed_sessions[0].agent_status_updated_at;
      await performNeedsInputCheck(ctx as any, { conversation_id: "conv1", status_ts: statusTs });
      expect([status, told(tables, "standing_sub").length]).toEqual([status, 0]);
      const recheck = scheduled.find((s) => s.args.conversation_id === "conv1" && s.args.status_ts === statusTs)!;
      expect(recheck.delay).toBeGreaterThan(100_000);
      expect(recheck.delay).toBeLessThanOrEqual(110_000);
      // Still stuck when the grace runs out: the role hears it, once.
      tables.managed_sessions[0].agent_status_updated_at = Date.now() - 125_000;
      await performNeedsInputCheck(ctx as any, { conversation_id: "conv1", status_ts: tables.managed_sessions[0].agent_status_updated_at });
      expect(told(tables, "standing_sub").map((f) => f?.waiting?.why)).toEqual([status]);
    }
    // Cleared in between: the status moved, so the re-check is superseded.
    const { ctx, tables } = blockedHand();
    Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
    Object.assign(tables.managed_sessions[0], { agent_status: "permission_blocked", agent_status_updated_at: now - 10_000 });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1", status_ts: now - 10_000 });
    Object.assign(tables.managed_sessions[0], { agent_status: "working", agent_status_updated_at: now });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1", status_ts: now - 10_000 });
    expect(res.reason).toBe("superseded");
    expect(told(tables, "standing_sub")).toEqual([]);
  });

  test("a hand waiting on its own open decision is one ask: the block it declares after posting it tells the role nothing more", async () => {
    const { ctx, tables } = blockedHand();
    tables.session_decisions = [{ _id: "dec1", conversation_id: "conv1", status: "pending", question: "Which price band for Texas?" }];
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("under_role");
    expect(told(tables, "standing_sub")).toEqual([]);
    // Answered, the next block is a new ask and the role hears it.
    tables.session_decisions[0].status = "answered";
    tables.conversations[0].message_count = 9;
    tables.conversations[0].thread_state = "Which price band for Ohio?";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(1);
  });

  test("the person controls it: a paused or cancelled trigger fires nothing, an edited prompt is what the role reads, and a cancel is never re-armed", async () => {
    const { ctx, tables } = blockedHand();
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    const trigger = triggerOn(tables, "standing_sub")!;
    await applyPause(ctx as any, trigger as any);
    tables.conversations[0].message_count = 9;
    tables.conversations[0].thread_state = "Which price band for Ohio?";
    // The role cannot be told, so the wait is the person's: their own notify.
    const paused = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(paused.notified).toBe(true);
    expect(told(tables, "standing_sub").length).toBe(1);
    // Resumed, it stays disarmed until an event, and the episode that was
    // held back is heard on the next check.
    await applyResume(ctx as any, trigger as any);
    expect(trigger.run_at).toBeUndefined();
    trigger.prompt = "Answer it yourself when you can.";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").map((f) => f?.body)).toEqual([expect.any(String), "Answer it yourself when you can."]);
    trigger.status = "completed";
    tables.conversations[0].message_count = 12;
    tables.conversations[0].thread_state = "Which price band for Utah?";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(2);
    expect((tables.agent_tasks ?? []).length).toBe(1);
  });

  test("a role's standing session that declares itself blocked tells the role it reports to; the top role tells nobody", async () => {
    // The sub-lead's row carries its parent role (S28) and rides its card:
    // it still speaks as the role, and its own settle rings nobody.
    const sub = settledIdleWorld({
      conv: { _id: "standing_sub", title: "Calling lead", standing_role_id: "role_sub", org_role_id: "role_top", anchor_id: "anchor_sub", persistent: true, message_count: 40, thread_state_status: "blocked", thread_state: "Seed Texas with 40 brokers, or wait for signups?" },
      session: { conversation_id: "standing_sub" },
      messages: [{ _id: "m1", conversation_id: "standing_sub", role: "assistant", content: "Standing by.", timestamp: now - 70_000 }],
      extra: org(),
    });
    sub.tables.conversations.push(standing("standing_top", "role_top"));
    const subRes = await performNeedsInputCheck(sub.ctx as any, { conversation_id: "standing_sub" });
    expect(subRes.reason).toBe("under_role");
    expect(told(sub.tables, "standing_top").map((f) => f?.waiting)).toEqual([
      expect.objectContaining({ role: "calling", why: "blocked", state: "Seed Texas with 40 brokers, or wait for signups?" }),
    ]);

    const top = settledIdleWorld({
      conv: { _id: "standing_top", title: "Growth lead", standing_role_id: "role_top", anchor_id: "anchor_top", persistent: true, message_count: 40, thread_state_status: "blocked", thread_state: "Approve the Texas seed?" },
      session: { conversation_id: "standing_top" },
      messages: [{ _id: "m1", conversation_id: "standing_top", role: "assistant", content: "Standing by.", timestamp: now - 70_000 }],
      extra: org(),
    });
    top.tables.conversations.push(standing("standing_sub", "role_sub"));
    await performNeedsInputCheck(top.ctx as any, { conversation_id: "standing_top" });
    expect(top.tables.pending_messages ?? []).toEqual([]);
  });

  // Nothing waiting on the person is lost (ct-55574). The role is the first
  // reader only while it can be told: with its trigger paused or cancelled,
  // no standing session, or the org off, the settle is the person's own.
  test("a role that cannot be told never swallows the wait: the person's own notify runs", async () => {
    const unheard: Array<[string, (t: Record<string, Rec[]>, ctx: any) => Promise<void> | void]> = [
      ["trigger cancelled", async (t, ctx) => { (await ctx.db.get((await ensureRoleNeedsInputTrigger(ctx, t.org_roles[1] as any, t.conversations[2] as any)).id)).status = "completed"; }],
      ["no standing session", (t) => { t.org_roles[1].anchor_id = undefined; }],
      ["org off", (t) => { t.teams[0].features = {}; }],
    ];
    for (const [name, arrange] of unheard) {
      const { ctx, tables } = blockedHand();
      await arrange(tables, ctx);
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([name, res.notified, res.reason]).toEqual([name, true, undefined]);
      expect(told(tables, "standing_sub")).toEqual([]);
      expect(tables.notifications.length).toBe(1);
    }
  });

  test("a role seated in a session an earlier role stood in gets its own trigger: the earlier role's cancelled one is not its", async () => {
    const { ctx, tables } = blockedHand();
    // The earlier role's trigger, cancelled when that role retired.
    const old = await ctx.db.get((await ensureRoleNeedsInputTrigger(ctx as any, { _id: "role_old" } as any, tables.conversations[2] as any)).id);
    old.status = "completed";
    const armed = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[1] as any, tables.conversations[2] as any);
    expect([armed.created, armed.id === old._id]).toEqual([true, false]);
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("under_role");
    expect(told(tables, "standing_sub").map((f) => f?.task_id)).toEqual([armed.id]);
    // The role's own, cancelled by the person, stays cancelled.
    (await ctx.db.get(armed.id)).status = "completed";
    expect(await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[1] as any, tables.conversations[2] as any)).toMatchObject({ id: armed.id, created: false });
    expect(tables.agent_tasks.length).toBe(2);
  });

  test("a question asked in prose tells the role once the settle classifier says it needs input; a finished turn tells nobody", async () => {
    const { ctx, tables } = blockedHand();
    Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
    // At settle a plain turn could still be a finished one: nothing fires yet.
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("under_role");
    expect(told(tables, "standing_sub")).toEqual([]);
    // A done verdict wakes nobody.
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "done" });
    expect(told(tables, "standing_sub")).toEqual([]);
    // A needs-input verdict tells the role, once per settle.
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "needs_input" });
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "needs_input" });
    expect(told(tables, "standing_sub").map((f) => f?.waiting)).toEqual([
      expect.objectContaining({ short_id: "jx7hand", why: "waiting", state: "" }),
    ]);
    // The next turn that ends needing input is a new one.
    tables.conversations[0].message_count = 8;
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "needs_input" });
    expect(told(tables, "standing_sub").length).toBe(2);
  });

  test("a plain turn under a role that cannot hear goes to the person at settle", async () => {
    const { ctx, tables } = blockedHand();
    Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    const trigger = triggerOn(tables, "standing_sub")!;
    await applyPause(ctx as any, trigger as any);
    tables.conversations[0].message_count = 9;
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).not.toBe("under_role");
  });

  test("a hard stall is one ask per settle: a second permission prompt under the same pinned line still tells the role", async () => {
    const { ctx, tables } = blockedHand();
    Object.assign(tables.conversations[0], { thread_state_status: "working", thread_state: "Migrating the parser" });
    // A prompt that has outlasted the grace (ROUTE_UP_STALL_GRACE_MS).
    Object.assign(tables.managed_sessions[0], { agent_status: "permission_blocked", agent_status_updated_at: now - 3 * 60_000 });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").map((f) => f?.waiting?.why)).toEqual(["permission_blocked"]);
    // Approved, it works on and stalls again with the same line pinned.
    tables.conversations[0].message_count = 9;
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(2);
    // The same holds under a declared block: the declaration is one ask per
    // line, a stall after it resumed is its own.
    Object.assign(tables.conversations[0], { thread_state_status: "blocked", message_count: 14 });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "standing_sub").length).toBe(3);
  });
});
