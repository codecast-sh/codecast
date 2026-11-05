import { describe, expect, test } from "bun:test";
import { LINE_STARTED_PREFIX, lineCandidates, sweepCore } from "./orgLine";
import { lineSlugOf, normalizeLineSlug, performSetLine } from "./orgRoles";
import { HOST, MATE, ROLE, STANDING, NOW, TODAY, TEAM, task, fixtures } from "./orgLine.testkit";

// the-line.md L2 (a scope owns a line) and L9 (the sweep starts it), driven
// through the exported core functions against the fake db.

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

  test("a plain member may not change the line", async () => {
    const { ctx } = fixtures();
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
