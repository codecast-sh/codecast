import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { LINE_CARD_GATE_NODE, LINE_STARTED_PREFIX, lineCandidates, lineQueueFor, sweepCore } from "./orgLine";
import { lineSlugOf, normalizeLineSlug, performSetLine } from "./orgRoles";
import { HEAD_OF_PEOPLE_HANDLE } from "@codecast/shared/contracts/orgLead";

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
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
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
        caps: { hands_per_day: 3, wakes_per_day: 10, tokens_per_day: 1_000_000 },
        created_by: HOST,
        created_at: 1,
        updated_at: 1,
        ...(o.role ?? {}),
      },
    ],
    anchors: [{ _id: ANCHOR, team_id: TEAM, bot_user_id: "users_bot", host_user_id: HOST, conversation_id: STANDING, project_path: "/srv/growth" }],
    conversations: [{ _id: STANDING, session_id: "standing", user_id: HOST, team_id: TEAM, status: "active", title: "Growth lead", agent_type: "claude_code", message_count: 1, standing_role_id: ROLE, anchor_id: ANCHOR, updated_at: NOW }],
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
    const { ctx, tables } = fixtures({ role: { caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1_000_000 }, counters: { day: TODAY, hands: 1, wakes: 0, tokens: 0 } } });
    const res = await sweepCore(ctx, NOW);
    expect(res.started).toHaveLength(0);
    expect(res.skipped_capped).toEqual([ROLE]);
    expect(tables.workflow_runs).toHaveLength(0);
    expect(tables.daemon_commands).toHaveLength(0);
    expect(tables.tasks[0].status).toBe("open");
  });

  test("a stale counter row from yesterday does not hold today's cap", async () => {
    const { ctx, tables } = fixtures({ role: { caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1_000_000 }, counters: { day: "2020-01-01", hands: 1, wakes: 0, tokens: 0 } } });
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

  test("candidates: only open tasks assigned to agent:<handle> with no run and no open blocker", async () => {
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
      role: { caps: { hands_per_day: 2, wakes_per_day: 10, tokens_per_day: 1_000_000 } },
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
  const caps = (over: Record<string, any> = {}) => ({ caps: { hands_per_day: 10, wakes_per_day: 10, tokens_per_day: 1_000_000, ...over } });
  // A pending card at the card gate of a run the role's standing session spawned.
  const card = (n: number, over: Record<string, any> = {}) => ({
    _id: `session_decisions_${n}`, conversation_id: STANDING, session_id: "standing", user_id: HOST, question: "Ship it?", options: [], blocking: true, status: "pending",
    workflow_run_id: `workflow_runs_card${n}`, gate_node_id: LINE_CARD_GATE_NODE, created_at: NOW, ...over,
  });
  const cardRun = (n: number, over: Record<string, any> = {}) => ({ _id: `workflow_runs_card${n}`, user_id: HOST, status: "paused", spawner_conversation_id: STANDING, task_id: `tasks_card${n}`, node_statuses: [], ...over });
  // What the runner leaves on a run once its card is answered: the gate's node completes.
  const answer = (run: any) => {
    run.status = "running";
    run.node_statuses = [{ node_id: LINE_CARD_GATE_NODE, status: "completed" }];
  };

  test("candidates rank by goal priority, severity and signals; unready, ungrounded and someone else's causes stay out", async () => {
    const { ctx, tables } = fixtures({
      role: caps(),
      extra: {
        initiatives,
        tasks: [
          task({ _id: "tasks_assigned", short_id: "ct-1", created_at: NOW - 9000 }),
          cause({ _id: "tasks_p0", short_id: "ct-2" }),
          cause({ _id: "tasks_p3_urgent", short_id: "ct-3", goal_ref: "in-2:polish", priority: "urgent" }),
          cause({ _id: "tasks_none_loud", short_id: "ct-4", goal_ref: "none", cause: { signal_count: 4, first_seen: 1, last_seen: 1, fingerprints: [] } }),
          cause({ _id: "tasks_foreign_goal", short_id: "ct-5", goal_ref: "in-9:x" }),
          cause({ _id: "tasks_not_ready", short_id: "ct-6", readiness: "needs_context" }),
          cause({ _id: "tasks_ungrounded", short_id: "ct-7", goal_ref: undefined }),
          cause({ _id: "tasks_persons", short_id: "ct-8", assignee: MATE }),
          cause({ _id: "tasks_running", short_id: "ct-9", workflow_run_id: "workflow_runs_x" }),
        ],
      },
    });
    // p0 x medium = 16; p3 x urgent = 4; unranked (a ref this workspace cannot
    // read) x medium = 2; none x medium x (1 + log2 4) = 1.5; the assigned
    // task with no goal = 0.5.
    expect((await lineCandidates(ctx, tables.org_roles[0])).map((t) => t._id)).toEqual(["tasks_p0", "tasks_p3_urgent", "tasks_foreign_goal", "tasks_none_loud", "tasks_assigned"]);
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_p0", "tasks_p3_urgent", "tasks_foreign_goal", "tasks_none_loud", "tasks_assigned"]);
  });

  test("a project goal_ref reads the project's priority", async () => {
    const { ctx, tables } = fixtures({
      extra: {
        projects: [{ _id: PROJECT, short_id: "pj-1", title: "Growth", priority: "p1", user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, created_at: 1, updated_at: 1 }],
        initiatives,
        tasks: [cause({ _id: "tasks_proj", goal_ref: "pj-1" }), cause({ _id: "tasks_p3", short_id: "ct-3", goal_ref: "in-2:polish" })],
      },
    });
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q.items.map((i) => [i.task_id, i.priority])).toEqual([["tasks_proj", 8], ["tasks_p3", 2]]);
  });

  test("open cards at the cap hold every cause; only blocking pending cards at this line's card gate count", async () => {
    const { ctx, tables } = fixtures({
      role: caps({ cards: 2 }),
      extra: {
        initiatives,
        tasks: [cause({ _id: "tasks_p0" })],
        // Runs 3 and 4 finished, so only their pending decisions could count;
        // run 5's card was answered and it is merging.
        workflow_runs: [
          cardRun(1),
          cardRun(2),
          cardRun(3, { status: "completed" }),
          cardRun(4, { status: "completed" }),
          cardRun(5, { status: "running", node_statuses: [{ node_id: LINE_CARD_GATE_NODE, status: "completed" }] }),
          cardRun(6, { spawner_conversation_id: "conversations_other" }),
        ],
        session_decisions: [
          card(1),
          card(2),
          card(3, { blocking: false }),
          card(4, { gate_node_id: "plan" }),
          card(5, { status: "answered" }),
          card(6),
        ],
      },
    });
    const res = await sweepCore(ctx, NOW);
    expect(res.started).toHaveLength(0);
    expect(res.skipped_cards).toEqual([ROLE]);
    expect(tables.tasks[0].status).toBe("open");
    const q = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(q).toMatchObject({ open_cards: 2, cards_cap: 2, waiting: "queued behind 2 open cards" });
    expect(q.items.map((i) => i.waiting)).toEqual(["queued behind 2 open cards"]);
  });

  test("caps.cards defaults to 5", async () => {
    const decisions = [1, 2, 3, 4, 5].map((n) => card(n));
    const runs = [1, 2, 3, 4, 5].map((n) => cardRun(n));
    const held = fixtures({ extra: { initiatives, tasks: [cause()], workflow_runs: runs, session_decisions: decisions } });
    expect((await sweepCore(held.ctx, NOW)).skipped_cards).toEqual([ROLE]);
    const open = fixtures({ extra: { initiatives, tasks: [cause()], workflow_runs: runs.slice(1), session_decisions: decisions.slice(1) } });
    expect((await sweepCore(open.ctx, NOW)).started).toHaveLength(1);
  });

  test("answering a card frees a slot and the highest cause starts next", async () => {
    const { ctx, tables } = fixtures({
      role: caps({ cards: 1, hands_per_day: 1 }),
      extra: {
        initiatives,
        tasks: [cause({ _id: "tasks_low", short_id: "ct-2", goal_ref: "in-2:polish", created_at: NOW - 9000 }), cause({ _id: "tasks_high", short_id: "ct-3" })],
        workflow_runs: [cardRun(1)],
        session_decisions: [card(1)],
      },
    });
    expect((await sweepCore(ctx, NOW)).started).toHaveLength(0);
    tables.session_decisions[0].status = "answered";
    answer(tables.workflow_runs[0]);
    const res = await sweepCore(ctx, NOW + 120_000);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_high"]);
    // The hands cap of one holds the rest for tomorrow.
    expect(res.skipped_capped).toEqual([ROLE]);
    expect(tables.tasks.find((t) => t._id === "tasks_low")!.status).toBe("open");
  });

  test("a started run holds its card slot before it asks: 7 causes, cap 5, start 5 until a card is answered", async () => {
    const { ctx, tables } = fixtures({
      role: caps({ cards: 5, hands_per_day: 20 }),
      extra: { initiatives, tasks: [1, 2, 3, 4, 5, 6, 7].map((n) => cause({ _id: `tasks_c${n}`, short_id: `ct-${n}`, created_at: NOW - 10_000 + n })) },
    });
    const before = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(before.items.map((i) => i.waiting)).toEqual([null, null, null, null, null, "queued behind 5 open cards", "queued behind 5 open cards"]);
    const first = await sweepCore(ctx, NOW);
    expect(first.started.map((s) => s.task_id)).toEqual(["tasks_c1", "tasks_c2", "tasks_c3", "tasks_c4", "tasks_c5"]);
    expect(first.skipped_cards).toEqual([ROLE]);
    const held = await lineQueueFor(ctx, tables.org_roles[0], NOW);
    expect(held).toMatchObject({ open_cards: 5, waiting: "queued behind 5 open cards" });
    const second = await sweepCore(ctx, NOW + 120_000);
    expect(second.started).toHaveLength(0);
    expect(second.skipped_cards).toEqual([ROLE]);
    answer(tables.workflow_runs[0]);
    const third = await sweepCore(ctx, NOW + 240_000);
    expect(third.started.map((s) => s.task_id)).toEqual(["tasks_c6"]);
    expect(tables.tasks.find((t) => t._id === "tasks_c7")!.status).toBe("open");
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
