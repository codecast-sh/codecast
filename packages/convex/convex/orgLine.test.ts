import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { LINE_STARTED_PREFIX, lineCandidates, sweepCore } from "./orgLine";
import { lineSlugOf, normalizeLineSlug, performSetLine } from "./orgRoles";

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
