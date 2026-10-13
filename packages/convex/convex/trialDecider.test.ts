// Who a trial decision is for (sessionDecisions.routeFor, lib/trialDecision
// trialDeciderOf). A product run's decision is the trial owner's practice
// answer, in nobody's queue. A judge-route run's decision (a fix to the judges
// every conversation is graded by) is the role the trial names for that route:
// it climbs that role's line, so the person it reaches is the one the role
// reports to, never the trial's owner. Driven against the fake db, the way
// lineTrial.test.ts drives the trial rail.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { pauseAtGateCore } from "./workflow_runs";
import { askCore } from "./sessionDecisions";
import { audienceOf } from "./lineTrial";

const OWNER = "users_owner" as any;
const LEAD_PERSON = "users_lead_person" as any;
const TEAM = "teams_acme" as any;
const RUN = "workflow_runs_run";
const TASK = "tasks_t1";
const TRIAL = "projects_trial";
const ROLE = "org_roles_quality";
const NOW = 1_800_000_000_000;

const judgeChoices = [
  { key: "P", label: "[P] Publish", target: "publish" },
  { key: "R", label: "[R] Revise", target: "revise" },
  { key: "N", label: "[N] Not now", target: "not_now" },
];

function seed(opts: { route: "judge" | "product"; decides?: boolean; roleStatus?: string }) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }, { _id: LEAD_PERSON, name: "Lead's person" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: OWNER, team_id: TEAM, role: "admin" },
      { _id: "m2", user_id: LEAD_PERSON, team_id: TEAM, role: "admin" },
    ],
    projects: [{
      _id: TRIAL, title: "AgentWatch Trial", user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`, status: "active", created_at: NOW, updated_at: NOW,
      line_trial: { since: NOW - 1000, by: OWNER, judge: { graph: "/g/judge.cast", cwd: "/g", name: "agentwatch_trial_judge", ...(opts.decides ? { decides: ROLE } : {}) } },
    }],
    org_roles: [{
      _id: ROLE, short_id: "or-39", name: "Agent Quality lead", handle: "agent-quality", team_id: TEAM, status: opts.roleStatus ?? "active",
      reports_to: { kind: "user", user_id: LEAD_PERSON }, created_at: NOW,
    }],
    conversations: [
      { _id: "conversations_primary", session_id: `wf-${RUN}`, user_id: OWNER, team_id: TEAM, message_count: 1, workflow_run_id: RUN, is_workflow_primary: true },
      { _id: "conversations_station", session_id: "sess-station", short_id: "jx7stat", user_id: OWNER, team_id: TEAM, message_count: 3, parent_conversation_id: "conversations_primary" },
    ],
    tasks: [{ _id: TASK, short_id: "ct-7", user_id: OWNER, team_id: TEAM, workspace: `team:${TEAM}`, project_id: TRIAL, title: "A judge flags good intros", status: "in_progress", task_type: "task", priority: "medium", workflow_run_id: RUN }],
    workflow_runs: [{
      _id: RUN, user_id: OWNER, task_id: TASK, status: "running", node_statuses: [], workspace: `team:${TEAM}`, team_id: TEAM,
      workflow_name: opts.route === "judge" ? "agentwatch_trial_judge" : "agentwatch_trial",
      primary_conversation_id: "conversations_primary", created_at: NOW, updated_at: NOW,
    }],
    trial_cards: [], messages: [], session_decisions: [], decision_inbox: [], decision_grants: [], decision_stacks: [], docs: [], counters: [],
    session_owners: [], directory_team_mappings: [], pending_messages: [], daemon_commands: [], anchors: [],
  };
  return { ctx: { db: makeFakeDb(tables), scheduler: { runAfter: async () => null } } as any, tables };
}

const post = (ctx: any) => askCore(ctx, { userId: OWNER }, {
  session_id: "sess-station",
  question: "Should the comms judge stop calling a short intro rude?",
  options: [{ label: "Publish the edit :: it clears 4 of 5 reads" }, { label: "Not now :: one ruled message" }],
  report_slug: "page-1",
});
const inboxOf = (tables: Record<string, any[]>) => tables.decision_inbox.map((r) => String(r.user_id));

describe("a judge fix is the decider role's, never the trial owner's", () => {
  test("a judge-route station's decision climbs the decider's line: its ladder names the role, its person is asked, the owner is not", async () => {
    const { ctx, tables } = seed({ route: "judge", decides: true });
    const posted: any = await post(ctx);
    expect(posted.error).toBeUndefined();
    const d = tables.session_decisions[0];
    expect(d.trial).toBe(true);
    expect(d.hops.map((h: any) => h.role_id)).toEqual([ROLE]);
    expect(d.asked_user_ids.map(String)).toEqual([String(LEAD_PERSON)]);
    // The role has no standing session to hear it, so it lands with its line's person at once, and nowhere else.
    expect(inboxOf(tables)).toEqual([String(LEAD_PERSON)]);
    expect(inboxOf(tables)).not.toContain(String(OWNER));
  });

  test("the gate that adopts it keeps it the role's, and the trial card's decision carries the same people", async () => {
    const { ctx, tables } = seed({ route: "judge", decides: true });
    await post(ctx);
    const r: any = await pauseAtGateCore(ctx, { userId: OWNER }, { run_id: RUN as any, node_id: "review", prompt: "Publish?", choices: judgeChoices, asker_session_id: "jx7stat" });
    expect(r.ok).toBe(true);
    const d = tables.session_decisions[0];
    expect(tables.session_decisions).toHaveLength(1);
    expect(d.hops.map((h: any) => h.role_id)).toEqual([ROLE]);
    expect(d.asked_user_ids.map(String)).toEqual([String(LEAD_PERSON)]);
    expect(inboxOf(tables)).toEqual([String(LEAD_PERSON)]);
    expect(tables.trial_cards[0].decision_id).toBe(d._id);
  });

  test("a judge route asked from the run's own conversation, with nothing posted, is the role's too", async () => {
    const { ctx, tables } = seed({ route: "judge", decides: true });
    const r: any = await pauseAtGateCore(ctx, { userId: OWNER }, { run_id: RUN as any, node_id: "review", prompt: "Publish?", choices: judgeChoices });
    expect(r.ok).toBe(true);
    expect(tables.session_decisions[0].asked_user_ids.map(String)).toEqual([String(LEAD_PERSON)]);
    expect(inboxOf(tables)).not.toContain(String(OWNER));
  });

  test("a product run's decision stays the owner's practice answer: no ladder, nobody's inbox", async () => {
    const { ctx, tables } = seed({ route: "product", decides: true });
    await post(ctx);
    const d = tables.session_decisions[0];
    expect(d.hops).toEqual([]);
    expect(d.asked_user_ids.map(String)).toEqual([String(OWNER)]);
    expect(tables.decision_inbox).toHaveLength(0);
  });

  test("a trial naming no decider, or one whose decider is paused, keeps the judge fix the owner's", async () => {
    for (const opts of [{ decides: false }, { decides: true, roleStatus: "paused" }]) {
      const { ctx, tables } = seed({ route: "judge", ...opts });
      await post(ctx);
      expect(tables.session_decisions[0].hops).toEqual([]);
      expect(tables.session_decisions[0].asked_user_ids.map(String)).toEqual([String(OWNER)]);
      expect(tables.decision_inbox).toHaveLength(0);
    }
  });
});

describe("who a trial card waits on (the card's audience, read by For you)", () => {
  const card = (tables: Record<string, any[]>, extra: Record<string, unknown> = {}) => ({ _id: "trial_cards_1", short_id: "tc-1", run_id: RUN, task_id: TASK, project_id: TRIAL, node_id: "review", kind: "card", status: "waiting", created_at: NOW, updated_at: NOW, ...extra }) as any;

  test("a judge fix asked through the rail waits on the people its ladder reached", async () => {
    const { ctx, tables } = seed({ route: "judge", decides: true });
    await pauseAtGateCore(ctx, { userId: OWNER }, { run_id: RUN as any, node_id: "review", prompt: "Publish?", choices: judgeChoices });
    const row = tables.trial_cards[0];
    const audience = await audienceOf(ctx, row, tables.projects[0], tables.workflow_runs[0]);
    expect(audience?.role.handle).toBe("agent-quality");
    expect(audience?.asked).toEqual([String(LEAD_PERSON)]);
  });

  test("a judge-route card no decision carries (written before the trial named its decider) is the decider's too", async () => {
    const { ctx, tables } = seed({ route: "judge", decides: true });
    const audience = await audienceOf(ctx, card(tables), tables.projects[0], tables.workflow_runs[0]);
    expect(audience?.role.short_id).toBe("or-39");
    expect(audience?.asked).toEqual([String(LEAD_PERSON)]);
    expect(audience?.asked).not.toContain(String(OWNER));
  });

  test("a product card, or a judge card on a trial naming no decider, has no audience: the owner's practice answer", async () => {
    const product = seed({ route: "product", decides: true });
    expect(await audienceOf(product.ctx, card(product.tables), product.tables.projects[0], product.tables.workflow_runs[0])).toBeNull();
    const none = seed({ route: "judge" });
    expect(await audienceOf(none.ctx, card(none.tables), none.tables.projects[0], none.tables.workflow_runs[0])).toBeNull();
  });
});
