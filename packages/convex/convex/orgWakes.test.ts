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
    hands: [{ _id: "hand1" as any, short_id: "jxhand1", title: "Fix the deploy", state: "working", state_line: "checking CI", state_status: "working", state_at: NOW, updated_at: NOW, task: { short_id: "ct-5", title: "Deploy", status: "in_review", execution_status: "done", review_verdict: "changes" } }],
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

  test("carries every section, marks passive rows, shows hand handoff status and verdict", () => {
    const f = buildFrame(base([
      { kind: "immediate", cause: "a person wrote: go" },
      { kind: "passive", cause: "decision sd-1 answered" },
    ]));
    for (const h of ["## You", "## Why you are awake", "## Your scope now", "## Hands say", "## Charter"]) expect(f.text).toContain(h);
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
    const many = Array.from({ length: 400 }, (_, i) => ({ kind: "task" as const, short_id: `ct-${i}`, title: `A long title for task number ${i} that fills the budget`, status: "open", updated_at: NOW }));
    const f = buildFrame(base([{ kind: "fold", cause: "x" }], { facts: { ...facts, changed: many } }));
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
