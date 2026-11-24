import { describe, expect, test } from "bun:test";
import { parseScheduledTask } from "@codecast/shared/contracts";
import { performDaemonSessionPush, performNeedsInputCheck, performPassWaitUp, performReleaseDeadParentChildren, performRerouteMemberEscalations } from "./notifications";
import { applyMembershipVisibilityChange } from "./teams";
import { waitAudienceOf } from "./lib/inboxOwners";
import { releaseDeadParentChildrenLater } from "./lib/agentOwnerWaits";
import { applyHideTransition, deleteConversationBySessionIdCore } from "./cleanup";
import { performSetIdleSummary } from "./idleSummary";
import { deliverSessionNotificationToParties } from "./lib/sessionNotify";
import { handOnEscalatedWaits } from "./lib/teamMembershipEnd";
import { checkConversationAccess } from "./privacy";
import { ensureRoleNeedsInputTrigger } from "./agentTasks";
import { settledIdleWorld, type Rec } from "./notifications.needsInput.testkit";
import { collectInboxSessionsByIds, computeInboxSessions, computeSessionsLiveness } from "./conversations";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { makeFakeDb } from "./testDb";

// Under the owners model (team feature session_owners) an agent owner answers
// a session's waits: its role through the route up, or the session that
// started it, told directly. Nobody is rung. A wait the agent cannot hear, or
// passes up (wait_up_at), reaches the person owners and rings them. Off the
// flag every case is today's behaviour.
describe("agent owners answer a session's waits", () => {
  const now = Date.now();
  const told = (tables: Record<string, Rec[]>, conv: string) => (tables.pending_messages ?? []).filter((m) => m.conversation_id === conv).map((m) => parseScheduledTask(m.content));
  // Shared with team1 in full: whoever a wait reaches must be able to open it.
  const blocked = { short_id: "jx7wait", team_id: "team1", is_private: false, thread_state_status: "blocked", thread_state: "Which price band for Texas?", thread_state_at: now - 30_000 };
  const member = (user_id: string, role = "member") => ({ _id: `tm_${user_id}`, user_id, team_id: "team1", role, joined_at: 1, visibility: "full" });
  const teams = (flag: boolean) => [{ _id: "team1", features: { org: true, ...(flag ? { session_owners: true } : {}) } }];

  const roleWorld = (flag: boolean) => {
    const world = settledIdleWorld({
      conv: { ...blocked, org_role_id: "role_r" },
      extra: {
        teams: teams(flag),
        org_roles: [{ _id: "role_r", handle: "growth", name: "Growth lead", status: "active", team_id: "team1", anchor_id: "anchor_r", reports_to: { kind: "user", user_id: "u1" } }],
        anchors: [{ _id: "anchor_r", conversation_id: "standing_r", status: "active" }],
        agent_tasks: [],
        pending_messages: [],
        session_owners: [],
      },
    });
    world.tables.conversations.push({ _id: "standing_r", user_id: "u1", title: "growth lead", status: "active", team_id: "team1", message_count: 40, updated_at: now - 60_000, standing_role_id: "role_r", anchor_id: "anchor_r", persistent: true });
    return world;
  };

  const parentWorld = (flag: boolean, parent: Rec = {}) => {
    const world = settledIdleWorld({
      conv: { ...blocked, spawned_by_conversation_id: "parent", agent_name: "worker" },
      extra: { teams: teams(flag), pending_messages: [], session_owners: [] },
    });
    world.tables.conversations.push({ _id: "parent", user_id: "u1", title: "Lead session", status: "active", team_id: "team1", message_count: 30, updated_at: now - 60_000, ...parent });
    return world;
  };

  test("a role owner hears through its route up and nobody is rung; off the flag the same wait files under the role as today", async () => {
    for (const flag of [true, false]) {
      const { ctx, tables } = roleWorld(flag);
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([flag, res.notified, res.reason]).toEqual([flag, false, flag ? "agent_owner" : "under_role"]);
      expect(told(tables, "standing_r").map((f) => f?.waiting?.short_id)).toEqual(["jx7wait"]);
      expect(tables.notifications.length).toBe(0);
      expect(tables.conversations[0].wait_up_at).toBeUndefined();
    }
  });

  test("a role that cannot be told sends the wait to its people: rung, and Needs You (wait_up_at)", async () => {
    const { ctx, tables } = roleWorld(true);
    const trigger = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[0] as any, tables.conversations[1] as any);
    (await ctx.db.get(trigger.id)).status = "completed";
    tables.session_owners.push({ _id: "so1", conversation_id: "conv1", user_id: "u1", added_by: "u1", added_at: 1 });
    tables.conversations[0].owner_user_id = "u1";
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
    expect(tables.notifications.map((n) => String(n.recipient_user_id))).toEqual(["u1"]);
    expect(tables.conversations[0].wait_up_at).toBeGreaterThanOrEqual(now);
  });

  test("a parent session owner is told the wait as its next turn, once per ask; nobody is rung", async () => {
    const { ctx, tables } = parentWorld(true);
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([false, "agent_owner"]);
    const frames = told(tables, "parent");
    expect(frames.map((f) => [f?.title, f?.waiting?.short_id, f?.waiting?.why, f?.waiting?.state])).toEqual([["Session jx7wait waits on you", "jx7wait", "blocked", "Which price band for Texas?"]]);
    expect(tables.pending_messages[0].origin).toBe("scheduler");
    expect(tables.notifications.length).toBe(0);
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "parent").length).toBe(1);
  });

  test("off the flag the spawned session stands down as today and its parent hears nothing", async () => {
    const { ctx, tables } = parentWorld(false);
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("agent_spawned");
    expect(told(tables, "parent")).toEqual([]);
  });

  test("a killed or deleted parent no longer owns it: the wait is its starter's, rung as their own", async () => {
    for (const drop of ["killed", "deleted"] as const) {
      const { ctx, tables } = parentWorld(true, { inbox_killed_at: now - 1000 });
      if (drop === "deleted") tables.conversations.splice(1, 1);
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([drop, res.notified, res.reason]).toEqual([drop, true, undefined]);
      expect(told(tables, "parent")).toEqual([]);
      expect(tables.notifications.map((n) => String(n.recipient_user_id))).toEqual(["u1"]);
      // No window reads an unreleased child of a dead parent, so its wait
      // escalates to the person it rings.
      expect(tables.conversations[0]).toMatchObject({ wait_up_count: 5, wait_up_person: "u1" });
    }
  });

  test("a subagent of a killed parent whose wait rings me lists through its escalation, whatever the nested window holds", async () => {
    for (const drop of ["killed", "deleted"] as const) {
      const { ctx, tables } = parentWorld(true, { inbox_killed_at: now - 1000 });
      Object.assign(tables.conversations[0], { is_subagent: true, parent_conversation_id: "parent", spawned_by_conversation_id: undefined, agent_name: undefined });
      if (drop === "deleted") tables.conversations.splice(1, 1);
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([drop, res.notified]).toEqual([drop, true]);
      expect(rung(tables)).toEqual(["u1"]);
      expect(tables.conversations[0]).toMatchObject({ wait_up_person: "u1" });
      // A full nested window: 30 subagents u1 released, every one newer.
      for (let i = 0; i < 30; i++) {
        tables.conversations.push({ _id: `released_${i}`, user_id: "u1", team_id: "team1", is_subagent: true, parent_conversation_id: "other_parent", parent_released_at: now - i * 1000, status: "active", message_count: 3, last_message_role: "assistant", updated_at: now - i * 1000, started_at: now - 3_600_000 });
      }
      const db = makeFakeDb({ ...JSON.parse(JSON.stringify(tables)), team_memberships: [{ _id: "tm1", user_id: "u1", team_id: "team1", role: "member", joined_at: 1, visibility: "full" }] });
      const { sessions, truncated } = await computeInboxSessions({ db } as any, "u1" as any, { includeLiveness: false });
      expect(truncated).toContain("nested");
      expect(sessions.map((s: any) => s._id)).toContain("conv1");
    }
  });

  test("a wait the agent passed up (wait_up_at current) rings its people and is not told again", async () => {
    const { ctx, tables } = parentWorld(true);
    Object.assign(tables.conversations[0], { wait_up_at: now - 10_000, wait_up_count: tables.conversations[0].message_count });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
    expect(told(tables, "parent")).toEqual([]);
  });

  test("the next message hands the waits back to the agent: an escalation it outgrew is ignored", async () => {
    const { ctx, tables } = parentWorld(true);
    // Server time far ahead of the machine's: the count, not the clock, decides.
    Object.assign(tables.conversations[0], { wait_up_at: now + 3_600_000, wait_up_count: tables.conversations[0].message_count - 1 });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("agent_owner");
    expect(told(tables, "parent").length).toBe(1);
  });

  test("a question asked in prose reaches the parent once the settle classifier says it needs input", async () => {
    const { ctx, tables } = parentWorld(true);
    Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
    expect((await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).reason).toBe("agent_owner");
    expect(told(tables, "parent")).toEqual([]);
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "needs_input" });
    expect(told(tables, "parent").map((f) => f?.waiting?.why)).toEqual(["waiting"]);
  });

  test("passing a wait up stamps it for its people and runs the check; only under the flag, only with an agent owner", async () => {
    const { ctx, tables, scheduled } = parentWorld(true);
    // Only the agent owner itself (from its own session) or a person owner may.
    await expect(performPassWaitUp(ctx as any, "u1" as any, "jx7wait")).rejects.toThrow("Only its agent owner");
    tables.conversations[1].short_id = "jx7lead";
    expect(await performPassWaitUp(ctx as any, "u1" as any, "jx7wait", "jx7lead")).toEqual({ short_id: "jx7wait" });
    expect(tables.conversations[0].wait_up_at).toBeGreaterThanOrEqual(now);
    expect(scheduled.at(-1)?.args).toEqual({ conversation_id: "conv1" });
    const off = parentWorld(false);
    await expect(performPassWaitUp(off.ctx as any, "u1" as any, "jx7wait", "parent")).rejects.toThrow("session owners feature");
    const released = parentWorld(true);
    released.tables.conversations[0].parent_released_at = now - 1000;
    await expect(performPassWaitUp(released.ctx as any, "u1" as any, "jx7wait", "parent")).rejects.toThrow("No agent owns it");
  });

  // ── The audience a wait reaches past its agent (review of ct-100061) ──
  const rung = (tables: Record<string, Rec[]>) => tables.notifications.map((n) => String(n.recipient_user_id));

  test("a closed parent still owns the child but cannot answer: the wait reaches the human who started it, who is listed for it", async () => {
    const { ctx, tables } = parentWorld(true, { inbox_closed_at: now - 1000, inbox_dismissed_at: now - 1000 });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
    expect(told(tables, "parent")).toEqual([]);
    expect(rung(tables)).toEqual(["u1"]);
    expect(tables.conversations[0]).toMatchObject({ wait_up_count: 5, wait_up_person: "u1" });
  });

  test("a parent whose machine is away cannot answer: the wait escalates instead of waiting in its queue", async () => {
    const { ctx, tables } = parentWorld(true, { owner_device_id: "laptop" });
    tables.devices = [{ _id: "devices_1", user_id: "u1", device_id: "laptop", last_seen: now - 2 * 60 * 60 * 1000 }];
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
    expect(told(tables, "parent")).toEqual([]);
    expect(rung(tables)).toEqual(["u1"]);
  });

  test("a parent is never told a session's open decision: a decision goes to people", async () => {
    const { ctx, tables } = parentWorld(true);
    tables.session_decisions = [{ _id: "sd1", conversation_id: "conv1", status: "pending", blocking: true }];
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(told(tables, "parent")).toEqual([]);
  });

  test("a role-started run on an agent account whose role cannot hear reaches where the role's line ends: never a bot, never nobody", async () => {
    const { ctx, tables } = roleWorld(true);
    Object.assign(tables.conversations[0], { user_id: "bot1", role_started: true });
    tables.users.push({ _id: "bot1", is_bot: true }, { _id: "lead1", notifications_enabled: true, push_token: "tok-lead" });
    tables.team_memberships = [member("bot1"), member("lead1")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    const trigger = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[0] as any, tables.conversations[1] as any);
    (await ctx.db.get(trigger.id)).status = "completed";
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
    expect(rung(tables)).toEqual(["lead1"]);
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "lead1" });
  });

  // The escalated window reads no liveness for a row only it seats, so the
  // wait's kind rides the row: the episode key the push writes.
  test("a permission prompt that escalated files under questions for its person, on the CLI and the web overlay", async () => {
    const { ctx, tables } = roleWorld(true);
    Object.assign(tables.conversations[0], { user_id: "bot1", role_started: true, thread_state_status: undefined });
    Object.assign(tables.managed_sessions[0], { user_id: "bot1", agent_status: "permission_blocked", agent_status_updated_at: now - 20 * 60_000 });
    tables.users.push({ _id: "bot1", is_bot: true }, { _id: "lead1", notifications_enabled: true, push_token: "tok-lead" });
    tables.team_memberships = [member("bot1"), member("lead1")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    tables.pending_permissions = [];
    const trigger = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[0] as any, tables.conversations[1] as any);
    (await ctx.db.get(trigger.id)).status = "completed";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "lead1", needs_input_notified_key: "5:permission_blocked" });
    const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
    const { sessions } = await computeInboxSessions({ db } as any, "lead1" as any, { projection: true });
    expect(sessions.find((r: any) => r._id === "conv1")).toMatchObject({ bucket: "questions" });
    const { liveness } = await computeSessionsLiveness({ db } as any, "lead1" as any);
    expect(liveness["conv1"]).toMatchObject({ bucket: "questions" });
  });

  // No new access grant: a wait reaches only someone who can open the session.
  test("a private session never rings or lists someone who cannot open it; its runner hears it instead", async () => {
    const { ctx, tables } = roleWorld(true);
    Object.assign(tables.conversations[0], { role_started: true, is_private: true });
    tables.users.push({ _id: "lead1", notifications_enabled: true, push_token: "tok-lead" }, { _id: "admin1", notifications_enabled: true });
    tables.team_memberships = [member("u1"), member("lead1"), member("admin1", "admin")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    const trigger = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[0] as any, tables.conversations[1] as any);
    (await ctx.db.get(trigger.id)).status = "completed";
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    // The role line ends at lead1 and admin1 is an admin, but neither can open
    // it: the human who runs it hears it.
    expect(rung(tables)).toEqual(["u1"]);
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "u1" });
    // A stamp naming someone without access lists nowhere for them.
    tables.conversations[0].wait_up_person = "lead1";
    const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
    expect((await computeInboxSessions({ db } as any, "lead1" as any, { includeLiveness: false })).sessions.map((r: any) => r._id)).toEqual([]);
    expect((await collectInboxSessionsByIds({ db } as any, "lead1" as any, ["conv1"])).sessions).toEqual([]);
  });

  test("a visibility change that shuts its person out hands the wait on to someone who can open it", async () => {
    const { tables } = roleWorld(true);
    Object.assign(tables.conversations[0], { role_started: true, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "lead1", needs_input_notified_key: "5:blocked" });
    tables.users.push({ _id: "lead1" });
    tables.team_memberships = [member("u1"), member("lead1")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
    const checks: unknown[] = [];
    const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { if (args?.conversation_id) checks.push(args.conversation_id); } } };
    await patchConversationVisibility(ctx as any, await db.get("conv1"), { is_private: true, team_visibility: "private" });
    expect(await db.get("conv1")).toMatchObject({ wait_up_person: "u1", wait_up_count: 5 });
    expect((await db.get("conv1")).needs_input_notified_key).toBeUndefined();
    expect(checks).toContain("conv1");
    // A change that keeps them able to open it leaves the wait where it is.
    await db.patch("conv1", { wait_up_person: "u1" });
    await patchConversationVisibility(ctx as any, await db.get("conv1"), { team_visibility: "summary" });
    expect(await db.get("conv1")).toMatchObject({ wait_up_person: "u1" });
  });

  // A dead parent owns no child: the release is written on each live child
  // (the nested window lists a subagent for its starter), and a wait the
  // parent was told runs its check again.
  test("a parent's death releases its running and waiting children and re-checks the waits, once its cascade has run, only under the flag", async () => {
    const child = (id: string, extra: Rec) => ({ _id: id, user_id: "u1", team_id: "team1", is_private: false, status: "active", is_subagent: true, parent_conversation_id: "parent", message_count: 5, updated_at: now, ...extra });
    const world = (flag: boolean) => makeFakeDb({
      teams: [...teams(flag), { _id: "team2", features: {} }, { _id: "team3", features: { session_owners: true } }],
      users: [{ _id: "u1" }], team_memberships: [member("u1")],
      conversations: [
        { _id: "parent", user_id: "u1", team_id: "team1", status: "completed", inbox_killed_at: now - 5, message_count: 30, updated_at: now },
        // A wait it told its parent, still standing (no message since).
        child("told", { hand_wake_notified_key: "5:Which band?" }),
        // A wait it told before its last message: over.
        child("told_before", { hand_wake_notified_key: "4:Which band?" }),
        // Its agent process is running.
        child("running", {}),
        // History: idle with no process, and finished.
        child("idle", {}),
        child("finished", { status: "completed" }),
        child("killed", { hand_wake_notified_key: "5:x", inbox_killed_at: now }),
        child("released_before", { parent_released_at: now - 100, hand_wake_notified_key: "5:x" }),
        // A running child in another team: its own team's flag decides.
        child("other_team_off", { team_id: "team2" }),
        child("other_team_on", { team_id: "team3" }),
        { ...child("spawned_told", { hand_wake_notified_key: "5:x" }), is_subagent: false, parent_conversation_id: undefined, spawned_by_conversation_id: "parent" },
      ],
      managed_sessions: ["running", "other_team_off", "other_team_on"].map((c) => ({ _id: `ms_${c}`, conversation_id: c, user_id: "u1", session_id: `s_${c}`, last_heartbeat: now - 1000 })),
    });
    for (const flag of [true, false]) {
      const db = world(flag);
      const runs: Array<{ ms: number; args: any }> = [];
      const ctx = { db, scheduler: { runAfter: async (ms: number, _fn: unknown, args: any) => { runs.push({ ms, args }); } } };
      await releaseDeadParentChildrenLater(ctx as any, await db.get("parent"));
      if (!flag) { expect(runs).toEqual([]); continue; }
      expect(runs).toEqual([{ ms: 60_000, args: { parent_id: "parent", released_at: now - 5 } }]);
      // The subagents' page, then the spawned sessions'.
      runs.length = 0;
      expect(await performReleaseDeadParentChildren(ctx as any, { parent_id: "parent", released_at: now - 5 })).toEqual({ released: 3, rechecked: 2 });
      expect(runs.map((r) => r.args)).toEqual([{ conversation_id: "told" }, { conversation_id: "released_before" }, { parent_id: "parent", released_at: now - 5, spawned: true }]);
      const releasedAt = async (id: string) => (await db.get(id)).parent_released_at;
      expect(await Promise.all(["told", "running", "other_team_on"].map(releasedAt))).toEqual([now - 5, now - 5, now - 5]);
      expect(await Promise.all(["told_before", "idle", "finished", "killed", "other_team_off"].map(releasedAt))).toEqual([undefined, undefined, undefined, undefined, undefined]);
      expect(await releasedAt("released_before")).toBe(now - 100);
      runs.length = 0;
      await performReleaseDeadParentChildren(ctx as any, { parent_id: "parent", released_at: now - 5, spawned: true });
      expect(runs.map((r) => r.args)).toEqual([{ conversation_id: "spawned_told" }]);
      expect(await releasedAt("spawned_told")).toBe(now - 5);
    }
  });

  test("the root kill schedules the release job; a child the cascade takes down only when it has children of its own", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1" }], team_memberships: [member("u1")],
      conversations: [
        { _id: "parent", user_id: "u1", team_id: "team1", status: "active", message_count: 30, updated_at: now },
        { _id: "leaf", user_id: "u1", team_id: "team1", status: "active", is_subagent: true, parent_conversation_id: "parent", message_count: 3, updated_at: now },
        { _id: "branch", user_id: "u1", team_id: "team1", status: "active", is_subagent: true, parent_conversation_id: "parent", message_count: 3, updated_at: now },
        { _id: "grandchild", user_id: "u1", team_id: "team1", status: "active", is_subagent: true, parent_conversation_id: "branch", message_count: 3, updated_at: now },
      ],
    });
    const runs: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } };
    const kill = async (id: string, victim: boolean) => {
      const doc = await db.get(id);
      await db.patch(id, { inbox_dismissed_at: now });
      await applyHideTransition(ctx as any, doc, { inbox_dismissed_at: now }, { forceKill: true, cascade: false, ...(victim ? { cascadeVictim: true } : {}) });
    };
    const scheduledFor = (id: string) => runs.some((a) => a.parent_id === id && typeof a.released_at === "number");
    await kill("parent", false);
    await kill("leaf", true);
    await kill("branch", true);
    expect([scheduledFor("parent"), scheduledFor("leaf"), scheduledFor("branch")]).toEqual([true, false, true]);
  });

  test("deleting a session schedules the release job for its children", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1" }], team_memberships: [member("u1")],
      conversations: [{ _id: "parent", user_id: "u1", team_id: "team1", session_id: "sess-parent", status: "active", message_count: 0, updated_at: now }],
      messages: [],
    });
    const runs: any[] = [];
    await deleteConversationBySessionIdCore({ db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } } as any, { session_id: "sess-parent" });
    expect(await db.get("parent")).toBeNull();
    expect(runs).toContainEqual({ parent_id: "parent", released_at: expect.any(Number) });
  });

  test("a deleted parent's finished subagents stay out of its starter's inbox; a running one lists", async () => {
    const sub = (id: string, extra: Rec) => ({ _id: id, user_id: "u1", team_id: "team1", is_private: false, status: "active", is_subagent: true, parent_conversation_id: "gone_parent", title: id, message_count: 4, last_message_role: "assistant", updated_at: now - 60_000, started_at: now - 3_600_000, ...extra });
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1", name: "U" }], team_memberships: [member("u1")],
      conversations: [
        ...Array.from({ length: 30 }, (_, i) => sub(`done${i}`, { status: i % 2 ? "completed" : "active", updated_at: now - (i + 1) * 60_000 })),
        sub("running", { updated_at: now - 40 * 60_000 }),
      ],
      managed_sessions: [{ _id: "ms_r", conversation_id: "running", user_id: "u1", session_id: "s_r", last_heartbeat: now - 1000 }],
      session_owners: [], messages: [], session_decisions: [], decision_inbox: [],
    });
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    await performReleaseDeadParentChildren(ctx as any, { parent_id: "gone_parent", released_at: now - 1000 });
    const listed = (await computeInboxSessions({ db } as any, "u1" as any, { includeLiveness: false })).sessions.map((r: any) => r._id);
    expect(listed).toEqual(["running"]);
  });

  // A released subagent whose runner did not start it (moved to another
  // account) has no nested seat: the seat is its runner's, and its runner is
  // not who owns it. Its waits keep escalating, so the escalated window lists it.
  test("a released subagent its runner did not start keeps escalating its waits to the person who owns it", async () => {
    const { ctx, tables } = settledIdleWorld({
      conv: { ...blocked, is_subagent: true, parent_conversation_id: "parent", parent_released_at: now - 60_000, author_user_id: "author1" },
      users: [{ _id: "u1", notifications_enabled: true }, { _id: "author1", notifications_enabled: true, push_token: "tok-a" }],
      extra: { teams: teams(true), team_memberships: [member("u1"), member("author1")], pending_messages: [], session_owners: [] },
    });
    tables.conversations.push({ _id: "parent", user_id: "u1", team_id: "team1", status: "active", message_count: 30, updated_at: now });
    await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(rung(tables)).toEqual(["author1"]);
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "author1", wait_up_count: 5 });
    const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
    expect((await computeInboxSessions({ db } as any, "author1" as any, { includeLiveness: false })).sessions.map((r: any) => r._id)).toEqual(["conv1"]);
  });

  test("a wait standing With a parent that is then killed reaches its starter through the release job", async () => {
    // The child told its parent a wait, which stood "With <parent>": nobody rang.
    const { ctx, tables, scheduled } = parentWorld(true);
    Object.assign(tables.conversations[0], { hand_wake_notified_key: "5:Which price band for Texas?" });
    let res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(rung(tables)).toEqual([]);
    // The parent is killed; the job releases the child and runs its check.
    tables.conversations[1].inbox_killed_at = now;
    scheduled.length = 0;
    await performReleaseDeadParentChildren(ctx as any, { parent_id: "parent", released_at: now });
    await performReleaseDeadParentChildren(ctx as any, { parent_id: "parent", released_at: now, spawned: true });
    expect(tables.conversations[0].parent_released_at).toBe(now);
    expect(scheduled.map((r) => r.args)).toContainEqual({ conversation_id: "conv1" });
    res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, rung(tables)]).toEqual([true, ["u1"]]);
  });

  test("a deleted parent's subagent is listed for its starter once the release job has run", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1", name: "U" }], team_memberships: [member("u1")],
      conversations: [{ _id: "orphan", user_id: "u1", team_id: "team1", is_private: false, status: "active", is_subagent: true, parent_conversation_id: "gone_parent", title: "orphan", message_count: 4, last_message_role: "assistant", updated_at: now - 60_000, started_at: now - 3_600_000 }],
      // Still running: a finished one stays history (the test above).
      managed_sessions: [{ _id: "ms_o", conversation_id: "orphan", user_id: "u1", session_id: "s_o", last_heartbeat: now - 1000 }],
      session_owners: [], messages: [], session_decisions: [], decision_inbox: [],
    });
    const listed = async () => (await computeInboxSessions({ db } as any, "u1" as any, { includeLiveness: false })).sessions.map((r: any) => r._id);
    expect(await listed()).toEqual([]);
    const ctx = { db, scheduler: { runAfter: async () => {} } };
    await performReleaseDeadParentChildren(ctx as any, { parent_id: "gone_parent", released_at: now - 1000 });
    expect(await listed()).toEqual(["orphan"]);
  });

  // A real permission prompt, on the real path: the daemon opens a
  // pending_permissions record and makes its own push (createSessionNotification),
  // which under the model stamps the episode key only when it rang someone.
  // Every case counts every push, the daemon's included: exactly one.
  const prompting = async (ctx: any, tables: Record<string, Rec[]>, opts: { at?: number } = {}) => {
    Object.assign(tables.managed_sessions[0], { agent_status: "permission_blocked", agent_status_updated_at: opts.at ?? now - 20 * 60_000 });
    tables.pending_permissions = [{ _id: "pp1", conversation_id: "conv1", status: "pending", tool_name: "Bash" }];
    await performDaemonSessionPush(ctx, tables.conversations[0], { type: "permission_request", title: "Permission needed", message: "Bash" });
  };
  // Every alerting notification row the db is asked to write, in order: the
  // rows themselves replace one another (one row per conversation), but each
  // insert is a ring (a new banner, a push).
  const watchRings = (ctx: any) => {
    const rings: string[] = [];
    const insert = ctx.db.insert.bind(ctx.db);
    ctx.db.insert = async (table: string, doc: Rec) => {
      if (table === "notifications" && !doc.quiet && (doc.type === "session_idle" || doc.type === "permission_request")) rings.push(String(doc.recipient_user_id));
      return insert(table, doc);
    };
    return rings;
  };
  const checkTwice = async (ctx: any) => {
    await performNeedsInputCheck(ctx, { conversation_id: "conv1" });
    await performNeedsInputCheck(ctx, { conversation_id: "conv1" });
  };

  test("an escalated permission prompt rings its person once: an unreachable agent", async () => {
    const { ctx, tables } = roleWorld(true);
    const rings = watchRings(ctx);
    Object.assign(tables.conversations[0], { user_id: "bot1", role_started: true, thread_state_status: undefined });
    tables.managed_sessions[0].user_id = "bot1";
    tables.users.push({ _id: "bot1", is_bot: true }, { _id: "lead1", notifications_enabled: true, push_token: "tok-lead" });
    tables.team_memberships = [member("bot1"), member("lead1")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    const trigger = await ensureRoleNeedsInputTrigger(ctx as any, tables.org_roles[0] as any, tables.conversations[1] as any);
    (await ctx.db.get(trigger.id)).status = "completed";
    // Its role owns it: the daemon's push rings nobody and stamps nothing.
    await prompting(ctx, tables);
    expect([rings, tables.conversations[0].needs_input_notified_key]).toEqual([[], undefined]);
    await checkTwice(ctx);
    expect(rings).toEqual(["lead1"]);
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "lead1", needs_input_notified_key: "5:permission_blocked" });
  });

  test("an escalated permission prompt rings its person once: a pass-up", async () => {
    const { ctx, tables } = parentWorld(true);
    const rings = watchRings(ctx);
    await prompting(ctx, tables);
    // The parent hears it: told, nobody rung.
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "agent_owner" });
    expect(rings).toEqual([]);
    tables.conversations[1].short_id = "jx7lead";
    await performPassWaitUp(ctx as any, "u1" as any, "jx7wait", "jx7lead");
    await checkTwice(ctx);
    expect(rings).toEqual(["u1"]);
  });

  // The check covers the episode whatever the person's settings: a pass-up to
  // someone with session pushes off still files under Questions, by its key.
  test("a pass-up to someone with session pushes off files under questions, rings nobody, and is not retried", async () => {
    const { ctx, tables } = parentWorld(true);
    tables.users[0].notification_preferences = { session_idle: false, permission_request: true };
    tables.team_memberships = [member("u1")];
    const rings = watchRings(ctx);
    await prompting(ctx, tables);
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "agent_owner" });
    tables.conversations[1].short_id = "jx7lead";
    await performPassWaitUp(ctx as any, "u1" as any, "jx7wait", "jx7lead");
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ notified: false });
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "u1", needs_input_notified_key: "5:permission_blocked" });
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "dup" });
    expect(rings).toEqual([]);
    const db = makeFakeDb(JSON.parse(JSON.stringify(tables)));
    const { sessions } = await computeInboxSessions({ db } as any, "u1" as any, { projection: true });
    expect(sessions.find((r: any) => r._id === "conv1")).toMatchObject({ bucket: "questions" });
  });

  test("an escalated permission prompt rings its new person once when a lost access reroutes it", async () => {
    const { ctx, tables, scheduled } = roleWorld(true);
    const rings = watchRings(ctx);
    Object.assign(tables.conversations[0], { role_started: true, thread_state_status: undefined, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "lead1" });
    tables.users.push({ _id: "lead1", notifications_enabled: true, push_token: "tok-lead" });
    tables.team_memberships = [member("u1"), member("lead1")];
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    // Escalated to lead1, whom the daemon's push rang (the key).
    await prompting(ctx, tables);
    expect(rings).toEqual(["lead1"]);
    // lead1 now cannot open it: the check's first step hands it on and
    // schedules the check that rings the new person.
    tables.conversations[0].is_private = true;
    scheduled.length = 0;
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "rerouted" });
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "u1" });
    expect(scheduled.map((r) => r.args)).toContainEqual({ conversation_id: "conv1" });
    await checkTwice(ctx);
    expect(rings).toEqual(["lead1", "u1"]);
  });

  test("a member's visibility change that shuts out a wait's person hands it on (its one writer schedules the reroute)", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1" }, { _id: "lead1" }], team_memberships: [member("u1"), member("lead1")],
      conversations: [{ _id: "conv1", user_id: "u1", team_id: "team1", is_private: false, status: "active", role_started: true, message_count: 5, updated_at: now, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "lead1", needs_input_notified_key: "5:idle" }],
      session_owners: [], authority_events: [],
    });
    const runs: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } };
    // u1 shows the team summaries only now: lead1 can no longer open it.
    await applyMembershipVisibilityChange(ctx as any, "u1" as any, "team1" as any, "summary");
    expect(runs).toContainEqual({ user_id: "u1", team_id: "team1" });
    expect(await performRerouteMemberEscalations(ctx as any, { user_id: "u1", team_id: "team1" })).toEqual({ rerouted: 1 });
    expect(await db.get("conv1")).toMatchObject({ wait_up_person: "u1", wait_up_count: 5 });
    expect(runs).toContainEqual({ conversation_id: "conv1" });
  });

  // The audience never names a starter who cannot open the session (its
  // author, before the session moved to another account).
  test("a starter who cannot open the session never hears its wait: the person who runs it does", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1" }, { _id: "author1" }], team_memberships: [member("u1")],
      conversations: [{ _id: "conv1", user_id: "u1", author_user_id: "author1", team_id: "team1", is_private: true, status: "active", message_count: 5, updated_at: now }],
      session_owners: [],
    });
    const audience = await waitAudienceOf({ db } as any, await db.get("conv1"), { agentReachable: false });
    expect(audience?.people).toEqual(["u1"]);
  });

  // A child no agent ever answered rang its starter with the daemon's own
  // push; its escalation (to seat it) must not ring a second time.
  test("a prompt on a child no agent answered rings once: the daemon's push, never a second from its escalation", async () => {
    // A spawned child whose parent was already dead when it asked.
    const dead = parentWorld(true, { inbox_killed_at: now - 1000 });
    // A released subagent its runner did not start (moved): author1 owns it.
    const moved = settledIdleWorld({
      conv: { ...blocked, is_subagent: true, parent_conversation_id: "parent", parent_released_at: now - 60_000, author_user_id: "author1" },
      users: [{ _id: "u1", notifications_enabled: true }, { _id: "author1", notifications_enabled: true, push_token: "tok-a" }],
      extra: { teams: teams(true), team_memberships: [member("u1"), member("author1")], pending_messages: [], session_owners: [] },
    });
    moved.tables.conversations.push({ _id: "parent", user_id: "u1", team_id: "team1", status: "active", message_count: 30, updated_at: now });
    for (const [{ ctx, tables }, person] of [[dead, "u1"], [moved, "author1"]] as const) {
      const rings = watchRings(ctx);
      await prompting(ctx, tables);
      await checkTwice(ctx);
      expect(rings).toEqual([person]);
      expect(tables.conversations[0]).toMatchObject({ wait_up_person: person, needs_input_notified_key: "5:permission_blocked" });
    }
  });

  test("a prompt its parent was answering when the parent died rings the starter once", async () => {
    const { ctx, tables } = parentWorld(true);
    const rings = watchRings(ctx);
    await prompting(ctx, tables);
    // The parent hears the prompt (told), so the daemon's push rang nobody.
    expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "agent_owner" });
    expect(tables.conversations[0].hand_wake_notified_key).toMatch(/^5:/);
    tables.conversations[1].inbox_killed_at = now;
    // A new transaction (each check is one): the owners read is per call.
    await checkTwice({ ...ctx });
    expect(rings).toEqual(["u1"]);
  });

  // The reviewer's sequence: a prompt while the parent lives, inside the
  // stall grace (so the parent is not told yet), then the parent dies.
  test("a prompt raised before its parent was told, whose parent then dies, rings the starter once, before and after the release job", async () => {
    for (const released of [false, true]) {
      const { ctx, tables } = parentWorld(true);
      const rings = watchRings(ctx);
      // A plain permission prompt, no declared block: its stall grace holds the route up.
      tables.conversations[0].thread_state_status = undefined;
      await prompting(ctx, tables, { at: now - 20_000 });
      expect(await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "agent_owner" });
      expect([rings, tables.conversations[0].hand_wake_notified_key]).toEqual([[], undefined]);
      tables.conversations[1].inbox_killed_at = now;
      if (released) {
        await performReleaseDeadParentChildren({ ...ctx } as any, { parent_id: "parent", released_at: now, spawned: true });
        expect(tables.conversations[0].parent_released_at).toBe(now);
      }
      // A new transaction (each check is one): the owners read is per call.
      await checkTwice({ ...ctx });
      expect([released, rings]).toEqual([released, ["u1"]]);
    }
  });

  // Off the model the key and the stand-down are main's: the daemon's push
  // stamps it whether or not it rang, and an open record stands the check down.
  test("flag off: the daemon's push stamps the key as it always did, and an open record stands the check down", async () => {
    const quiet = settledIdleWorld({ conv: { ...blocked }, users: [{ _id: "u1", notifications_enabled: true, notification_preferences: { permission_request: false } }] });
    const quietRings = watchRings(quiet.ctx);
    await prompting(quiet.ctx, quiet.tables);
    // A push that reached nobody (permission pushes turned off) stamps the key anyway.
    expect([quietRings, quiet.tables.conversations[0].needs_input_notified_key]).toEqual([[], "5:permission_blocked"]);
    const plain = settledIdleWorld({ conv: { ...blocked, thread_state_status: undefined } });
    plain.tables.pending_permissions = [{ _id: "pp1", conversation_id: "conv1", status: "pending" }];
    Object.assign(plain.tables.managed_sessions[0], { agent_status: "permission_blocked", agent_status_updated_at: now - 20 * 60_000 });
    const plainRings = watchRings(plain.ctx);
    expect(await performNeedsInputCheck(plain.ctx as any, { conversation_id: "conv1" })).toMatchObject({ reason: "daemon_permission_push" });
    expect(plain.tables.conversations[0].needs_input_notified_key).toBe("5:permission_blocked");
    expect(plainRings).toEqual([]);
  });

  test("an escalation rings past a pin even with no agent: a dead parent's pinned child", async () => {
    const { ctx, tables } = parentWorld(true, { inbox_killed_at: now - 1000 });
    tables.conversations[0].inbox_pinned_at = now - 60_000;
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, rung(tables)]).toEqual([true, ["u1"]]);
  });

  test("a member's visibility change reroutes nothing off the owners model", async () => {
    const db = makeFakeDb({
      teams: teams(false), users: [{ _id: "u1" }], team_memberships: [member("u1")],
      conversations: [], session_owners: [], authority_events: [],
    });
    const runs: any[] = [];
    await applyMembershipVisibilityChange({ db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } } as any, "u1" as any, "team1" as any, "summary");
    expect(runs.filter((a) => "team_id" in a && "user_id" in a)).toEqual([]);
  });

  test("the release job leaves a finished child alone, even with its process still beating and a wait it told", async () => {
    const db = makeFakeDb({
      teams: teams(true), users: [{ _id: "u1" }], team_memberships: [member("u1")],
      conversations: [{ _id: "done", user_id: "u1", team_id: "team1", status: "completed", is_subagent: true, parent_conversation_id: "parent", message_count: 5, hand_wake_notified_key: "5:x", updated_at: now }],
      managed_sessions: [{ _id: "ms_d", conversation_id: "done", user_id: "u1", session_id: "s_d", last_heartbeat: now - 1000 }],
    });
    const runs: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } };
    expect(await performReleaseDeadParentChildren(ctx as any, { parent_id: "parent", released_at: now })).toEqual({ released: 0, rechecked: 0 });
    expect((await db.get("done")).parent_released_at).toBeUndefined();
  });

  test("flag off: a leftover escalation stamp is never rerouted, by a visibility change or a leave", async () => {
    const db = makeFakeDb({
      teams: teams(false), users: [{ _id: "u1" }, { _id: "lead1" }], team_memberships: [member("u1"), member("lead1")],
      conversations: [{ _id: "conv1", user_id: "u1", team_id: "team1", is_private: false, status: "active", message_count: 5, updated_at: now, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "lead1", needs_input_notified_key: "5:idle" }],
      session_owners: [], authority_events: [],
    });
    const runs: any[] = [];
    const ctx = { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => { runs.push(args); } } };
    await patchConversationVisibility(ctx as any, await db.get("conv1"), { is_private: true, team_visibility: "private" });
    await handOnEscalatedWaits(ctx as any, "lead1" as any, "team1" as any);
    expect(await db.get("conv1")).toMatchObject({ wait_up_person: "lead1", wait_up_at: now - 1000, needs_input_notified_key: "5:idle" });
    expect(runs.filter((a) => a.conversation_id === "conv1")).toEqual([]);
  });

  // Under the model who owns a session decides who hears it, so the main
  // rule's stand-downs for agent-made sessions do not apply. A teammate (an
  // agent_name with no parent link) or a workflow sub whose parent link is
  // gone has no agent owner: its implicit starter, the person who runs it,
  // owns it and hears its wait. Off the flag each stands down as on main.
  test("an agent-made session with no parent link rings its starter under the flag; off it, it stands down", async () => {
    const kinds: Array<[string, Rec, string]> = [
      ["teammate", { agent_name: "worker", agent_team_name: "crew" }, "agent_spawned"],
      ["workflow sub", { is_workflow_sub: true }, "subagent"],
    ];
    for (const [kind, extra, offReason] of kinds) {
      for (const flag of [true, false]) {
        const { ctx, tables } = settledIdleWorld({ conv: { ...blocked, ...extra }, extra: { teams: teams(flag), team_memberships: [member("u1")], pending_messages: [], session_owners: [] } });
        const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
        expect([kind, flag, res.notified, flag ? rung(tables) : res.reason]).toEqual([kind, flag, flag, flag ? ["u1"] : offReason]);
      }
    }
  });

  test("an escalated wait rings even when an agent's message started the waiting turn", async () => {
    const { ctx, tables } = parentWorld(true, { inbox_killed_at: undefined });
    tables.messages.push({ _id: "m0", conversation_id: "conv1", role: "user", content: "<session-message from=\"jx7lead\">try the retry</session-message>", timestamp: now - 80_000 });
    Object.assign(tables.conversations[0], { wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "u1" });
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect([res.notified, res.reason]).toEqual([true, undefined]);
  });

  test("a wait the classifier finds unreachable escalates and schedules the ring", async () => {
    const { ctx, tables, scheduled } = parentWorld(true);
    Object.assign(tables.conversations[0], { thread_state_status: undefined, thread_state: undefined, thread_state_at: undefined });
    tables.conversations[1].inbox_killed_at = undefined;
    // Reachable at settle time, gone by the verdict: the parent was closed.
    expect((await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" })).reason).toBe("agent_owner");
    Object.assign(tables.conversations[1], { inbox_closed_at: now, inbox_dismissed_at: now });
    await performSetIdleSummary(ctx as any, { conversation_id: "conv1", settle_verdict: "needs_input" });
    expect(tables.conversations[0]).toMatchObject({ wait_up_count: 5, wait_up_person: "u1" });
    expect(scheduled.at(-1)?.args).toEqual({ conversation_id: "conv1" });
  });

  // ── Re-review of ct-100061 ──
  test("pass-up's from_session must be a session the caller runs, not one they can merely read", async () => {
    const { ctx, tables } = parentWorld(true);
    tables.users.push({ _id: "u2", notifications_enabled: true });
    // u1 can read the parent (a teammate's session shared with the team) but does not run it.
    tables.team_memberships = [
      { _id: "tm_1", user_id: "u1", team_id: "team1", role: "member", visibility: "full" },
      { _id: "tm_2", user_id: "u2", team_id: "team1", role: "member", visibility: "full" },
    ];
    Object.assign(tables.conversations[1], { short_id: "jx7lead", user_id: "u2", team_id: "team1", is_private: false, team_visibility: "full", auto_shared: true });
    expect(await checkConversationAccess(ctx as any, "u1" as any, tables.conversations[1] as any)).not.toBe("denied");
    await expect(performPassWaitUp(ctx as any, "u1" as any, "jx7wait", "jx7lead")).rejects.toThrow("Only its agent owner");
  });

  test("an escalated wait on a pinned session or a schedule run still rings its people", async () => {
    for (const extra of [{ inbox_pinned_at: now - 1000 }, { agent_task_id: "agent_tasks_1" }]) {
      // Its parent is closed: still the owner, unable to answer.
      const { ctx, tables } = parentWorld(true, { inbox_closed_at: now - 1000, inbox_dismissed_at: now - 1000 });
      Object.assign(tables.conversations[0], extra);
      const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
      expect([JSON.stringify(extra), res.notified]).toEqual([JSON.stringify(extra), true]);
    }
  });

  test("a dead session's escalation ends: it rings nobody and holds no one's inbox", async () => {
    const { ctx, tables } = parentWorld(true, { inbox_closed_at: now - 1000, inbox_dismissed_at: now - 1000 });
    Object.assign(tables.conversations[0], { owner_user_id: undefined, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "u1" });
    tables.managed_sessions[0].agent_status = "stopped";
    const res = await performNeedsInputCheck(ctx as any, { conversation_id: "conv1" });
    expect(res.reason).toBe("dead");
    expect(tables.conversations[0].wait_up_person).toBeUndefined();
    expect(tables.conversations[0].wait_up_count).toBeUndefined();
  });

  test("never a bot, never nobody: a bot owner row is skipped, and a bot run with no human falls to the role line, else an admin", async () => {
    // A bot that retainSessionCreator made an owner hears nothing; the human who started it does.
    const withBotOwner = parentWorld(true, { inbox_killed_at: now - 1000 });
    withBotOwner.tables.users.push({ _id: "bot1", is_bot: true });
    withBotOwner.tables.session_owners.push({ _id: "so_b", conversation_id: "conv1", user_id: "bot1", added_by: "bot1", added_at: 1 });
    withBotOwner.tables.conversations[0].owner_user_id = "bot1";
    await performNeedsInputCheck(withBotOwner.ctx as any, { conversation_id: "conv1" });
    expect(rung(withBotOwner.tables)).toEqual(["u1"]);
    // A bot's run with no agent, no owners and no human: the role line's person, else an admin.
    for (const [role, expected] of [["role_r", "lead1"], [null, "admin1"]] as const) {
      const { ctx, tables } = settledIdleWorld({
        conv: { ...blocked, user_id: "bot1", ...(role ? { org_role_id: role, role_started: true } : {}) },
        users: [{ _id: "bot1", is_bot: true }, { _id: "lead1", notifications_enabled: true }, { _id: "admin1", notifications_enabled: true }],
        extra: {
          teams: teams(true), pending_messages: [], session_owners: [],
          org_roles: [{ _id: "role_r", handle: "growth", status: "active", team_id: "team1", reports_to: { kind: "user", user_id: "lead1" } }],
          team_memberships: [member("bot1"), member("lead1"), member("admin1", "admin")],
        },
      });
      tables.managed_sessions[0].user_id = "bot1";
      const res = await deliverSessionNotificationToParties(ctx as any, tables.conversations[0] as any, "session_error", "t", "m");
      expect([role, res, rung(tables)]).toEqual([role, true, [expected]]);
    }
  });

  test("leaving the team hands an escalated wait on to the next person, never back to the leaver", async () => {
    const { ctx, tables } = roleWorld(true);
    Object.assign(tables.conversations[0], { user_id: "bot1", role_started: true, wait_up_at: now - 1000, wait_up_count: 5, wait_up_person: "lead1", needs_input_notified_key: "5:blocked" });
    tables.users.push({ _id: "bot1", is_bot: true }, { _id: "lead1" }, { _id: "admin1", notifications_enabled: true });
    tables.org_roles[0].reports_to = { kind: "user", user_id: "lead1" };
    tables.team_memberships = [member("bot1"), member("lead1"), member("admin1", "admin")];
    await handOnEscalatedWaits(ctx as any, "lead1" as any, "team1" as any);
    expect(tables.conversations[0]).toMatchObject({ wait_up_person: "admin1", wait_up_count: 5 });
    expect(tables.conversations[0].needs_input_notified_key).toBeUndefined();
    // The ring follows the stamp, never the role line that still ends at the
    // person who left: admin1 hears it, lead1 does not.
    tables.team_memberships = tables.team_memberships.filter((m) => m.user_id !== "lead1");
    tables.users.find((u) => u._id === "lead1")!.notifications_enabled = true;
    await deliverSessionNotificationToParties(ctx as any, tables.conversations[0] as any, "session_idle", "t", "m");
    expect(rung(tables)).toEqual(["admin1"]);
  });
});
