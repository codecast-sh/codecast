import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { CAUSE_WINDOW, LINE_CARD_GATE_NODE, LINE_RUNS_PER_RUNNER, LINE_STARTED_PREFIX, MAX_STARTS_PER_SWEEP, lineCandidates, lineQueueFor, planSweep, startPlanned, sweepCore } from "./orgLine";
import { lineSlugOf, normalizeLineSlug, performSetLine } from "./orgRoles";
import { HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";
import { normalizeGitOrigin } from "@codecast/shared/contracts";

// the-line.md L2 (a scope owns a line) and L9 (the sweep starts it), driven
// through the exported core functions against the fake db.

const HOST = "u".repeat(31) + "h"; // hosts the role, team admin
const MATE = "u".repeat(31) + "t"; // plain member
const TEAM = "teams_acme" as any;
const ROLE = "org_roles_growth";
const ANCHOR = "anchors_growth";
const STANDING = "conversations_standing";
const PROJECT = "projects_p1";
// The real clock: recordHandStart (spawn.ts) stamps counters with Date.now(),
// so a fixed timestamp would put the cap check on a different day.
const NOW = Date.now();
const TODAY = new Date(NOW).toISOString().slice(0, 10);

type Overrides = { role?: Record<string, any>; task?: Record<string, any>; extra?: Record<string, any[]> };

function task(over: Record<string, any> = {}) {
  return {
    _id: "tasks_1",
    short_id: "ct-1",
    title: "Ship the thing",
    status: "open",
    priority: "medium",
    assignee: "agent:growth",
    project_id: PROJECT,
    user_id: HOST,
    team_id: TEAM,
    workspace: `team:${TEAM}`,
    created_at: NOW - 1000,
    updated_at: NOW - 1000,
    ...over,
  };
}

function fixtures(o: Overrides = {}) {
  const db = makeFakeDb({
    users: [
      { _id: HOST, name: "Host", email: "host@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true, line: true } }],
    projects: [{ _id: PROJECT, title: "Growth", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }],
    plans: [],
    tasks: [task(o.task)],
    org_roles: [
      {
        _id: ROLE,
        short_id: "or-1",
        scope_type: "team",
        team_id: TEAM,
        host_user_id: HOST,
        name: "Growth lead",
        handle: "growth",
        scope: { project_ids: [PROJECT], plan_ids: [] },
        reports_to: { kind: "user", user_id: HOST },
        status: "active",
        trust: "direct",
        anchor_id: ANCHOR,
        caps: { hands_per_day: 3, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true },
        created_by: HOST,
        created_at: 1,
        updated_at: 1,
        ...(o.role ?? {}),
      },
    ],
    anchors: [{ _id: ANCHOR, team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: STANDING }],
    conversations: [{ _id: STANDING, session_id: "standing", user_id: HOST, team_id: TEAM, status: "active", title: "Growth lead", agent_type: "claude_code", message_count: 1, standing_role_id: ROLE, anchor_id: ANCHOR, updated_at: NOW, project_path: "/srv/growth" }],
    workflows: [],
    workflow_runs: [],
    daemon_commands: [],
    messages: [],
    task_comments: [],
    org_role_history: [],
    directory_team_mappings: [],
    thread_reads: [],
    entity_subscriptions: [],
    counters: [],
    ...(o.extra ?? {}),
  });
  return { db, ctx: { db } as any, tables: db._tables as Record<string, any[]> };
}

describe("orgLine.sweep (L9)", () => {
  test("starts nothing while the team has Flows or Org off, and resumes when both are back on", async () => {
    for (const features of [{ org: true }, { line: true }, {}]) {
      const { ctx, tables } = fixtures();
      tables.teams[0].features = features;
      expect((await sweepCore(ctx, NOW)).started).toHaveLength(0);
      expect(tables.workflow_runs).toHaveLength(0);
      tables.teams[0].features = { org: true, line: true };
      expect((await sweepCore(ctx, NOW)).started).toHaveLength(1);
    }
  });

  test("starts one run for an open task assigned to the role's agent, and never a second", async () => {
    const { ctx, tables } = fixtures();
    const first = await sweepCore(ctx, NOW);
    expect(first.started).toHaveLength(1);
    expect(tables.workflow_runs).toHaveLength(1);
    const run = tables.workflow_runs[0];
    expect(run.user_id).toBe(HOST);
    expect(run.task_id).toBe("tasks_1");
    expect(run.spawner_conversation_id).toBe(STANDING);
    expect(run.project_path).toBe("/srv/growth");
    expect(run.workspace).toBe(`team:${TEAM}`);
    expect(run.team_id).toBe(TEAM);
    expect(run.status).toBe("pending");
    // No pushed workflow row: the run names the shipped template and the
    // daemon command carries the slug for run-daemon to resolve.
    expect(run.workflow_id).toBeUndefined();
    expect(run.workflow_name).toBe("line");
    // A new line run proves against unfixed code: the daemon sets an earlier run's branch aside.
    expect(run.fresh_branch).toBe(true);
    expect(tables.daemon_commands).toHaveLength(1);
    expect(tables.daemon_commands[0].user_id).toBe(HOST);
    expect(tables.daemon_commands[0].command).toBe("run_workflow");
    expect(JSON.parse(tables.daemon_commands[0].args)).toEqual({ workflow_run_id: run._id, workflow_slug: "line" });
    // The task carries the run and left `open`; one comment names the run.
    expect(tables.tasks[0].workflow_run_id).toBe(run._id);
    expect(tables.tasks[0].status).toBe("in_progress");
    const comments = tables.task_comments.filter((c) => c.task_id === "tasks_1");
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe(`${LINE_STARTED_PREFIX}${run._id}`);
    expect(comments[0].author).toBe("@growth");
    // The run's primary session is a hand of the role and counts as one.
    expect(tables.conversations.find((c) => c.workflow_run_id === run._id)?.org_role_id).toBe(ROLE);
    expect(tables.org_roles[0].counters).toEqual({ day: TODAY, hands: 1, wakes: 0, tokens: 0 });

    const second = await sweepCore(ctx, NOW + 120_000);
    expect(second.started).toHaveLength(0);
    expect(tables.workflow_runs).toHaveLength(1);
    expect(tables.daemon_commands).toHaveLength(1);
    expect(tables.task_comments.filter((c) => c.task_id === "tasks_1")).toHaveLength(1);
    expect(tables.org_roles[0].counters.hands).toBe(1);
  });

  test("a role whose standing session was pulled to another person's machine runs there, in that session's folder", async () => {
    const { ctx, tables } = fixtures();
    // cast pull / cast role move: the session runs under Mate now, and Mate's
    // daemon recorded its own checkout. The role and anchor rows still name Host.
    Object.assign(tables.conversations.find((c) => c._id === STANDING)!, { user_id: MATE, project_path: "/Users/mate/src/growth" });
    await sweepCore(ctx, NOW);
    const run = tables.workflow_runs[0];
    expect(run.user_id).toBe(MATE);
    expect(run.project_path).toBe("/Users/mate/src/growth");
    expect(tables.daemon_commands[0].user_id).toBe(MATE);
    expect(tables.org_roles[0].host_user_id).toBe(HOST);
  });

  test("uses the host's pushed workflow row when one carries the line's slug", async () => {
    const { ctx, tables } = fixtures({
      role: { line_workflow_slug: "feature" },
      extra: { workflows: [{ _id: "workflows_feat", user_id: HOST, name: "Feature", slug: "feature", nodes: [], edges: [], created_at: 1, updated_at: 1 }] },
    });
    await sweepCore(ctx, NOW);
    expect(tables.workflow_runs[0].workflow_id).toBe("workflows_feat");
    expect(tables.workflow_runs[0].workflow_name).toBe("Feature");
    expect(JSON.parse(tables.daemon_commands[0].args).workflow_slug).toBe("feature");
  });

  test("a task private to its owner inside a team gets a private run (L8: access from the task, routing from the team)", async () => {
    const { ctx, tables } = fixtures({ task: { workspace: `user:${HOST}` } });
    await sweepCore(ctx, NOW);
    expect(tables.workflow_runs).toHaveLength(1);
    expect(tables.workflow_runs[0].workspace).toBe(`user:${HOST}`);
    expect(tables.workflow_runs[0].team_id).toBe(TEAM);
  });

  test("starts nothing once the role's hands cap is reached", async () => {
    const { ctx, tables } = fixtures({ role: { caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true }, counters: { day: TODAY, hands: 1, wakes: 0, tokens: 0 } } });
    const res = await sweepCore(ctx, NOW);
    expect(res.started).toHaveLength(0);
    expect(res.skipped_capped).toEqual([ROLE]);
    expect(tables.workflow_runs).toHaveLength(0);
    expect(tables.daemon_commands).toHaveLength(0);
    expect(tables.tasks[0].status).toBe("open");
  });

  test("a stale counter row from yesterday does not hold today's cap", async () => {
    const { ctx, tables } = fixtures({ role: { caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true }, counters: { day: "2020-01-01", hands: 1, wakes: 0, tokens: 0 } } });
    const res = await sweepCore(ctx, NOW);
    expect(res.started).toHaveLength(1);
    expect(tables.org_roles[0].counters).toEqual({ day: TODAY, hands: 1, wakes: 0, tokens: 0 });
  });

  test("skips a paused role and a role whose switch is off; decide reads as on (S23.1)", async () => {
    {
      const { ctx } = fixtures({ role: { trust: "decide" } });
      expect((await sweepCore(ctx, NOW)).started).toHaveLength(1);
    }
    for (const role of [{ status: "paused" }, { trust: "understand" }, { trust: undefined }]) {
      const { ctx, tables } = fixtures({ role });
      const res = await sweepCore(ctx, NOW);
      expect(res.started).toHaveLength(0);
      expect(tables.workflow_runs).toHaveLength(0);
      expect(tables.tasks[0].status).toBe("open");
    }
  });

  test("candidates: only open tasks assigned to agent:<handle> with no run and no open blocker or wait", async () => {
    const role = () => fixtures().tables.org_roles[0];
    const cases: Array<[Record<string, any>, number]> = [
      [{}, 1],
      [{ status: "in_progress" }, 0],
      [{ assignee: "agent:other" }, 0],
      [{ assignee: HOST }, 0],
      [{ assignee: undefined }, 0],
      [{ workflow_run_id: "workflow_runs_old" }, 0],
      [{ blocked_by: ["ct-9"] }, 0],
      [{ blocked_by: ["ct-8"] }, 1],
      [{ blocked_by: ["ct-404"] }, 1],
      [{ waits: [{ kind: "time", at: NOW + 3_600_000, state: "waiting", created_at: NOW }] }, 0],
      [{ waits: [{ kind: "time", at: NOW - 1, state: "met", created_at: NOW - 2 }] }, 1],
      [{ project_id: "projects_elsewhere" }, 0],
    ];
    for (const [over, expected] of cases) {
      const { ctx } = fixtures({
        task: over,
        extra: {
          tasks: [
            task(over),
            task({ _id: "tasks_9", short_id: "ct-9", assignee: undefined, project_id: undefined }),
            task({ _id: "tasks_8", short_id: "ct-8", status: "done", assignee: undefined, project_id: undefined }),
          ],
        },
      });
      const got = await lineCandidates(ctx, role());
      expect(got.map((t) => t._id)).toEqual(expected ? ["tasks_1"] : []);
    }
  });

  test("drains a backlog oldest first, bounded by the cap", async () => {
    const { ctx, tables } = fixtures({
      role: { caps: { hands_per_day: 2, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true } },
      extra: {
        tasks: [
          task({ _id: "tasks_new", short_id: "ct-3", created_at: NOW - 10 }),
          task({ _id: "tasks_old", short_id: "ct-1", created_at: NOW - 3000 }),
          task({ _id: "tasks_mid", short_id: "ct-2", created_at: NOW - 2000 }),
        ],
      },
    });
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_old", "tasks_mid"]);
    expect(res.skipped_capped).toEqual([ROLE]);
    expect(tables.workflow_runs).toHaveLength(2);
    expect(tables.org_roles[0].counters.hands).toBe(2);
    expect(tables.tasks.find((t) => t._id === "tasks_new")!.status).toBe("open");
  });
});

describe("orgLine admission (LE6)", () => {
  // A cause the signal door opened and ground marked ready (LE4, LE5).
  const cause = (over: Record<string, any> = {}) =>
    task({ assignee: undefined, source: "signal", readiness: "ready", goal_ref: "in-1:retention", cause: { signal_count: 1, first_seen: 1, last_seen: 1, fingerprints: ["f"] }, ...over });
  const initiatives = [
    { _id: "initiatives_p0", short_id: "in-1", title: "Retention", priority: "p0", status: "active", workspace: `team:${TEAM}`, team_id: TEAM, project_ids: [] },
    { _id: "initiatives_p3", short_id: "in-2", title: "Polish", priority: "p3", status: "active", workspace: `team:${TEAM}`, team_id: TEAM, project_ids: [] },
    // Same short id shape in another workspace: never read for this team.
    { _id: "initiatives_other", short_id: "in-9", title: "Elsewhere", priority: "p0", status: "active", workspace: "team:teams_other", team_id: "teams_other", project_ids: [] },
  ];
  const caps = (over: Record<string, any> = {}) => ({ caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, line_on: true, ...over } });
  // A pending card at the card gate of a run the role started.
  const card = (n: number, over: Record<string, any> = {}) => ({
    _id: `session_decisions_${n}`, conversation_id: STANDING, session_id: "standing", user_id: HOST, question: "Ship it?", options: [], blocking: true, status: "pending",
    workflow_run_id: `workflow_runs_card${n}`, gate_node_id: LINE_CARD_GATE_NODE, created_at: NOW, ...over,
  });
  const cardRun = (n: number, over: Record<string, any> = {}) => ({ _id: `workflow_runs_card${n}`, user_id: HOST, status: "paused", org_role_id: ROLE, spawner_conversation_id: STANDING, task_id: `tasks_card${n}`, node_statuses: [], ...over });
  // A line run working now on the runner's machine.
  const workRun = (n: number, over: Record<string, any> = {}) => ({ _id: `workflow_runs_w${n}`, user_id: HOST, status: "running", org_role_id: ROLE, task_id: `tasks_w${n}`, node_statuses: [], ...over });
  const working = (count: number, over: Record<string, any> = {}) => Array.from({ length: count }, (_, n) => workRun(n, over));
  const causes = (count: number) => Array.from({ length: count }, (_, n) => cause({ _id: `tasks_c${n}`, short_id: `ct-c${n}`, created_at: NOW - 10_000 + n }));
  const busy = `${LINE_RUNS_PER_RUNNER} runs working on its machine`;

  test("candidates rank by scored value, then findings, then age; an unscored problem ranks as 50; unready, ungrounded and someone else's causes stay out", async () => {
    const scored = (score: number, signal_count = 1) => ({ signal_count, first_seen: 1, last_seen: 1, fingerprints: ["f"], scored: { score, harm: 3, reach: 3, fixability: 3, reason: "r", root_cause: "c", at: 1, version: "1" } });
    const { ctx, tables } = fixtures({
      role: caps(),
      extra: {
        initiatives,
        tasks: [
          task({ _id: "tasks_assigned", short_id: "ct-1", created_at: NOW - 9000 }),
          cause({ _id: "tasks_90", short_id: "ct-2", cause: scored(90) }),
          cause({ _id: "tasks_70_loud", short_id: "ct-3", goal_ref: "none", cause: scored(70, 9), created_at: NOW - 100 }),
          cause({ _id: "tasks_70_old", short_id: "ct-4", cause: scored(70, 2), created_at: NOW - 8000 }),
          cause({ _id: "tasks_70_new", short_id: "ct-5", cause: scored(70, 2), created_at: NOW - 50 }),
          cause({ _id: "tasks_20_urgent", short_id: "ct-6", priority: "urgent", cause: scored(20, 30) }),
          cause({ _id: "tasks_unscored", short_id: "ct-7", cause: { signal_count: 3, first_seen: 1, last_seen: 1, fingerprints: ["f"] } }),
          cause({ _id: "tasks_not_ready", short_id: "ct-8", readiness: "needs_context", cause: scored(99) }),
          cause({ _id: "tasks_ungrounded", short_id: "ct-9", goal_ref: undefined, cause: scored(99) }),
          cause({ _id: "tasks_persons", short_id: "ct-10", assignee: MATE, cause: scored(99) }),
          cause({ _id: "tasks_running", short_id: "ct-11", workflow_run_id: "workflow_runs_x", cause: scored(99) }),
        ],
      },
    });
    // The goal and the task's own priority do not weigh: an urgent problem on
    // the p0 goal scored 20 starts after an unscored one (50), and the
    // assigned task with no cause ranks as unscored, behind it on findings.
    const order = ["tasks_90", "tasks_70_loud", "tasks_70_old", "tasks_70_new", "tasks_unscored", "tasks_assigned", "tasks_20_urgent"];
    expect((await lineCandidates(ctx, tables.org_roles[0])).map((t) => t._id)).toEqual(order);
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q.items.map((i) => i.priority)).toEqual([90, 70, 70, 70, 50, 50, 20]);
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(order.slice(0, LINE_RUNS_PER_RUNNER));
  });

  test("a cause grounding held on a fact is its lead role's ask, never a candidate; one parked for more findings asks nobody", async () => {
    const { ctx, tables } = fixtures({
      extra: {
        initiatives,
        tasks: [
          cause({ _id: "tasks_ready" }),
          cause({ _id: "tasks_q", short_id: "ct-7", title: "Rep left?", readiness: "needs_context", readiness_note: "Has Quinn left, or is Riley wrong?", cause: { signal_count: 3, first_seen: 1, last_seen: 1, fingerprints: ["f"] }, created_at: NOW - 5000 }),
          cause({ _id: "tasks_wait", readiness: "needs_context", readiness_note: "One case so far, so it waits for more findings." }),
          cause({ _id: "tasks_running", readiness: "needs_context", readiness_note: "Which?", workflow_run_id: "workflow_runs_x" }),
          cause({ _id: "tasks_other", readiness: "needs_context", readiness_note: "Which?", project_id: "projects_elsewhere" }),
        ],
      },
    });
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q.items.map((i) => i.task_id)).toEqual(["tasks_ready"]);
    expect(q.asks).toEqual([{ task_id: "tasks_q", short_id: "ct-7", title: "Rep left?", note: "Has Quinn left, or is Riley wrong?", findings: 3 }]);
  });

  test("decisions waiting for an answer hold nothing: a line with many open cards starts its next cause", async () => {
    const open = [1, 2, 3, 4, 5, 6, 7].map((n) => card(n));
    const { ctx, tables } = fixtures({
      role: caps({ cards: 2 }),
      extra: { initiatives, tasks: [cause({ _id: "tasks_p0" })], workflow_runs: [1, 2, 3, 4, 5, 6, 7].map((n) => cardRun(n)), session_decisions: open },
    });
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q).toMatchObject({ working: 0, runs_cap: LINE_RUNS_PER_RUNNER, waiting: null });
    expect(q.items.map((i) => i.waiting)).toEqual([null]);
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_p0"]);
    expect(res.skipped_busy).toEqual([]);
  });

  test("runs working on the runner's machine hold at the cap, a role's taskless run among them; paused, waiting on a person, finished or another workflow's runs do not count", async () => {
    const { ctx, tables } = fixtures({
      role: caps({ hands_per_day: 50 }),
      extra: {
        initiatives,
        tasks: [cause({ _id: "tasks_p0" })],
        workflow_runs: [
          ...working(LINE_RUNS_PER_RUNNER - 2),
          workRun(90, { status: "pending" }),
          // A judge diagnosis the role started: no task, still a session on the machine.
          workRun(95, { task_id: undefined }),
          cardRun(1),
          workRun(91, { status: "running" }),
          workRun(92, { status: "completed" }),
          workRun(93, { status: "failed" }),
          // The standing session ran some other workflow with no task.
          workRun(94, { task_id: undefined, org_role_id: undefined, spawner_conversation_id: STANDING }),
        ],
        // Run 91 is running but blocked on a person's answer at a gate other than the card.
        session_decisions: [card(1), card(91, { workflow_run_id: "workflow_runs_w91", gate_node_id: "plan" })],
      },
    });
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q).toMatchObject({ working: LINE_RUNS_PER_RUNNER, runs_cap: LINE_RUNS_PER_RUNNER, waiting: busy });
    expect(q.items.map((i) => i.waiting)).toEqual([busy]);
    const res = await sweepCore(ctx, NOW);
    expect(res.started).toHaveLength(0);
    expect(res.skipped_busy).toEqual([ROLE]);
    expect(tables.tasks.find((t) => t._id === "tasks_p0")!.status).toBe("open");

    // A run reaching its card pauses there and frees its slot.
    tables.workflow_runs.find((r) => r._id === "workflow_runs_w0")!.status = "paused";
    const next = await sweepCore(ctx, NOW + 120_000);
    expect(next.started.map((s) => s.task_id)).toEqual(["tasks_p0"]);
  });

  test("the cap is per runner: every line role on the same machine shares it, another person's machine does not", async () => {
    const OTHER = "org_roles_ops";
    const OTHER_STANDING = "conversations_ops";
    const mateRole = "org_roles_mate";
    const base = fixtures();
    const growth = base.tables.org_roles[0];
    const role = (id: string, handle: string, anchor: string) => ({ ...growth, _id: id, short_id: `or-${handle}`, handle, name: handle, anchor_id: anchor, scope: { project_ids: [], plan_ids: [] } });
    const { ctx, tables } = fixtures({
      role: caps({ hands_per_day: 50 }),
      extra: {
        initiatives,
        tasks: [cause({ _id: "tasks_p0" })],
        org_roles: [{ ...growth, ...caps({ hands_per_day: 50 }) }, role(OTHER, "ops", "anchors_ops"), role(mateRole, "mate", "anchors_mate")],
        anchors: [
          ...base.tables.anchors,
          { _id: "anchors_ops", team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: OTHER_STANDING },
          { _id: "anchors_mate", team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: "conversations_mate" },
        ],
        conversations: [
          ...base.tables.conversations,
          { ...base.tables.conversations[0], _id: OTHER_STANDING, session_id: "ops", standing_role_id: OTHER, anchor_id: "anchors_ops" },
          // Seated by HOST, pulled onto MATE's machine.
          { ...base.tables.conversations[0], _id: "conversations_mate", session_id: "mate", user_id: MATE, standing_role_id: mateRole, anchor_id: "anchors_mate" },
        ],
        workflow_runs: [...working(2), ...working(LINE_RUNS_PER_RUNNER, { org_role_id: mateRole, user_id: MATE }).map((r, n) => ({ ...r, _id: `workflow_runs_m${n}` }))],
      },
    });
    expect((await lineQueueFor(ctx, tables.org_roles[0], NOW)).working).toBe(2);
    // The ops role, on the same machine, fills the rest.
    tables.workflow_runs.push(...working(LINE_RUNS_PER_RUNNER - 2, { org_role_id: OTHER }).map((r, n) => ({ ...r, _id: `workflow_runs_o${n}` })));
    expect((await lineQueueFor(ctx, tables.org_roles[0], NOW)).waiting).toBe(busy);
    expect((await sweepCore(ctx, NOW)).skipped_busy).toEqual([ROLE]);
  });

  test("a started run holds its slot: a sweep starts at most MAX_STARTS_PER_SWEEP, the next fills the cap, then nothing until one finishes", async () => {
    const { ctx, tables } = fixtures({ role: caps({ hands_per_day: 100 }), extra: { initiatives, tasks: causes(LINE_RUNS_PER_RUNNER + 3) } });
    const before = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(before.items.map((i) => i.waiting)).toEqual([...Array(LINE_RUNS_PER_RUNNER).fill(null), busy, busy, busy]);
    const first = Math.min(MAX_STARTS_PER_SWEEP, LINE_RUNS_PER_RUNNER);
    expect((await sweepCore(ctx, NOW)).started).toHaveLength(first);
    expect((await sweepCore(ctx, NOW + 120_000)).started).toHaveLength(LINE_RUNS_PER_RUNNER - first);
    const third = await sweepCore(ctx, NOW + 240_000);
    expect(third.started).toHaveLength(0);
    expect(third.skipped_busy).toEqual([ROLE]);
    expect(await lineQueueFor(ctx, tables.org_roles[0], NOW)).toMatchObject({ working: LINE_RUNS_PER_RUNNER, waiting: busy });
    tables.workflow_runs[0].status = "completed";
    expect((await sweepCore(ctx, NOW + 360_000)).started).toHaveLength(1);
  });

  test("a dry pass decides like a real one and starts nothing", async () => {
    const { ctx, tables } = fixtures({ role: caps({ hands_per_day: 100 }), extra: { initiatives, tasks: causes(MAX_STARTS_PER_SWEEP + 2) } });
    const dry = await sweepCore(ctx, NOW, { dry: true });
    expect(tables.workflow_runs).toHaveLength(0);
    expect(tables.tasks.every((t) => t.status === "open")).toBe(true);
    const real = await sweepCore(ctx, NOW);
    expect(real.started.map((s) => s.task_id)).toEqual(dry.started.map((s) => s.task_id));
  });

  test("a pass reads a window of the backlog, oldest first, and a limit stops the reads at the limit", async () => {
    const { ctx, tables } = fixtures({ role: caps({ hands_per_day: 1000 }), extra: { initiatives, tasks: causes(CAUSE_WINDOW + 30) } });
    const role = tables.org_roles[0];
    expect((await lineCandidates(ctx, role)).length).toBe(CAUSE_WINDOW);
    expect((await lineCandidates(ctx, role, 3)).map((t) => t._id)).toEqual(["tasks_c0", "tasks_c1", "tasks_c2"]);
    // The newest causes come into the window as the oldest start.
    for (const t of tables.tasks.slice(0, 30)) t.status = "in_progress";
    expect((await lineCandidates(ctx, role)).map((t) => t._id)).toContain(`tasks_c${CAUSE_WINDOW + 29}`);
  });

  test("a role at its limit reads one candidate to say why it waits, and starts none", async () => {
    const { ctx } = fixtures({ role: caps({ hands_per_day: 50 }), extra: { initiatives, tasks: causes(3), workflow_runs: working(LINE_RUNS_PER_RUNNER) } });
    const res = await sweepCore(ctx, NOW);
    expect(res).toMatchObject({ started: [], skipped_busy: [ROLE], skipped_capped: [] });
    // With nothing queued, a full machine reports nothing.
    const idle = fixtures({ role: caps({ hands_per_day: 50 }), extra: { initiatives, tasks: [], workflow_runs: working(LINE_RUNS_PER_RUNNER) } });
    expect(await sweepCore(idle.ctx, NOW)).toMatchObject({ started: [], skipped_busy: [] });
  });

  describe("a pool of machines that offer the role's checkout", () => {
    const ORIGIN = normalizeGitOrigin("git@github.com:Acme/Growth.git")!;
    // The laptop holds the role's folder (/srv/growth) inside the repository at /srv.
    const laptop = { _id: "devices_laptop", user_id: HOST, device_id: "dev-laptop", last_seen: NOW, git_plane: [{ root: "/srv", origin: "git@github.com:Acme/Growth.git", origin_ok: true }] };
    const host = (id: string, runs: number, over: Record<string, any> = {}) => ({ _id: `devices_${id}`, user_id: HOST, device_id: id, last_seen: NOW, line_slots: [{ root: `/home/ubuntu/${id}`, origin: ORIGIN, runs }], ...over });

    test("each run goes to the host with the most free slots, in that host's checkout, until the pool is full", async () => {
      const { ctx, tables } = fixtures({
        role: caps({ hands_per_day: 100 }),
        extra: {
          initiatives,
          tasks: causes(8),
          devices: [laptop, host("h1", 2), host("h2", 3), host("h3", 5, { last_seen: NOW - 3_600_000 })],
          // The laptop's own runs fill its cap, and hold nothing on the pool.
          workflow_runs: working(LINE_RUNS_PER_RUNNER, { runner_device: "dev-laptop" }),
        },
      });
      const res = await sweepCore(ctx, NOW);
      expect(res.started).toHaveLength(5);
      expect(res.skipped_busy).toEqual([ROLE]);
      const placed = tables.workflow_runs.filter((r) => r.runner_device && r.runner_device !== "dev-laptop");
      expect(placed.map((r) => r.runner_device).sort()).toEqual(["h1", "h1", "h2", "h2", "h2"]);
      expect(placed.find((r) => r.runner_device === "h2")!.project_path).toBe("/home/ubuntu/h2/growth");
      expect(tables.daemon_commands.map((c) => c.target_device_id).sort()).toEqual(["h1", "h1", "h2", "h2", "h2"]);
      expect(await lineQueueFor(ctx, tables.org_roles[0], NOW)).toMatchObject({ working: 5, runs_cap: 5, waiting: "5 runs working on its machines" });
      // A run that pauses at its card frees its host's slot.
      placed.find((r) => r.runner_device === "h1")!.status = "paused";
      // Within the hosts' heartbeat window.
      const next = await sweepCore(ctx, NOW + 60_000);
      expect(next.started).toHaveLength(1);
      expect(tables.daemon_commands.at(-1)!.target_device_id).toBe("h1");
    });

    test("a host an operator holds out of the line takes no new run and no queued resume, whatever its slots say, until the hold is released", async () => {
      // Oct 27: Cam's union-shared box had no Codex for the Review hand, so every run that reached Review there failed.
      const held = { why: "no Codex for Review (ct-74380)", at: NOW - 1_000 };
      const queuedThere = { _id: "workflow_runs_q1", user_id: HOST, status: "failed", org_role_id: ROLE, task_id: "tasks_q1", runner_device: "h1", project_path: "/home/ubuntu/h1/growth", current_node_id: "review", fail_reason: "hand could not start", node_statuses: [], resume_queued: { at: "review", by: HOST, since: NOW - 2_000 } };
      const { ctx, tables } = fixtures({
        role: caps({ hands_per_day: 100 }),
        extra: { initiatives, tasks: [...causes(4), cause({ _id: "tasks_q1", short_id: "ct-q1", status: "in_review" })], devices: [laptop, host("h1", 3, { line_hold: held }), host("h2", 2)], workflow_runs: [queuedThere] },
      });
      const res = await sweepCore(ctx, NOW);
      expect(res.resumed ?? []).toEqual([]);
      expect(res.started.map((s) => s.place?.device)).toEqual(["h2", "h2"]);
      expect(tables.workflow_runs.find((r) => r._id === "workflow_runs_q1")!.status).toBe("failed");
      // Released: the queued run goes back on its own host ahead of new starts there.
      delete (tables.devices.find((d) => d.device_id === "h1") as any).line_hold;
      const next = await sweepCore(ctx, NOW + 60_000);
      expect(next.resumed).toEqual([{ run_id: "workflow_runs_q1", device: "h1" }]);
    });

    test("a failed run queued to resume goes back on its own host once that host has a slot, ahead of new starts", async () => {
      const queued = (id: string, device: string, since: number) => ({
        _id: `workflow_runs_${id}`, user_id: HOST, status: "failed", org_role_id: ROLE, task_id: `tasks_${id}`, runner_device: device,
        project_path: `/home/ubuntu/${device}/growth`, current_node_id: "build", fail_reason: "max_visits=3 exceeded on build", node_statuses: [],
        resume_queued: { at: "build", by: HOST, since },
      });
      const { ctx, tables } = fixtures({
        role: caps({ hands_per_day: 100 }),
        extra: {
          initiatives,
          tasks: [...causes(3), cause({ _id: "tasks_q1", short_id: "ct-q1", status: "in_review", execution_status: "blocked" }), cause({ _id: "tasks_q2", short_id: "ct-q2", status: "in_review" })],
          devices: [laptop, host("h1", 2), host("h2", 1)],
          workflow_runs: [queued("q2", "h2", NOW - 1_000), queued("q1", "h1", NOW - 2_000), ...working(1, { runner_device: "h2", project_path: "/home/ubuntu/h2/growth" })],
        },
      });
      const res = await sweepCore(ctx, NOW);
      // h2 is full, so its queued run waits; h1 resumes its own first and starts one new problem with the slot left.
      expect(res.resumed).toEqual([{ run_id: "workflow_runs_q1", device: "h1" }]);
      expect(res.started.map((s) => s.place?.device)).toEqual(["h1"]);
      const q1 = tables.workflow_runs.find((r) => r._id === "workflow_runs_q1")!;
      expect(q1).toMatchObject({ status: "running", current_node_id: "build", visits_reset_at: NOW });
      expect(q1.resume_queued).toBeUndefined();
      expect(tables.tasks.find((t) => t._id === "tasks_q1")!.execution_status).toBeUndefined();
      expect(tables.workflow_runs.find((r) => r._id === "workflow_runs_q2")!.status).toBe("failed");
      // h2's run finishes: its queued run resumes there before anything new starts on it.
      tables.workflow_runs.find((r) => r._id === "workflow_runs_w0")!.status = "completed";
      const next = await sweepCore(ctx, NOW + 60_000);
      expect(next.resumed).toEqual([{ run_id: "workflow_runs_q2", device: "h2" }]);
      expect(next.started.filter((s) => s.place?.device === "h2")).toEqual([]);
      expect(tables.daemon_commands.filter((c) => c.target_device_id === "h2")).toHaveLength(1);
    });

    test("a planned start checks again what moved since the plan: the task, the role's hands, the host's slot", async () => {
      const { ctx, tables } = fixtures({
        role: caps({ hands_per_day: 100 }),
        extra: { initiatives, tasks: causes(4), devices: [laptop, host("h1", 2)] },
      });
      const plan = await planSweep(ctx, NOW);
      expect(plan.started.map((s) => s.place?.device)).toEqual(["h1", "h1"]);
      expect(tables.workflow_runs).toHaveLength(0);
      // The first cause started some other way since the plan: its start is dropped.
      tables.tasks.find((t) => t._id === plan.started[0].task_id)!.status = "in_progress";
      expect(await startPlanned(ctx, plan.started[0], NOW)).toBeNull();
      // Another start took the host's last slots meanwhile.
      tables.workflow_runs.push(...working(2, { runner_device: "h1" }).map((r, n) => ({ ...r, _id: `workflow_runs_h${n}` })));
      expect(await startPlanned(ctx, plan.started[1], NOW)).toBeNull();
      tables.workflow_runs.length = 0;
      expect(await startPlanned(ctx, plan.started[1], NOW)).toBeTruthy();
      expect(tables.workflow_runs[0]).toMatchObject({ runner_device: "h1", project_path: "/home/ubuntu/h1/growth" });
      // A role out of hands starts nothing, whatever the plan said.
      tables.org_roles[0].caps = { ...tables.org_roles[0].caps, hands_per_day: 1 };
      const next = { role_id: plan.started[1].role_id, task_id: "tasks_c2" };
      expect(await startPlanned(ctx, next, NOW)).toBeNull();
    });

    // A failed problem started again by hand (cast workflow run --task --detach, Start a fix): the sweep's admission, never the asking machine.
    const failed = (n: number) => cause({ _id: `tasks_c${n}`, short_id: `ct-c${n}`, status: "in_progress", execution_status: "blocked", execution_concerns: "Dissolve killed it", workflow_run_id: `workflow_runs_dead${n}`, created_at: NOW - 10_000 + n });
    const dead = (n: number) => ({ _id: `workflow_runs_dead${n}`, user_id: HOST, status: "failed", org_role_id: ROLE, task_id: `tasks_c${n}`, runner_device: "dev-laptop", node_statuses: [] });
    const TOKEN = "pool-token";
    const handStart = async (devices: any[], runs: any[] = []) => {
      const { hashToken } = await import("./apiTokens");
      const f = fixtures({ role: caps({ hands_per_day: 100 }), extra: { initiatives, tasks: [failed(0), failed(1)], devices, workflow_runs: [dead(0), dead(1), ...runs], api_tokens: [{ _id: "api_tokens_1", user_id: HOST, token_hash: await hashToken(TOKEN) }] } });
      const { createFromCli } = await import("./workflow_runs");
      const run = (short: string) => (createFromCli as any)._handler(f.ctx, { api_token: TOKEN, workflow_name: "line", task_id: short, project_path: "/Users/me/growth", detach: true, run_on_device: "dev-laptop" });
      return { ...f, run };
    };

    test("a detached run started by hand goes to the pool host with the most free slots, in its checkout", async () => {
      const { tables, run } = await handStart([laptop, host("h1", 1), host("h2", 2)]);
      const out = await run("ct-c0");
      expect(out).toMatchObject({ runner_device: "h2" });
      const started = tables.workflow_runs.find((r) => r._id === out.run_id)!;
      expect(started).toMatchObject({ runner_device: "h2", project_path: "/home/ubuntu/h2/growth", org_role_id: ROLE, task_id: "tasks_c0" });
      expect(tables.daemon_commands.at(-1)!.target_device_id).toBe("h2");
      expect(tables.tasks.find((t) => t._id === "tasks_c0")).toMatchObject({ status: "in_progress", workflow_run_id: out.run_id });
    });

    test("with the pool full, a run started by hand starts nothing and the problem waits in the queue for the sweep", async () => {
      const { ctx, tables, run } = await handStart([laptop, host("h1", 1)], working(1, { runner_device: "h1" }));
      const out = await run("ct-c0");
      expect(out.run_id).toBeNull();
      expect(out.queued).toBe("1 run is working on @growth's machines, so ct-c0 is back in the line's queue; @growth's sweep starts it in rank order when a run finishes.");
      expect(tables.workflow_runs.filter((r) => r.task_id === "tasks_c0")).toHaveLength(1);
      expect(tables.daemon_commands).toHaveLength(0);
      const t = tables.tasks.find((r) => r._id === "tasks_c0")!;
      expect([t.status, t.workflow_run_id, t.execution_status, t.execution_concerns]).toEqual(["open", undefined, undefined, undefined]);
      // The pool frees up: the sweep starts it on the host.
      tables.workflow_runs.find((r) => r._id === "workflow_runs_w0")!.status = "completed";
      const next = await sweepCore(ctx, NOW);
      expect(next.started).toEqual([expect.objectContaining({ task_id: "tasks_c0", place: { device: "h1", project_path: "/home/ubuntu/h1/growth" } })]);
    });

    test("Start a fix on the web takes the same admission", async () => {
      const { startLineCauseCore } = await import("./lineCause");
      const free = await handStart([laptop, host("h1", 1)]);
      expect(await startLineCauseCore(free.ctx, HOST as any, "tasks_c0" as any)).toMatchObject({ role_handle: "growth" });
      expect(free.tables.workflow_runs.find((r) => r.task_id === "tasks_c0" && r.status === "pending")).toMatchObject({ runner_device: "h1", project_path: "/home/ubuntu/h1/growth" });
      const full = await handStart([laptop, host("h1", 1)], working(1, { runner_device: "h1" }));
      const out = await startLineCauseCore(full.ctx, HOST as any, "tasks_c1" as any);
      expect(out).toMatchObject({ run_id: null, queued: expect.stringContaining("ct-c1 is back in the line's queue") });
      expect(full.tables.tasks.find((t) => t._id === "tasks_c1")!.status).toBe("open");
    });

    test("cast line requeue puts a failed problem back for the sweep; a live, closed or trial problem is refused", async () => {
      const { requeueCore } = await import("./orgLine");
      const { ctx, tables } = await handStart([laptop, host("h1", 2)]);
      expect(await requeueCore(ctx, HOST as any, "ct-c0", NOW)).toEqual({ task: "ct-c0", queued: "ct-c0 is back in the line's queue; @growth's sweep starts it in rank order." });
      const t = tables.tasks.find((r) => r._id === "tasks_c0")!;
      expect([t.status, t.workflow_run_id, t.execution_status]).toEqual(["open", undefined, undefined]);
      // The dead run stays on its task's run list.
      expect(tables.workflow_runs.find((r) => r._id === "workflow_runs_dead0")!.task_id).toBe("tasks_c0");
      tables.workflow_runs.find((r) => r._id === "workflow_runs_dead1")!.status = "running";
      await expect(requeueCore(ctx, HOST as any, "ct-c1", NOW)).rejects.toThrow(/is running: cancel it/);
      tables.tasks.find((r) => r._id === "tasks_c1")!.status = "done";
      await expect(requeueCore(ctx, HOST as any, "ct-c1", NOW)).rejects.toThrow(/is done/);
      await expect(requeueCore(ctx, MATE as any, "ct-nope", NOW)).rejects.toThrow(/no such problem/);
      expect((await sweepCore(ctx, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_c0"]);
    });

    test("a pool whose hosts offer no runs right now makes the run wait, never the runner's own machine", async () => {
      const { ctx, tables } = fixtures({ role: caps({ hands_per_day: 100 }), extra: { initiatives, tasks: causes(3), devices: [laptop, host("h1", 0), host("h2", 0)] } });
      expect((await sweepCore(ctx, NOW)).started).toHaveLength(0);
      expect(tables.workflow_runs).toHaveLength(0);
    });

    test("with no online host offering the checkout, the run stays on the runner's own machine and cap", async () => {
      for (const devices of [[laptop], [laptop, host("h1", 4, { line_slots: [] })], [laptop, host("h1", 4, { last_seen: NOW - 3_600_000 })], [{ ...laptop, git_plane: [] }, host("h1", 4)]]) {
        const { ctx, tables } = fixtures({ role: caps({ hands_per_day: 100 }), extra: { initiatives, tasks: causes(3), devices } });
        expect((await sweepCore(ctx, NOW)).started).toHaveLength(3);
        expect(tables.workflow_runs.every((r) => !r.runner_device && r.project_path === "/srv/growth")).toBe(true);
      }
    });
  });

  test("a whole workspace role reads every open cause, however many other open tasks the workspace holds", async () => {
    const filler = Array.from({ length: 600 }, (_, n) => task({ _id: `tasks_f${n}`, short_id: `ct-f${n}`, assignee: MATE, created_at: NOW - 100_000 + n }));
    const { ctx, tables } = fixtures({
      role: { ...caps(), handle: HEAD_OF_PEOPLE_HANDLE, scope: undefined },
      extra: { initiatives, tasks: [...filler, cause({ _id: "tasks_late", short_id: "ct-late", project_id: undefined })] },
    });
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q.items.map((i) => i.task_id)).toEqual(["tasks_late"]);
  });

  test("the hands cap holds causes and the queue says so", async () => {
    const { ctx, tables } = fixtures({
      role: { ...caps({ hands_per_day: 2 }), counters: { day: TODAY, hands: 1, wakes: 0, tokens: 0 } },
      extra: { initiatives, tasks: [cause({ _id: "tasks_a" }), cause({ _id: "tasks_b", short_id: "ct-2", goal_ref: "in-2:polish" })] },
    });
    const before = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(before.waiting).toBeNull();
    expect(before.items.map((i) => i.waiting)).toEqual([null, "hands cap reached"]);
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_a"]);
    expect(res.skipped_capped).toEqual([ROLE]);
    const after = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(after.waiting).toBe("hands cap reached");
    expect(after.items.map((i) => i.task_id)).toEqual(["tasks_b"]);
  });

  // LL5: the line's start switch, caps.line_on under the role's own switch.
  test("a line whose start switch is off starts nothing, whatever the role's own switch says", async () => {
    for (const role of [caps({ line_on: false }), { caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000 } }]) {
      const { ctx, tables } = fixtures({ role, extra: { initiatives, tasks: [cause(), cause({ _id: "tasks_b", short_id: "ct-2" })] } });
      expect(tables.org_roles[0].trust).toBe("direct");
      const res = await sweepCore(ctx, NOW);
      expect(res.started).toHaveLength(0);
      expect(tables.workflow_runs).toHaveLength(0);
      expect(tables.daemon_commands ?? []).toHaveLength(0);
      expect(tables.tasks.every((t) => t.status === "open")).toBe(true);
      const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
      expect(q.waiting).toBe("line is off");
      expect(q.items.every((i) => i.waiting === "line is off")).toBe(true);
    }
  });

  test("slots hold for a role with no standing session, and across a restart onto a new one", async () => {
    const seatless = fixtures({ role: { ...caps({ hands_per_day: 50 }), anchor_id: undefined }, extra: { initiatives, tasks: [cause()], workflow_runs: working(LINE_RUNS_PER_RUNNER) } });
    expect((await sweepCore(seatless.ctx, NOW)).skipped_busy).toEqual([ROLE]);

    const restarted = fixtures({ role: caps({ hands_per_day: 50 }), extra: { initiatives, tasks: [cause()], workflow_runs: working(LINE_RUNS_PER_RUNNER, { spawner_conversation_id: STANDING }) } });
    restarted.tables.anchors[0].conversation_id = "conversations_standing2";
    restarted.tables.conversations.push({ ...restarted.tables.conversations[0], _id: "conversations_standing2", session_id: "standing2" });
    expect((await sweepCore(restarted.ctx, NOW)).skipped_busy).toEqual([ROLE]);
  });

  test("a role whose switch is off reads as off in the queue", async () => {
    const { ctx, tables } = fixtures({ role: { trust: "understand" }, extra: { initiatives, tasks: [cause()] } });
    expect((await lineQueueFor(ctx, tables.org_roles[0], NOW)).waiting).toBe("line is off");
    expect((await sweepCore(ctx, NOW)).started).toHaveLength(0);
  });

  test("idempotent: a started cause never starts twice", async () => {
    const { ctx, tables } = fixtures({ extra: { initiatives, tasks: [cause({ _id: "tasks_p0" })] } });
    expect((await sweepCore(ctx, NOW)).started).toHaveLength(1);
    const again = await sweepCore(ctx, NOW + 120_000);
    expect(again.started).toHaveLength(0);
    expect(tables.workflow_runs).toHaveLength(1);
    expect(tables.daemon_commands).toHaveLength(1);
    expect(tables.workflow_runs[0].task_id).toBe("tasks_p0");
  });
});

describe("orgRoles.setLine (L2)", () => {
  test("a person sets the slug: logged to org_role_history", async () => {
    const { ctx, tables } = fixtures();
    const updated = await performSetLine(ctx, HOST as any, { role_id: "or-1", slug: "Feature", human_decision: "yes" });
    expect(updated.line_workflow_slug).toBe("feature");
    expect(updated.previous_line_workflow_slug).toBe("line");
    expect(tables.org_roles[0].line_workflow_slug).toBe("feature");
    expect(tables.org_role_history).toHaveLength(1);
    expect(tables.org_role_history[0]).toMatchObject({ role_id: ROLE, user_id: HOST, actor_type: "user", action: "line", field: "line_workflow_slug", old_value: "line", new_value: "feature" });
  });

  test("the same slug again logs nothing", async () => {
    const { ctx, tables } = fixtures({ role: { line_workflow_slug: "feature" } });
    await performSetLine(ctx, HOST as any, { role_id: "or-1", slug: "feature.cast", human_decision: "yes" });
    expect(tables.org_role_history).toHaveLength(0);
  });

  test("an agent session may not change the line; a plain member may not either", async () => {
    const { ctx } = fixtures();
    await expect(performSetLine(ctx, HOST as any, { role_id: "or-1", slug: "feature", from_session: "standing" })).rejects.toThrow(/human only/);
    await expect(performSetLine(ctx, MATE as any, { role_id: "or-1", slug: "feature", human_decision: "yes" })).rejects.toThrow(/admin/);
  });

  test("refuses a slug that is not a workflow name", async () => {
    const { ctx } = fixtures();
    await expect(performSetLine(ctx, HOST as any, { role_id: "or-1", slug: "../etc", human_decision: "yes" })).rejects.toThrow(/slug/);
    expect(() => normalizeLineSlug("")).toThrow();
    expect(normalizeLineSlug(" Line.cast ")).toBe("line");
    expect(lineSlugOf({})).toBe("line");
    expect(lineSlugOf({ line_workflow_slug: "feature" })).toBe("feature");
  });
});

// line-map.md LX6: "Start now" on a line cause starts the project lead's line
// on it through the same start the sweep uses, whether or not the role starts
// work on its own, and refuses a second start while the run lives.
describe("startLineCauseCore (LX6)", () => {
  test("starts the lead role's line on a cause in its project, once", async () => {
    const { startLineCauseCore } = await import("./lineCause");
    const { ctx, tables } = fixtures({ role: { trust: "propose" }, task: { assignee: undefined, source: "signal", category: "line" } });
    const out = await startLineCauseCore(ctx, HOST as any, "tasks_1" as any);
    expect(out.role_handle).toBe("growth");
    expect(tables.workflow_runs).toHaveLength(1);
    expect(tables.workflow_runs[0]).toMatchObject({ task_id: "tasks_1", user_id: HOST, workflow_name: "line" });
    expect(tables.tasks[0].status).toBe("in_progress");
    await expect(startLineCauseCore(ctx, HOST as any, "tasks_1" as any)).rejects.toThrow(/already has a live run/);
  });

  // LX4: a card answered Ship whose run then reports nothing has no runner;
  // starting the cause again ends that run instead of refusing.
  test("ends a run stalled at the card gate and starts the cause again", async () => {
    const { startLineCauseCore } = await import("./lineCause");
    const { ctx, tables } = fixtures({ role: { trust: "propose" }, task: { assignee: undefined, source: "signal", category: "line" } });
    await startLineCauseCore(ctx, HOST as any, "tasks_1" as any);
    const first = tables.workflow_runs[0];
    Object.assign(first, { status: "running", current_node_id: "decide", updated_at: Date.now() - 2 * 60 * 60_000 });
    await startLineCauseCore(ctx, HOST as any, "tasks_1" as any);
    expect(tables.workflow_runs).toHaveLength(2);
    expect(tables.workflow_runs[0].status).toBe("failed");
    // A run at the gate that reported a minute ago is still driven: refused.
    Object.assign(tables.workflow_runs[1], { status: "running", current_node_id: "decide", updated_at: Date.now() - 60_000 });
    await expect(startLineCauseCore(ctx, HOST as any, "tasks_1" as any)).rejects.toThrow(/already has a live run/);
  });
});
