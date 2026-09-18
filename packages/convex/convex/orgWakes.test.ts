import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { enqueueRoleEvent, actorIsExcluded, countersFor, DEFAULT_CAPS } from "./orgEvents";
import { buildFrame, performFlush, type FrameInput } from "./orgWakes";
import { gateHandStart } from "./spawn";
import { answerCore } from "./sessionDecisions";
import type { BriefFacts } from "./org";

// The wake rail (docs/architecture/org-roles-standing.md T3, T4): what an
// outbox row does when it lands, what the flush holds or ships, what the
// frame says, and the trust and cap gates on hands and answers.

const ME = "u".repeat(31) + "m";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;

type Sched = Array<{ delay: number; args: any }>;

function world(roleExtra: Record<string, any> = {}, extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: ME, name: "Me" }, { _id: "bot1", name: "Infra lead", is_bot: true, bot_kind: "role" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme" }],
    counters: [],
    org_roles: [{
      _id: "role1", short_id: "or-1", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Infra lead", handle: "infra-lead",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor1",
      created_by: ME, created_at: 1, updated_at: 1, ...roleExtra,
    }],
    anchors: [{ _id: "anchor1", scope_type: "team", team_id: TEAM, bot_user_id: "bot1", host_user_id: ME, conversation_id: "standing", org_role_id: "role1", status: "active", name: "Infra lead", created_at: 1 }],
    conversations: [
      { _id: "standing", user_id: ME, acting_user_id: "bot1", anchor_id: "anchor1", standing_role_id: "role1", session_id: "s-standing", short_id: "jxstand", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 3, persistent: true, team_id: TEAM },
      { _id: "hand1", user_id: ME, org_role_id: "role1", session_id: "s-hand", short_id: "jxhand1", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 1, title: "Fix the deploy", team_id: TEAM, thread_state: "checking CI", thread_state_at: NOW - 1000 },
      { _id: "stranger", user_id: ME, session_id: "s-other", short_id: "jxother", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 1, team_id: TEAM },
    ],
    role_wake_outbox: [],
    role_wakes: [],
    pending_messages: [],
    managed_sessions: [],
    session_owners: [],
    messages: [],
    user_presence: [],
    projects: [],
    plans: [],
    tasks: [],
    docs: [],
    session_decisions: [],
    decision_inbox: [],
    decision_grants: [],
    ...extra,
  };
  const db = makeFakeDb(tables);
  const scheduled: Sched = [];
  const ctx: any = { db, scheduler: { runAfter: async (delay: number, _fn: any, args: any) => { scheduled.push({ delay, args }); } } };
  return { ctx, tables, scheduled, role: tables.org_roles[0] };
}

describe("orgEvents.enqueueRoleEvent", () => {
  test("fold rows collapse into one scheduled flush at the coalesce window", async () => {
    const { ctx, tables, scheduled } = world({ coalesce_ms: 1000 });
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task a moved" });
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task b moved" });
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "plan c moved" });
    expect(tables.role_wake_outbox).toHaveLength(3);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delay).toBeGreaterThan(0);
    expect(scheduled[0].delay).toBeLessThanOrEqual(1000);
  });

  test("an immediate row schedules the flush at once", async () => {
    const { ctx, scheduled } = world();
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "immediate", cause: "a person wrote" });
    expect(scheduled).toEqual([{ delay: 0, args: { role_id: "role1", attempt: 0 } }]);
  });

  test("a passive row is stored and never schedules", async () => {
    const { ctx, tables, scheduled } = world();
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "passive", cause: "hand settled done" });
    expect(tables.role_wake_outbox).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
  });

  test("the role's own writes (standing session or a hand) insert nothing", async () => {
    const { ctx, tables, scheduled } = world();
    expect(await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "x", actorConversationId: "standing" as any })).toBeNull();
    expect(await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "x", actorConversationId: "hand1" as any })).toBeNull();
    expect(await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "x", actorConversationId: "stranger" as any })).not.toBeNull();
    expect(tables.role_wake_outbox).toHaveLength(1);
    expect(scheduled).toHaveLength(1);
  });

  test("a subordinate role's writes never wake its parent; a parent's writes do wake the subordinate", async () => {
    const { ctx, tables } = world({}, {});
    tables.org_roles.push({
      _id: "role2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Deploys", handle: "deploys",
      scope: { project_ids: [], plan_ids: [] }, reports_to: { kind: "role", role_id: "role1" }, status: "active", anchor_id: "anchor2",
      created_by: ME, created_at: 1, updated_at: 1,
    });
    tables.anchors.push({ _id: "anchor2", scope_type: "team", team_id: TEAM, bot_user_id: "bot2", host_user_id: ME, conversation_id: "standing2", org_role_id: "role2", status: "active", name: "Deploys", created_at: 1 });
    tables.conversations.push({ _id: "standing2", user_id: ME, anchor_id: "anchor2", standing_role_id: "role2", session_id: "s2", short_id: "jxstan2", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 0 });
    expect(await actorIsExcluded(ctx, "role1", tables.conversations[3])).toBe(true);
    expect(await actorIsExcluded(ctx, "role2", tables.conversations[0])).toBe(false);
  });

  test("a paused role holds its rows: inserted, nothing scheduled", async () => {
    const { ctx, tables, scheduled } = world({ status: "paused" });
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "immediate", cause: "a person wrote" });
    expect(tables.role_wake_outbox).toHaveLength(1);
    expect(scheduled).toHaveLength(0);
  });
});

describe("orgWakes.performFlush", () => {
  test("over the wakes cap, fold rows are held and re-armed for the next day", async () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const { ctx, tables, scheduled } = world({ counters: { day, hands: 0, wakes: DEFAULT_CAPS.wakes_per_day, tokens: 0 } });
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task moved" });
      scheduled.length = 0;
      // The flush scheduled at the coalesce window fires with the row due.
      clock = NOW + 120_000;
      const out = await performFlush(ctx, "role1" as any);
      expect(out).toEqual({ outcome: "held", reason: "wakes_cap" });
      expect(tables.role_wakes.map((w: any) => w.status)).toEqual(["held"]);
      expect(tables.role_wake_outbox[0].flushed_at).toBeUndefined();
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].delay).toBeGreaterThan(60_000);
    } finally { Date.now = realNow; }
  });

  test("over the wakes cap, an immediate row still delivers one frame and the counter bumps", async () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const { ctx, tables, role } = world({ counters: { day, hands: 0, wakes: DEFAULT_CAPS.wakes_per_day, tokens: 0 } });
    const realNow = Date.now; Date.now = () => NOW;
    try {
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task moved" });
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "immediate", cause: "a person wrote: hello" });
      const out = await performFlush(ctx, "role1" as any);
      expect(out.outcome).toBe("delivered");
      expect(tables.pending_messages).toHaveLength(1);
      expect(tables.pending_messages[0].conversation_id).toBe("standing");
      expect(tables.pending_messages[0].content).toContain("## Why you are awake");
      expect(tables.pending_messages[0].content).toContain("a person wrote: hello");
      expect(tables.pending_messages[0].content).toContain("task moved");
      expect(tables.role_wake_outbox.every((r: any) => r.flushed_at === NOW)).toBe(true);
      expect(tables.role_wakes).toHaveLength(1);
      expect(tables.role_wakes[0].status).toBe("delivered");
      expect(countersFor(role, NOW).wakes).toBe(DEFAULT_CAPS.wakes_per_day + 1);
      expect(role.last_frame_seq).toBe(NOW);
    } finally { Date.now = realNow; }
  });

  test("a paused role holds at flush time", async () => {
    const { ctx, tables } = world({ status: "paused" });
    tables.role_wake_outbox.push({ _id: "ob1", role_id: "role1", kind: "immediate", cause: "x", created_at: 1, due_at: 1 });
    expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "held", reason: "paused" });
  });

  test("a busy agent is asked again in 30s", async () => {
    const { ctx, tables, scheduled } = world({}, { managed_sessions: [{ _id: "ms1", conversation_id: "standing", user_id: ME, agent_status: "working" }] });
    tables.role_wake_outbox.push({ _id: "ob1", role_id: "role1", kind: "immediate", cause: "x", created_at: 1, due_at: 1 });
    expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "rescheduled", attempt: 1 });
    expect(scheduled[0].delay).toBe(30_000);
    expect(scheduled[0].args.attempt).toBe(1);
  });

  test("fold rows with no new fact since the last frame are dropped, not delivered", async () => {
    const { ctx, tables } = world({ last_frame_seq: NOW + 10 });
    tables.role_wake_outbox.push({ _id: "ob1", role_id: "role1", kind: "fold", cause: "x", created_at: 1, due_at: 1 });
    const out = await performFlush(ctx, "role1" as any);
    expect(out.outcome).toBe("dropped");
    expect(tables.pending_messages).toHaveLength(0);
    expect(tables.role_wake_outbox[0].flushed_at).toBeDefined();
  });
});

describe("orgWakes.buildFrame", () => {
  const facts: BriefFacts = {
    scope: { projects: [{ id: "p1", title: "Infrastructure" }], plans: [], whole_workspace: false },
    tasks: { total: 4, open: 3, by_status: { open: 2, in_progress: 1, done: 1 }, by_priority: { high: 1, medium: 3 } },
    plans: [{ id: "pl1", short_id: "pl-9", title: "Move to Postgres", status: "active", updated_at: NOW, progress: { total: 3, done: 1, in_progress: 1, open: 1 } }],
    hands: [{ _id: "hand1" as any, short_id: "jxhand1", title: "Fix the deploy", state: "working", state_line: "checking CI", state_status: "working", state_at: NOW, updated_at: NOW, waiting_since: null, escalated: null, task: { short_id: "ct-5", title: "Deploy", status: "in_review", execution_status: "done", review_verdict: "changes" } }],
    changed: [{ kind: "task", short_id: "ct-5", title: "Deploy", status: "in_review", updated_at: NOW }],
    decisions: { open: 1, answered_today: 2 },
    usage: { day: "2027-01-01", wakes: 3, hands: 1, tokens: 1200, caps: { ...DEFAULT_CAPS }, uncounted_sessions: 0 },
    generated_at: NOW,
  };
  const base = (rows: any[], extra: Partial<FrameInput> = {}): FrameInput => ({
    role: { _id: "role1", short_id: "or-1", name: "Infra lead", handle: "infra-lead", trust: "direct", last_frame_seq: NOW - 1 },
    anchor: null, rows, facts, charter: { content: "# Charter" }, brief: { content: "state line\nStatus: fine" },
    channelLines: [], parentName: "Me", restart: false, now: NOW, ...extra,
  });

  test("Your sessions leads with the ones waiting on a person: the wait, longest first, and whether the role escalated it (R1)", () => {
    const H = 60 * 60 * 1000;
    const hand = (short: string, over: Record<string, any>) => ({ ...facts.hands[0], _id: short as any, short_id: short, title: `Work ${short}`, task: null, ...over });
    const f = buildFrame(base([{ kind: "fold", cause: "x" }], { facts: { ...facts, hands: [
      hand("jxwork1", {}),
      hand("jxwait1", { state: "needs_input", state_line: "which price?", waiting_since: NOW - 5 * H }),
      hand("jxwait2", { state: "needs_input", state_line: "copy is ready", waiting_since: NOW - 72 * H, escalated: { line: "the pricing copy needs your eye", at: NOW - H } }),
    ] } }));
    const section = f.text.slice(f.text.indexOf("## Your sessions"), f.text.indexOf("## Charter"));
    expect(section).toContain("Waiting on a person:");
    expect(section).toContain("- jxwait1 Work jxwait1: needs_input · waited 5h · not escalated — which price?");
    expect(section).toContain("- jxwait2 Work jxwait2: needs_input · waited 3d · escalated: the pricing copy needs your eye — copy is ready");
    // Longest wait first, then the rest.
    expect(section.indexOf("jxwait2")).toBeLessThan(section.indexOf("jxwait1"));
    expect(section.indexOf("The rest:")).toBeLessThan(section.indexOf("jxwork1"));
    expect(section.indexOf("jxwait1")).toBeLessThan(section.indexOf("The rest:"));
  });

  test("carries every section, marks passive rows, shows hand handoff status and verdict", () => {
    const f = buildFrame(base([
      { kind: "immediate", cause: "a person wrote: go" },
      { kind: "passive", cause: "decision sd-1 answered" },
    ]));
    for (const h of ["## You", "## Why you are awake", "## Your scope now", "## Your sessions", "## Charter"]) expect(f.text).toContain(h);
    expect(f.text).toContain("- a person wrote: go");
    expect(f.text).toContain("- (passive) decision sd-1 answered");
    expect(f.text).toContain("trust direct · reports to Me");
    expect(f.text).toContain("4/40 wakes · 1/6 hands · 1200/400000 tokens");
    expect(f.text).toContain("plan pl-9 Move to Postgres: 1/3 done");
    expect(f.text).toContain("task ct-5 Deploy → in_review");
    expect(f.text).toContain("jxhand1 Fix the deploy: working · ct-5 in_review (done) · review: changes — checking CI");
    expect(f.text).toContain("hash ");
    expect(f.text).not.toContain("## Brief");
    expect(f.hasNewFacts).toBe(true);
  });

  test("a restart frame carries the charter and brief in full; channel lines get their section", () => {
    const f = buildFrame(base([{ kind: "immediate", cause: "restart: session restarted" }], {
      restart: true,
      channelLines: [{ channel_name: "infra", author_name: "Ada", text: "deploy is red", message_id: "cm1", thread_root_id: undefined }],
    }));
    expect(f.text).toContain("## Brief\nstate line");
    expect(f.text).toContain("## Charter\n# Charter");
    expect(f.text).toContain("## Channels\n- #infra Ada: deploy is red (thread cm1)");
    expect(f.text).toContain("- session restarted");
  });

  test("facts past the budget collapse to a count", () => {
    // Hands have no line cap of their own, so they are what reaches the character ceiling.
    const many = Array.from({ length: 400 }, (_, i) => ({ ...facts.hands[0], _id: `hand${i}` as any, short_id: `jxhand${i}`, title: `A long title for hand number ${i} that fills the budget` }));
    const f = buildFrame(base([{ kind: "fold", cause: "x" }], { facts: { ...facts, hands: many } }));
    expect(f.text).toMatch(/- \+\d+ more/);
    expect(f.text.length).toBeLessThan(6000);
  });
});

describe("trust and caps on hands and answers (T4)", () => {
  test("understand refuses a hand start; direct allows it; over the cap refuses", async () => {
    const { ctx, tables } = world();
    const standing = tables.conversations[0];
    await expect(gateHandStart(ctx, standing)).rejects.toThrow(/understand stage and may not start hands/);
    tables.org_roles[0].trust = "direct";
    expect((await gateHandStart(ctx, standing))?._id).toBe("role1");
    tables.org_roles[0].counters = { day: new Date(Date.now()).toISOString().slice(0, 10), hands: DEFAULT_CAPS.hands_per_day, wakes: 0, tokens: 0 };
    await expect(gateHandStart(ctx, standing)).rejects.toThrow(/cap of 6 hands today/);
    tables.org_roles[0].status = "paused";
    await expect(gateHandStart(ctx, standing)).rejects.toThrow(/paused/);
    expect(await gateHandStart(ctx, tables.conversations[2])).toBeNull();
  });

  test("a role at understand may not answer a decision it holds", async () => {
    const { ctx, tables } = world({}, {
      session_decisions: [{
        _id: "sd1", short_id: "sd-1", conversation_id: "stranger", session_id: "s-other", user_id: ME, question: "Ship?", options: [{ label: "Yes" }, { label: "No" }],
        kind: "single", status: "pending", holder: { kind: "role", id: "role1" }, asked_user_ids: [ME], hops: [{ role_id: "role1", at: 1 }], created_at: 1,
      }],
    });
    const out = await answerCore(ctx, { userId: ME as any }, { decision_id: "sd-1", session_id: "s-standing", answer_index: 0 });
    expect(out.error).toMatch(/understand stage and may not answer/);
    expect(tables.session_decisions[0].status).toBe("pending");
  });
});

// ── Review fixes (W1 review, 16 findings) ────────────────────────────────────

import { performSetThreadState } from "./conversations";
import { performNeedsInputCheck } from "./notifications";
import { resolveActor } from "./lib/actor";
import { performSetCaps, performSetTrust, performUpdateRole, performBriefEdit, briefStateText } from "./orgRoles";
import { refuseRoleCharterWrite } from "./docs";
import { rollUpUsage } from "./messages";
import { enqueuePendingMessage } from "./pendingMessages";
import { resolveSessionConversation } from "./lib/access";
import { orgActorOf } from "./orgEvents";

describe("a hand's declaration wakes its role (review: hand is the subject)", () => {
  test("blocked inserts an immediate row, done a passive row; a stranger's declaration inserts nothing", async () => {
    const { ctx, tables, scheduled } = world();
    const hand = tables.conversations[1];
    await performSetThreadState(ctx, hand, "stuck on a permission prompt", "blocked");
    expect(tables.role_wake_outbox).toHaveLength(1);
    expect(tables.role_wake_outbox[0].kind).toBe("immediate");
    expect(tables.role_wake_outbox[0].cause).toContain("jxhand1");
    expect(tables.role_wake_outbox[0].cause).toContain("declared blocked");
    // The flush is armed at once (the live activity refresh is also scheduled).
    expect(scheduled.some((s) => s.args?.role_id === "role1" && s.delay === 0)).toBe(true);
    await performSetThreadState(ctx, hand, "shipped it", "done");
    expect(tables.role_wake_outbox).toHaveLength(2);
    expect(tables.role_wake_outbox[1].kind).toBe("passive");
    await performSetThreadState(ctx, tables.conversations[2], "nothing to do with roles", "blocked");
    expect(tables.role_wake_outbox).toHaveLength(2);
  });
});

describe("fold rows that land while another waits (review: pickup)", () => {
  test("the flush at the first window takes the later fold row too, and nothing is left behind", async () => {
    const { ctx, tables } = world({ coalesce_ms: 120_000 });
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task a moved" });
      clock = NOW + 100_000;
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task b moved" });
      clock = NOW + 120_000;
      const out = await performFlush(ctx, "role1" as any);
      expect(out.outcome).toBe("delivered");
      expect(tables.role_wake_outbox.every((r: any) => r.flushed_at === clock)).toBe(true);
      expect(tables.pending_messages[0].content).toContain("task a moved");
      expect(tables.pending_messages[0].content).toContain("task b moved");
      expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "noop", reason: "nothing_due" });
    } finally { Date.now = realNow; }
  });

  test("a passive row alone is a noop with a reason", async () => {
    const { ctx } = world();
    await enqueueRoleEvent(ctx, "role1" as any, { kind: "passive", cause: "x" });
    expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "noop", reason: "passive_only" });
  });
});

describe("stalled hand wake dedupe (review)", () => {
  const stalled = (extra: Record<string, any> = {}) => world({}, {
    managed_sessions: [{ _id: "ms1", conversation_id: "hand1", user_id: ME, agent_status: "permission_blocked", agent_status_updated_at: NOW, last_heartbeat: NOW, ...extra }],
  });
  test("three checks on one waiting episode insert one outbox row; a new episode inserts another", async () => {
    const { ctx, tables } = stalled();
    for (let i = 0; i < 3; i++) await performNeedsInputCheck(ctx, { conversation_id: "hand1" });
    expect(tables.role_wake_outbox.filter((r: any) => r.cause.includes("needs input"))).toHaveLength(1);
    expect(tables.conversations[1].hand_wake_notified_key).toBe("1:permission_blocked");
    tables.conversations[1].message_count = 2;
    await performNeedsInputCheck(ctx, { conversation_id: "hand1" });
    expect(tables.role_wake_outbox.filter((r: any) => r.cause.includes("needs input"))).toHaveLength(2);
  });
});

describe("identity follows the token (review: actor and charter guard)", () => {
  test("a teammate naming the standing session's id does not sign as the role; the host does", async () => {
    const { ctx, tables } = world();
    const standing = tables.conversations[0];
    const asHost = await resolveActor(ctx, ME as any, standing);
    expect(asHost.kind).toBe("role");
    expect(asHost.user_id).toBe("bot1" as any);
    const asMate = await resolveActor(ctx, "mate" as any, standing);
    expect(asMate.kind).toBe("user");
    expect(asMate.user_id).toBe("mate" as any);
    expect(asMate.role).toBeNull();
  });

  test("the charter guard refuses the role's own session on update and patch, and ignores a stranger's id", async () => {
    const { ctx, tables } = world({}, { docs: [{ _id: "charter1", user_id: ME, team_id: TEAM, title: "Charter", content: "x", doc_type: "charter" }] });
    tables.session_owners = [];
    const doc = tables.docs[0];
    await expect(refuseRoleCharterWrite(ctx, ME as any, doc, "s-standing")).rejects.toThrow(/written by people/);
    await expect(refuseRoleCharterWrite(ctx, ME as any, doc, "s-hand")).rejects.toThrow(/written by people/);
    await expect(refuseRoleCharterWrite(ctx, ME as any, doc, "s-other")).resolves.toBeUndefined();
    await expect(refuseRoleCharterWrite(ctx, ME as any, { ...doc, doc_type: "note" }, "s-standing")).resolves.toBeUndefined();
    await expect(refuseRoleCharterWrite(ctx, ME as any, doc, undefined)).resolves.toBeUndefined();
  });

  test("resolveSessionConversation names the actor for the post write hook only when the caller runs it", async () => {
    const { ctx, tables } = world();
    tables.session_owners = [];
    const c1: any = { db: ctx.db };
    expect((await resolveSessionConversation(c1, ME as any, "s-standing"))?._id).toBe("standing" as any);
    expect(orgActorOf(c1)?._id).toBe("standing");
  });
});

describe("human only gates (review: caps, charter field)", () => {
  test("caps, trust, scope and the charter field refuse a call that names its session; a browser call passes", async () => {
    const { ctx, tables } = world();
    await expect(performSetCaps(ctx, ME as any, { role_id: "role1", hands: 99, from_session: "s-standing" })).rejects.toThrow(/human only/);
    await expect(performSetTrust(ctx, ME as any, { role_id: "role1", trust: "direct", from_session: "s-standing" })).rejects.toThrow(/human only/);
    await expect(performUpdateRole(ctx, ME as any, { role_id: "role1", charter: "I decide", from_session: "s-standing" })).rejects.toThrow(/human only/);
    const web = { db: ctx.db, auth: { getUserIdentity: async () => ({ subject: ME }) } } as any;
    const ok = await performSetCaps(web, ME as any, { role_id: "role1", hands: 9 });
    expect(ok.caps.hands_per_day).toBe(9);
    expect(tables.org_roles[0].caps.hands_per_day).toBe(9);
  });
});

describe("usage counts once per assistant turn (review)", () => {
  const usage = { input_tokens: 100, output_tokens: 10 };
  test("records sharing a message id count once, across batches, and a resync patch counts nothing", async () => {
    const { ctx, tables, role } = world();
    const conv: any = tables.conversations[0];
    const patch1: Record<string, unknown> = {};
    await rollUpUsage(ctx, conv, [
      { usage, api_message_id: "msg_a", inserted: true },
      { usage, api_message_id: "msg_a", inserted: true },
      { usage, api_message_id: "msg_a", inserted: true },
    ], patch1, NOW);
    expect((patch1.usage_totals as any).input).toBe(100);
    expect((patch1.usage_totals as any).last_api_message_id).toBe("msg_a");
    expect(countersFor(role, NOW).tokens).toBe(110);
    Object.assign(conv, patch1);
    // The same turn's tail lands in the next batch: not counted again.
    const patch2: Record<string, unknown> = {};
    await rollUpUsage(ctx, conv, [{ usage, api_message_id: "msg_a", inserted: true }, { usage, api_message_id: "msg_b", inserted: true }], patch2, NOW);
    expect((patch2.usage_totals as any).input).toBe(200);
    Object.assign(conv, patch2);
    // A resync that patched existing rows carries usage but inserted nothing.
    const patch3: Record<string, unknown> = {};
    await rollUpUsage(ctx, conv, [{ usage, api_message_id: "msg_c", inserted: false }], patch3, NOW);
    expect(patch3.usage_totals).toBeUndefined();
    expect(countersFor(role, NOW).tokens).toBe(220);
  });
});

describe("a person's message to a standing session is held until the frame (review)", () => {
  test("the row is inserted as held, the flush writes the frame into it and releases it as pending", async () => {
    const { ctx, tables } = world();
    const standing = tables.conversations[0];
    const id: any = await enqueuePendingMessage(ctx, standing, ME as any, { content: "hello there", human: true });
    const row = tables.pending_messages.find((p: any) => p._id === id);
    expect(row.status).toBe("held");
    expect(tables.role_wake_outbox[0].pending_message_id).toBe(id);
    const out = await performFlush(ctx, "role1" as any);
    expect(out.outcome).toBe("delivered");
    expect(row.status).toBe("pending");
    expect(row.content).toContain("hello there");
    expect(row.content).toContain("## Why you are awake");
    expect(tables.pending_messages).toHaveLength(1);
  });

  test("a send the rail cannot wake for (a retired role) is released at once", async () => {
    const { ctx, tables } = world({ status: "retired" });
    const id: any = await enqueuePendingMessage(ctx, tables.conversations[0], ME as any, { content: "hi", human: true });
    expect(tables.pending_messages.find((p: any) => p._id === id).status).toBe("pending");
    expect(tables.role_wake_outbox).toHaveLength(0);
  });
});

describe("brief edit mirrors through the thread state path (review)", () => {
  test("first line plus labelled lines become the state, Status: word sets the status", async () => {
    expect(briefStateText("Infra: red build\nStatus: blocked on a key\nsome prose\nNext: rotate it")).toBe("Infra: red build\nStatus: blocked on a key\nNext: rotate it");
    const { ctx, tables } = world();
    tables.session_owners = [];
    const out = await performBriefEdit(ctx, ME as any, { role_id: "role1", content: "Infra: red build\nStatus: blocked on a key\n\nLong story.", from_session: "s-standing" });
    expect(out.status).toBe("blocked");
    expect(out.state).toBe("Infra: red build");
    expect(tables.conversations[0].thread_state).toBe("Infra: red build\nStatus: blocked on a key");
    expect(tables.conversations[0].thread_state_status).toBe("blocked");
  });
});

describe("pause is idempotent and interrupts only live hands (review minor)", () => {
  test("a second pause sends nothing; a dormant hand is not woken", async () => {
    const { performPauseRole } = await import("./orgRoles");
    const { ctx, tables } = world({}, { managed_sessions: [{ _id: "ms-hand", conversation_id: "hand1", user_id: ME, agent_status: "working" }] });
    tables.session_owners = [];
    const first = await performPauseRole(ctx, ME as any, { role_id: "role1" });
    expect(first.interrupted).toBe(1);
    expect(tables.pending_messages.filter((p: any) => p.conversation_id === "hand1")).toHaveLength(1);
    const second = await performPauseRole(ctx, ME as any, { role_id: "role1" });
    expect(second.interrupted).toBe(0);
    expect(tables.pending_messages.filter((p: any) => p.conversation_id === "hand1")).toHaveLength(1);
  });
});

// ── Final product review (6 findings) ───────────────────────────────────────

import { ROLE_RULES, charterTemplate, performRetireRole, refuseUnlessHuman } from "./orgRoles";
import { handBriefing } from "./spawn";
import { bootstrapMessage } from "./anchors";

const humanCtx = (db: any) => ({ db, auth: { getUserIdentity: async () => ({ subject: ME }) } }) as any;
const tokenCtx = (db: any) => ({ db, auth: { getUserIdentity: async () => null } }) as any;

describe("human only writes key on the browser identity (review: identity)", () => {
  test("an api token call is refused even with no from_session; a browser call passes", async () => {
    const { tables } = world();
    await expect(refuseUnlessHuman(tokenCtx(makeFakeDb(tables)), { api_token: "tok" }, "Trust stage")).rejects.toThrow(/human only/);
    await expect(refuseUnlessHuman(tokenCtx(makeFakeDb(tables)), {}, "Trust stage")).rejects.toThrow(/human only/);
    await expect(refuseUnlessHuman(humanCtx(makeFakeDb(tables)), {}, "Trust stage")).resolves.toBeUndefined();
    await expect(refuseUnlessHuman(humanCtx(makeFakeDb(tables)), { from_session: "s-standing" }, "Trust stage")).rejects.toThrow(/agent session/);
  });

  test("a hand stripping its env still cannot raise its own trust or caps through the token path", async () => {
    const { tables } = world();
    const ctx = tokenCtx(makeFakeDb(tables));
    await expect(performSetTrust(ctx, ME as any, { role_id: "role1", trust: "direct", api_token: "tok" })).rejects.toThrow(/human only/);
    await expect(performSetCaps(ctx, ME as any, { role_id: "role1", hands: 99, api_token: "tok" })).rejects.toThrow(/human only/);
    await expect(performUpdateRole(ctx, ME as any, { role_id: "role1", charter: "mine", api_token: "tok" })).rejects.toThrow(/human only/);
    const web = humanCtx(makeFakeDb(tables));
    expect((await performSetTrust(web, ME as any, { role_id: "role1", trust: "direct" })).trust).toBe("direct");
  });
});

describe("brief edit needs the session the caller runs (review: identity)", () => {
  test("a plain member naming the standing session's id is refused; the host's own session passes", async () => {
    const { ctx, tables } = world();
    tables.users.push({ _id: "mate", name: "Mate" });
    tables.team_memberships.push({ _id: "m2", user_id: "mate", team_id: TEAM, role: "member", joined_at: 1 });
    tables.session_owners = [];
    await expect(performBriefEdit(ctx, "mate" as any, { role_id: "role1", content: "hijacked", from_session: "s-standing" })).rejects.toThrow(/own session or an admin/);
    const ok = await performBriefEdit(ctx, ME as any, { role_id: "role1", content: "Infra: fine\nStatus: working", from_session: "s-standing" });
    expect(ok.mirrored).toBe(true);
    expect(tables.conversations[0].thread_state).toContain("Infra: fine");
  });
});

describe("retire tears the seat down (review: founder first week)", () => {
  test("live hands are told, routines cancelled, held turns dropped, the anchor decommissioned, and it is idempotent", async () => {
    const { ctx, tables } = world({}, {
      managed_sessions: [{ _id: "ms-hand", conversation_id: "hand1", user_id: ME, agent_status: "working" }],
      agent_tasks: [{ _id: "tr1", short_id: "tr-1", user_id: ME, originating_conversation_id: "standing", status: "scheduled", title: "digest", prompt: "post", run_at: NOW, run_count: 0 }],
      anchor_channels: [],
      daemon_commands: [],
    });
    tables.session_owners = [];
    tables.pending_messages.push({ _id: "pm-held", conversation_id: "standing", from_user_id: ME, owner_user_id: ME, content: "hi", status: "held", created_at: 1, retry_count: 0 });
    tables.role_wake_outbox.push({ _id: "ob1", role_id: "role1", kind: "fold", cause: "x", created_at: 1, due_at: 1 });
    const out = await performRetireRole(ctx, ME as any, { role_id: "role1" });
    expect(out.status).toBe("retired");
    expect(out.interrupted).toBe(1);
    expect(out.cancelled_triggers).toBe(1);
    expect(tables.pending_messages.some((p: any) => p.conversation_id === "hand1" && p.content.includes("role-retired"))).toBe(true);
    expect(tables.agent_tasks[0].status).toBe("cancelled");
    expect(tables.pending_messages.find((p: any) => p._id === "pm-held").status).toBe("cancelled");
    expect(tables.anchors[0].status).toBe("decommissioned");
    expect(tables.conversations[0].status).toBe("completed");
    expect(tables.role_wake_outbox).toHaveLength(0);
    expect(tables.conversations[1].org_role_id).toBeUndefined();
    const again = await performRetireRole(ctx, ME as any, { role_id: "role1" });
    expect(again.interrupted).toBe(0);
  });
});

describe("a hand's briefing and the anchor's roles section (review: coherence, day scenario)", () => {
  test("handBriefing opens with the mandate and names handoff, verdict and decide --task", () => {
    const text = handBriefing({ name: "Infra lead", handle: "infra-lead" }, "Fix the deploy", "ct-5");
    expect(text.startsWith("This is an UNATTENDED run")).toBe(true);
    expect(text).toContain("hand of Infra lead (@infra-lead)");
    expect(text).toContain("cast task handoff ct-5 --status done|blocked|needs_context");
    expect(text).toContain("cast task verdict ct-5");
    expect(text).toContain("cast decide --task ct-5");
    expect(text.endsWith("Fix the deploy")).toBe(true);
  });

  test("the team anchor's bootstrap tells it to read role briefs and never wake a role for status", () => {
    const text = bootstrapMessage({ name: "Anchor", scopeType: "team", scopeLabel: "the Acme workspace", teamName: "Acme" });
    expect(text).toContain("## Roles that report into this workspace");
    expect(text).toContain("cast brief @handle");
    expect(text).toContain("Never wake");
    const roleText = bootstrapMessage({ name: "Infra lead", scopeType: "team", scopeLabel: "x", teamName: "Acme", role: { handle: "infra-lead", scopeNames: [], parentName: "Me", trust: "understand" } });
    expect(roleText).not.toContain("## Roles that report into this workspace");
  });

  // The scope is a conversation (scopes-and-feed.md F4.2, F4.4): the role is
  // told, at the principle level, to say where a person's message went, to
  // say only what it did, to take a redirect in plain words, and to treat
  // remember and forget as brief writes. The charter carries the same rule so
  // it survives compaction; the rule text is pinned, never the phrasing of a
  // reply (dry runs prove that: /tmp/scopeconv/dryrun).
  test("a role's bootstrap says where a message went, only what it did, and that remembering is a brief write", () => {
    // The briefing wraps its lines; a phrase is read across the wrap.
    const text = bootstrapMessage({ name: "Infra lead", scopeType: "team", scopeLabel: "x", teamName: "Acme", role: { handle: "infra-lead", scopeNames: ["project Infrastructure"], parentName: "Me", trust: "direct" } }).replace(/\s+/g, " ");
    expect(text).toContain("## When a person writes to you");
    expect(text).toContain("answers them here or moves the work into a hand");
    expect(text).toContain("says which, in your own words, in the same turn");
    expect(text).toContain("in the text you write back: your pinned state and your brief are status");
    expect(text).toContain("Never start work in silence");
    expect(text).toContain("never ask for a permission you already hold");
    expect(text).toContain("Say only what you did");
    expect(text).toContain("redirect you in plain words");
    expect(text).toContain("Remembering is something a person says");
    expect(text).toContain("forgetting is removing the line, not adding a note");
    // What belongs in the brief and what does not.
    expect(text).toContain("decisions with the reason they were taken");
    expect(text).toContain("Not status, not a log of what happened");
    // The workspace anchor is not a role and gets none of it.
    const anchor = bootstrapMessage({ name: "Anchor", scopeType: "team", scopeLabel: "x", teamName: "Acme" });
    expect(anchor).not.toContain("## When a person writes to you");
  });

  test("the charter template carries the routing rule so a restart frame re-reads it", () => {
    const charter = charterTemplate({ name: "Infra lead", handle: "infra-lead" }, ["project Infrastructure"], "Me");
    expect(ROLE_RULES).toHaveLength(6);
    expect(charter).toContain("5. A person's message is answered here or handed on to a hand, and the reply says which");
    expect(charter).toContain("a request to remember or forget is a brief write in the same turn");
    // The triage rule (org-roles-run-work.md R1) rides the same template.
    expect(charter).toContain("6. Your sessions stay out of a person's inbox");
  });

  test("the role bootstrap carries the triage principle: why, the two commands, and no scripted line (R1)", () => {
    const text = bootstrapMessage({ name: "Growth", scopeType: "team", scopeLabel: "Acme", teamName: "Acme", role: { handle: "growth", parentName: "Me", scopeNames: ["project Growth"], trust: "decide" } as any });
    expect(text).toContain("Your sessions are yours to triage");
    expect(text).toContain("a wait nobody can see");
    expect(text).toContain('cast escalate <session> "<one line>"');
    expect(text).toContain("cast escalate --clear <session>");
    expect(text).toContain("says what they will decide");
    // The frame section the rule points at is named as the frame names it.
    expect(text).toContain("your scope\n  now, your sessions");
    // The workspace anchor has no sessions to triage.
    expect(bootstrapMessage({ name: "Anchor", scopeType: "team", scopeLabel: "x", teamName: "Acme" })).not.toContain("cast escalate");
  });
});

// ── Chief of staff review: one row per (table, id) per window ────────────────

describe("a task patched many times in one window wakes once with one line (ct-51491)", () => {
  test("seven fold rows for one ref collapse to one row, one flush, one frame line", async () => {
    const { ctx, tables, scheduled } = world({ coalesce_ms: 120_000 });
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      const statuses = ["open", "in_progress", "in_progress", "in_review", "in_review", "in_review", "done"];
      for (const [i, status] of statuses.entries()) {
        clock = NOW + i * 10_000;
        await enqueueRoleEvent(ctx, "role1" as any, {
          kind: "fold",
          cause: `task ct-5 "Deploy" is ${status}`,
          ref: { table: "tasks", id: "tasks_5", short_id: "ct-5" },
        });
      }
      const unflushed = tables.role_wake_outbox.filter((r: any) => !r.flushed_at);
      expect(unflushed).toHaveLength(1);
      // The surviving row carries the newest cause and keeps the FIRST due
      // time, so a task that keeps moving cannot push its own wake forever.
      expect(unflushed[0].cause).toContain("is done");
      expect(unflushed[0].due_at).toBe(NOW + 120_000);
      expect(scheduled.filter((s) => s.args?.role_id === "role1")).toHaveLength(1);
      clock = NOW + 120_000;
      const out = await performFlush(ctx, "role1" as any);
      expect(out.outcome).toBe("delivered");
      const frame = tables.pending_messages[0].content;
      expect(frame.split("ct-5 \"Deploy\"").length - 1).toBe(1);
      expect(tables.role_wakes).toHaveLength(1);
    } finally { Date.now = realNow; }
  });

  test("two different refs still get their own lines in one frame", async () => {
    const { ctx, tables } = world({ coalesce_ms: 120_000 });
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task ct-5 moved", ref: { table: "tasks", id: "tasks_5" } });
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task ct-6 moved", ref: { table: "tasks", id: "tasks_6" } });
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task ct-5 moved again", ref: { table: "tasks", id: "tasks_5" } });
      expect(tables.role_wake_outbox.filter((r: any) => !r.flushed_at)).toHaveLength(2);
      clock = NOW + 120_000;
      await performFlush(ctx, "role1" as any);
      const frame = tables.pending_messages[0].content;
      expect(frame).toContain("ct-5 moved again");
      expect(frame).toContain("ct-6 moved");
      expect(frame).not.toContain("- task ct-5 moved\n");
    } finally { Date.now = realNow; }
  });
});

// ── ct-51491 addendum: the post write hook and the frame count repeats ───────

import { attachOrgWriteCollector, flushOrgWrites, makeOrgWriteTrackedDb, markOrgActor } from "./orgEvents";

// One mutation on the fake db, the way functions.ts runs every mutation: the
// wrapped db records the task writes and the post write hook fans them out
// once the handler returns.
async function mutation(ctx: any, actor: any | null, fn: (db: any) => Promise<void>): Promise<void> {
  const wrapped: any = { db: ctx.db, scheduler: ctx.scheduler };
  wrapped.db = makeOrgWriteTrackedDb(ctx.db, attachOrgWriteCollector(wrapped));
  markOrgActor(wrapped, actor);
  await fn(wrapped.db);
  await flushOrgWrites(wrapped);
}

const TASK = { _id: "task5", short_id: "ct-5", title: "Deploy", status: "open", priority: "high", project_id: "p1", team_id: TEAM, user_id: ME, workspace: `team:${TEAM}`, created_at: NOW - 5, updated_at: NOW - 5 };
const scopedWorld = (roleExtra: Record<string, any> = {}) => world(
  { scope: { project_ids: ["p1"], plan_ids: [] }, coalesce_ms: 120_000, ...roleExtra },
  { projects: [{ _id: "p1", title: "Sync & Reliability", team_id: TEAM, user_id: ME, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }], tasks: [{ ...TASK }] },
);
const whyLines = (frame: string) => frame.split("## Your scope now")[0].split("\n").filter((l) => l.startsWith("- "));
const changedLines = (frame: string) => (frame.split("Changed since your last frame:")[1] ?? "").split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));
const unflushed = (tables: any) => tables.role_wake_outbox.filter((r: any) => !r.flushed_at);

describe("a task patched seven times across seven mutations is one line with a count (ct-51491)", () => {
  test("one outbox row, one wake, one why line saying how often, one entry in the changes list", async () => {
    const { ctx, tables, scheduled } = scopedWorld();
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      const statuses = ["in_progress", "in_progress", "in_review", "in_review", "in_review", "in_review", "done"];
      for (const [i, status] of statuses.entries()) {
        clock = NOW + i * 10_000;
        await mutation(ctx, tables.conversations[2], (db) => db.patch("task5", { status, updated_at: clock }));
      }
      expect(unflushed(tables)).toHaveLength(1);
      expect(unflushed(tables)[0].count).toBe(7);
      expect(scheduled.filter((s) => s.args?.role_id === "role1")).toHaveLength(1);
      clock = NOW + 120_000;
      const out = await performFlush(ctx, "role1" as any);
      expect(out.outcome).toBe("delivered");
      const frame = tables.pending_messages[0].content;
      expect(whyLines(frame)).toEqual([`- task ct-5 "Deploy" is done (changed 7 times)`]);
      expect(changedLines(frame)).toEqual(["- task ct-5 Deploy → done"]);
      expect(tables.role_wakes).toHaveLength(1);
      expect(tables.role_wakes[0].causes).toEqual([`task ct-5 "Deploy" is done (changed 7 times)`]);
      expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "noop", reason: "nothing_due" });
    } finally { Date.now = realNow; }
  });

  test("two patches inside one mutation are one change: one row, no count", async () => {
    const { ctx, tables } = scopedWorld();
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await mutation(ctx, tables.conversations[2], async (db) => {
        await db.patch("task5", { status: "in_progress", updated_at: clock });
        await db.patch("task5", { priority: "low", updated_at: clock });
      });
      expect(unflushed(tables)).toHaveLength(1);
      expect(unflushed(tables)[0].count).toBeUndefined();
      clock = NOW + 120_000;
      await performFlush(ctx, "role1" as any);
      expect(whyLines(tables.pending_messages[0].content)).toEqual([`- task ct-5 "Deploy" is in_progress`]);
    } finally { Date.now = realNow; }
  });

  test("a hand's handoff (the status move, then its comment) is one row for the other role, none for its own", async () => {
    const { ctx, tables } = scopedWorld();
    tables.org_roles.push({
      _id: "role2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth", handle: "growth",
      scope: { project_ids: ["p1"], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor2", coalesce_ms: 120_000,
      created_by: ME, created_at: 1, updated_at: 1,
    });
    tables.anchors.push({ _id: "anchor2", scope_type: "team", team_id: TEAM, bot_user_id: "bot2", host_user_id: ME, conversation_id: "standing2", org_role_id: "role2", status: "active", name: "Growth", created_at: 1 });
    tables.conversations.push(
      { _id: "standing2", user_id: ME, anchor_id: "anchor2", standing_role_id: "role2", session_id: "s2", short_id: "jxstan2", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 0, team_id: TEAM },
      { _id: "hand2", user_id: ME, org_role_id: "role2", session_id: "s-hand2", short_id: "jxhand2", status: "active", agent_type: "claude_code", updated_at: NOW, message_count: 1, title: "Ship it", team_id: TEAM },
    );
    const hand2 = tables.conversations.find((c: any) => c._id === "hand2");
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await mutation(ctx, hand2, (db) => db.patch("task5", { status: "in_review", execution_status: "done", updated_at: clock }));
      clock = NOW + 1_000;
      await mutation(ctx, hand2, (db) => db.patch("task5", { comment_count: 1, updated_at: clock }));
      const rows = unflushed(tables);
      expect(rows.map((r: any) => r.role_id)).toEqual(["role1"]);
      expect(rows[0].count).toBe(2);
      expect(rows[0].cause).toBe(`task ct-5 "Deploy" is in_review`);
    } finally { Date.now = realNow; }
  });

  test("a task in several roles' scopes inserts one row per role", async () => {
    const { ctx, tables } = scopedWorld();
    tables.org_roles.push({
      _id: "role2", short_id: "or-2", scope_type: "team", team_id: TEAM, host_user_id: ME, name: "Growth", handle: "growth",
      scope: { project_ids: ["p1"], plan_ids: [] }, reports_to: { kind: "user", user_id: ME }, status: "active", anchor_id: "anchor2",
      created_by: ME, created_at: 1, updated_at: 1,
    });
    tables.anchors.push({ _id: "anchor2", scope_type: "team", team_id: TEAM, bot_user_id: "bot2", host_user_id: ME, conversation_id: "standing2", org_role_id: "role2", status: "active", name: "Growth", created_at: 1 });
    await mutation(ctx, tables.conversations[2], (db) => db.patch("task5", { status: "in_progress", updated_at: NOW }));
    await mutation(ctx, tables.conversations[2], (db) => db.patch("task5", { status: "in_review", updated_at: NOW + 1 }));
    const rows = unflushed(tables);
    expect(rows.map((r: any) => r.role_id).sort()).toEqual(["role1", "role2"]);
    expect(rows.map((r: any) => r.count)).toEqual([2, 2]);
  });

  test("a busy agent's reschedule re-inserts nothing; a repeat during the wait folds into the waiting row", async () => {
    const { ctx, tables, scheduled } = world({ coalesce_ms: 120_000 }, { managed_sessions: [{ _id: "ms1", conversation_id: "standing", user_id: ME, agent_status: "working" }] });
    const realNow = Date.now; let clock = NOW; Date.now = () => clock;
    try {
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task ct-5 moved", ref: { table: "tasks", id: "task5" } });
      clock = NOW + 120_000;
      expect(await performFlush(ctx, "role1" as any)).toEqual({ outcome: "rescheduled", attempt: 1 });
      expect(await performFlush(ctx, "role1" as any, 1)).toEqual({ outcome: "rescheduled", attempt: 2 });
      expect(tables.role_wake_outbox).toHaveLength(1);
      await enqueueRoleEvent(ctx, "role1" as any, { kind: "fold", cause: "task ct-5 moved again", ref: { table: "tasks", id: "task5" } });
      expect(tables.role_wake_outbox).toHaveLength(1);
      expect(tables.role_wake_outbox[0].count).toBe(2);
      expect(tables.role_wake_outbox[0].due_at).toBe(NOW + 120_000);
      // The retries are the only flushes armed after the first window.
      expect(scheduled.filter((s) => s.args?.role_id === "role1").map((s) => s.args.attempt)).toEqual([0, 1, 2]);
    } finally { Date.now = realNow; }
  });
});

// ── ct-51592: a released backlog reads as a digest ──────────────────────────

import { FRAME_WHY_LINES, FRAME_PLAN_LINES, FRAME_CHANGED_LINES, groupRowsForFrame } from "./orgWakes";

describe("the frame collapses a backlog by ref and caps each section (ct-51592)", () => {
  const facts: BriefFacts = {
    scope: { projects: [], plans: [], whole_workspace: false },
    tasks: { total: 0, open: 0, by_status: {}, by_priority: {} },
    plans: [], hands: [], changed: [],
    decisions: { open: 0, answered_today: 0 },
    usage: { day: "2027-01-01", wakes: 0, hands: 0, tokens: 0, caps: { ...DEFAULT_CAPS }, uncounted_sessions: 0 },
    generated_at: NOW,
  };
  const input = (rows: any[], extra: Partial<BriefFacts> = {}): FrameInput => ({
    role: { _id: "role1", short_id: "or-1", name: "Infra lead", handle: "infra-lead", last_frame_seq: NOW - 1 },
    anchor: null, rows, facts: { ...facts, ...extra }, charter: null, brief: null, channelLines: [], parentName: "Me", restart: false, now: NOW,
  });
  const why = (text: string) => text.split("## Why you are awake\n")[1].split("\n\n")[0].split("\n");
  const section = (text: string, label: string) => (text.split(`${label}\n`)[1] ?? "").split("\n\n")[0].split("\n").filter((l) => l.startsWith("- "));

  test("40 backlog rows over 9 refs render 9 lines, latest state, counts summed, newest first", () => {
    const rows: any[] = [];
    // Nine tasks; the first gets 12 rows (one carrying a merged count), the rest share the remainder.
    const per = [12, 5, 5, 4, 4, 3, 3, 2, 2];
    let t = 0;
    per.forEach((n, ref) => {
      for (let i = 0; i < n; i++, t++) {
        rows.push({ kind: "fold", cause: `task ct-${ref} "T${ref}" is ${i === n - 1 ? "done" : "in_progress"}`, ref: { table: "tasks", id: `task${ref}` }, created_at: NOW - 1000 + t, count: ref === 0 && i === 0 ? 3 : undefined });
      }
    });
    expect(rows).toHaveLength(40);
    const lines = why(buildFrame(input(rows)).text);
    expect(lines).toHaveLength(9);
    // Newest first: ref 8's last row is the newest, ref 0's the oldest.
    expect(lines[0]).toBe(`- task ct-8 "T8" is done (changed 2 times)`);
    expect(lines[8]).toBe(`- task ct-0 "T0" is done (changed 14 times)`);
    expect(lines.every((l) => l.includes("is done"))).toBe(true);
  });

  test("rows without a ref (a person's message) keep their own line; passive groups stay marked", () => {
    const lines = why(buildFrame(input([
      { kind: "immediate", cause: "a person wrote: go", created_at: NOW - 5 },
      { kind: "passive", cause: "hand jxhand1 settled done", ref: { table: "conversations", id: "hand1" }, created_at: NOW - 4 },
      { kind: "passive", cause: "hand jxhand1 settled done again", ref: { table: "conversations", id: "hand1" }, created_at: NOW - 3 },
      { kind: "immediate", cause: "a person wrote: go", created_at: NOW - 2 },
    ])).text);
    expect(lines).toEqual([
      "- a person wrote: go",
      "- (passive) hand jxhand1 settled done again (changed 2 times)",
      "- a person wrote: go",
    ]);
    expect(groupRowsForFrame([])).toEqual([]);
  });

  test("past the why cap the rest becomes one count line", () => {
    const rows = Array.from({ length: FRAME_WHY_LINES + 4 }, (_, i) => ({ kind: "fold", cause: `task ct-${i} moved`, ref: { table: "tasks", id: `t${i}` }, created_at: NOW + i }));
    const lines = why(buildFrame(input(rows)).text);
    expect(lines).toHaveLength(FRAME_WHY_LINES + 1);
    expect(lines[FRAME_WHY_LINES]).toBe("- and 4 more changes");
  });

  test("done plans never show; active and draft are capped with a count", () => {
    const plan = (i: number, status: string) => ({ id: `pl${i}`, short_id: `pl-${i}`, title: `Plan ${i}`, status, updated_at: NOW, progress: { total: 2, done: status === "done" ? 2 : 1, in_progress: 0, open: 1 } });
    const plans = [
      ...Array.from({ length: 10 }, (_, i) => plan(i, "done")),
      ...Array.from({ length: 5 }, (_, i) => plan(100 + i, "active")),
      ...Array.from({ length: 5 }, (_, i) => plan(200 + i, "draft")),
    ];
    const lines = section(buildFrame(input([{ kind: "fold", cause: "x" }], { plans })).text, "Plans:");
    expect(lines).toHaveLength(FRAME_PLAN_LINES + 1);
    expect(lines.some((l) => l.includes("(done)"))).toBe(false);
    expect(lines[FRAME_PLAN_LINES]).toBe(`- and ${10 - FRAME_PLAN_LINES} more plans`);
    const onlyDone = buildFrame(input([{ kind: "fold", cause: "x" }], { plans: plans.slice(0, 10) })).text;
    expect(onlyDone).not.toContain("Plans:");
  });

  test("the changes list is capped with a count", () => {
    const changed = Array.from({ length: FRAME_CHANGED_LINES + 3 }, (_, i) => ({ kind: "task" as const, short_id: `ct-${i}`, title: `T${i}`, status: "open", updated_at: NOW + i }));
    const lines = section(buildFrame(input([{ kind: "fold", cause: "x" }], { changed })).text, "Changed since your last frame:");
    expect(lines).toHaveLength(FRAME_CHANGED_LINES + 1);
    expect(lines[FRAME_CHANGED_LINES]).toBe("- and 3 more changes");
  });
});
