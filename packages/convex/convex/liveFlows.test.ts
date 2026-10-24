import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { LINE_RUNS_PER_RUNNER, requeueCore, sweepCore } from "./orgLine";
import { clearHoldCore, createLiveFlowCore, holdFromCli, liveFlowView, MAX_HOLD_MS, setOnCore, setOnFromCli, showFromCli } from "./liveFlows";
import { hashToken } from "./apiTokens";

// A team's live flow (liveFlows.ts): one queue in start order across every
// lead, admitted onto each problem's area lead's machines, while the leads
// admit nothing on their own.

const HOST = "u".repeat(31) + "h";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const NOW = Date.now();

// Two leads, each over its own project, with its own standing session.
// Deals runs on MATE's machine, so its runs count there.
const lead = (key: string, runner: string) => ({
  role: {
    _id: `org_roles_${key}`, short_id: `or-${key}`, scope_type: "team", team_id: TEAM, host_user_id: runner, name: `${key} lead`, handle: key,
    scope: { project_ids: [`projects_${key}`], plan_ids: [] }, reports_to: { kind: "user", user_id: HOST }, status: "active", trust: "direct",
    anchor_id: `anchors_${key}`, caps: { line_on: true }, created_by: HOST, created_at: 1, updated_at: 1,
  },
  anchor: { _id: `anchors_${key}`, team_id: TEAM, bot_user_id: "users_bot", host_user_id: runner, conversation_id: `conversations_${key}` },
  conversation: { _id: `conversations_${key}`, session_id: key, user_id: runner, team_id: TEAM, status: "active", title: `${key} lead`, agent_type: "claude_code", message_count: 1, standing_role_id: `org_roles_${key}`, anchor_id: `anchors_${key}`, updated_at: NOW, project_path: `/srv/${key}` },
  project: { _id: `projects_${key}`, short_id: `pj-${key}`, title: key, user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, owner_role_id: `org_roles_${key}`, created_at: 1, updated_at: 1 },
});
const growth = lead("growth", HOST);
const deals = lead("deals", MATE);

const scored = (score: number | null, signal_count = 1) => ({
  signal_count, first_seen: 1, last_seen: 1, fingerprints: ["f"],
  ...(score == null ? {} : { scored: { score, harm: 3, reach: 3, fixability: 3, reason: "r", root_cause: "c", at: 1, version: "1" } }),
});
const problem = (id: string, project: string, score: number | null, over: Record<string, any> = {}) => ({
  _id: `tasks_${id}`, short_id: `ct-${id}`, title: `Problem ${id}`, status: "open", priority: "medium", source: "signal", readiness: "ready", goal_ref: "none",
  project_id: `projects_${project}`, user_id: HOST, team_id: TEAM, workspace: `team:${TEAM}`, cause: scored(score), created_at: NOW - 1000, updated_at: NOW - 1000, ...over,
});

function fixtures(o: { tasks: any[]; flow?: Record<string, any> | null; extra?: Record<string, any[]> }) {
  const db = makeFakeDb({
    users: [{ _id: HOST, name: "Host", email: "host@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }],
    team_memberships: [
      { _id: "m1", user_id: HOST, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    projects: [growth.project, deals.project],
    plans: [],
    tasks: o.tasks,
    org_roles: [growth.role, deals.role],
    anchors: [growth.anchor, deals.anchor],
    conversations: [growth.conversation, deals.conversation],
    workflows: [{ _id: "workflows_spine", user_id: HOST, slug: "agentwatch", name: "agentwatch", label: "Acme fix flow", nodes: [], edges: [], created_at: 1, updated_at: 1 }],
    live_flows: o.flow === null ? [] : [{ _id: "live_flows_1", workspace: `team:${TEAM}`, team_id: TEAM, workflow_id: "workflows_spine", on: true, changed_by: HOST, changed_at: 1, created_at: 1, ...(o.flow ?? {}) }],
    workflow_runs: [],
    daemon_commands: [],
    messages: [],
    task_comments: [],
    signals: [],
    org_role_history: [],
    directory_team_mappings: [],
    thread_reads: [],
    entity_subscriptions: [],
    counters: [],
    ...(o.extra ?? {}),
  });
  return { ctx: { db } as any, tables: db._tables as Record<string, any[]> };
}

describe("liveFlows (one live flow per team)", () => {
  test("one queue across the leads in start order; each run starts as its area's lead, on that lead's seat", async () => {
    const { ctx, tables } = fixtures({
      tasks: [
        problem("g40", "growth", 40),
        problem("d90", "deals", 90),
        problem("g70", "growth", 70),
        problem("new", "deals", null, { cause: scored(null, 5) }),
      ],
    });
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_d90", "tasks_g70", "tasks_new", "tasks_g40"]);
    expect(res.started.every((s) => s.live_flow_id === "live_flows_1")).toBe(true);
    const runOf = (t: string) => tables.workflow_runs.find((r) => r.task_id === t)!;
    // A Deals problem runs as Deals: its seat (MATE's machine) and its standing session, so its card goes to Deals' person.
    expect(runOf("tasks_d90")).toMatchObject({ org_role_id: "org_roles_deals", user_id: MATE, spawner_conversation_id: "conversations_deals", project_path: "/srv/deals" });
    expect(runOf("tasks_g70")).toMatchObject({ org_role_id: "org_roles_growth", user_id: HOST, spawner_conversation_id: "conversations_growth" });
    expect(tables.live_flows[0].counters).toEqual({ day: new Date(NOW).toISOString().slice(0, 10), hands: 4 });
  });

  test("a lead whose machine is full holds back only its own problems", async () => {
    const busy = Array.from({ length: LINE_RUNS_PER_RUNNER }, (_, n) => ({ _id: `workflow_runs_b${n}`, user_id: MATE, status: "running", org_role_id: "org_roles_deals", task_id: `tasks_b${n}`, node_statuses: [] }));
    const { ctx } = fixtures({ tasks: [problem("d90", "deals", 90), problem("g20", "growth", 20)], extra: { workflow_runs: busy } });
    const res = await sweepCore(ctx, NOW);
    expect(res.started.map((s) => s.task_id)).toEqual(["tasks_g20"]);
    const view = await liveFlowView(ctx, (ctx.db as any)._tables.live_flows[0], NOW);
    expect(view.queue[0]).toEqual({ task_id: "tasks_d90", waiting: `${LINE_RUNS_PER_RUNNER} runs are working on @deals's machine` });
  });

  test("off, the flow starts nothing, and its leads admit nothing on their own either", async () => {
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], flow: { on: false } });
    expect((await sweepCore(ctx, NOW)).started).toEqual([]);
    expect(tables.workflow_runs).toEqual([]);
    const view = await liveFlowView(ctx, tables.live_flows[0], NOW);
    expect(view).toMatchObject({ on: false, waiting: "the flow is off", flow: { id: "workflows_spine", slug: "agentwatch", label: "Acme fix flow" }, queue: [{ task_id: "tasks_g70", waiting: "the flow is off" }] });
    // Without a live flow the lead's own line starts it, as before.
    const { ctx: plain } = fixtures({ tasks: [problem("g70", "growth", 70)], flow: null });
    expect((await sweepCore(plain, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_g70"]);
  });

  test("its hands cap stops the flow for the day; a requeued problem says the live flow starts it", async () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70), problem("g60", "growth", 60)], flow: { caps: { hands_per_day: 3 }, counters: { day, hands: 2 } } });
    expect((await sweepCore(ctx, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_g70"]);
    expect((await sweepCore(ctx, NOW)).started).toEqual([]);
    const view = await liveFlowView(ctx, tables.live_flows[0], NOW);
    expect(view).toMatchObject({ hands_today: 3, waiting: "hands cap reached", running: [tables.workflow_runs[0]._id] });
    tables.workflow_runs[0].status = "failed";
    const back = await requeueCore(ctx, HOST, "ct-g70", NOW);
    expect(back.queued).toBe("ct-g70 is back in the line's queue; the live flow starts it in rank order.");
  });

  test("a source the flow does not take stays out of its queue", async () => {
    const { ctx } = fixtures({
      tasks: [problem("a", "growth", 80), problem("b", "growth", 50)],
      flow: { sources: ["judge:agent-review"] },
      extra: { signals: [{ _id: "signals_a", task_id: "tasks_a", source: "union.eval" }, { _id: "signals_b", task_id: "tasks_b", source: "judge:agent-review" }] },
    });
    expect((await sweepCore(ctx, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_b"]);
  });

  test("created on when a lead's line was on, naming those lines, and the next sweep admits from it", async () => {
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70), problem("d90", "deals", 90)], flow: null });
    tables.org_roles.find((r) => r.handle === "deals")!.caps = { line_on: false };
    const made = await createLiveFlowCore(ctx, { team_id: TEAM, workflow_id: "workflows_spine" as any, by: HOST }, NOW);
    expect(made).toMatchObject({ on: true, carried_lines_on: ["growth"] });
    expect(tables.live_flows[0]).toMatchObject({ on: true, carried_lines_on: ["growth"], workspace: `team:${TEAM}` });
    // Deals' own line was off, but the flow's queue is one: its problem starts first, by score.
    const flow = tables.live_flows[0]._id;
    expect((await sweepCore(ctx, NOW)).started.map((s) => [s.task_id, s.live_flow_id])).toEqual([["tasks_d90", flow], ["tasks_g70", flow]]);
    await expect(createLiveFlowCore(ctx, { team_id: TEAM, workflow_id: "workflows_spine" as any, by: HOST }, NOW)).rejects.toThrow("already has a live flow");
  });

  test("created off when no lead's line was on", async () => {
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], flow: null });
    for (const r of tables.org_roles) r.caps = { line_on: false };
    expect(await createLiveFlowCore(ctx, { team_id: TEAM, workflow_id: "workflows_spine" as any, by: HOST }, NOW)).toMatchObject({ on: false, carried_lines_on: [] });
    expect((await sweepCore(ctx, NOW)).started).toEqual([]);
  });

  test("the switch is a team admin's; the CLI shows the flow by team id and never switches it", async () => {
    const token = "cx_live_flow_test_token";
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], flow: { on: false }, extra: { api_tokens: [{ _id: "api_tokens_1", user_id: HOST, token_hash: await hashToken(token), name: "cli", created_at: 1 }] } });
    await expect(setOnCore(ctx, MATE as any, tables.live_flows[0], true, NOW)).rejects.toThrow("team admin required");
    await setOnCore(ctx, HOST as any, tables.live_flows[0], true, NOW);
    expect(tables.live_flows[0]).toMatchObject({ on: true, changed_by: HOST, changed_at: NOW });
    const show = (args: Record<string, any>) => (showFromCli as any)._handler(ctx, { api_token: token, ...args });
    expect(await show({})).toBeNull();
    const [row] = await show({ team_id: TEAM, flow: "Acme fix flow" });
    expect(row).toMatchObject({ _id: "live_flows_1", on: true, flow: { slug: "agentwatch" }, sources: null, queue: [{ short_id: "ct-g70", score: 70, area: { handle: "growth" }, waiting: null }] });
    const flip = (args: Record<string, any>) => (setOnFromCli as any)._handler(ctx, { api_token: token, on: false, team_id: TEAM, ...args });
    await expect(flip({ flow: "nope" })).rejects.toThrow('No live flow of the team runs "nope"');
    await expect(flip({ flow: "agentwatch" })).rejects.toThrow("A person switches a live flow off, from the Flows page in the browser");
    expect(tables.live_flows[0].on).toBe(true);
  });

  test("a timed hold stops admission and says why until it ends; a hand sets it, a person clears it", async () => {
    const token = "cx_live_flow_hold_token";
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], extra: { api_tokens: [{ _id: "api_tokens_1", user_id: HOST, token_hash: await hashToken(token), name: "cli", created_at: 1 }] } });
    const hold = (args: Record<string, any>) => (holdFromCli as any)._handler(ctx, { api_token: token, team_id: TEAM, from_session: "jx7hand", ...args });
    await expect(hold({ why: "eval_reserve spent", until: Date.now() + MAX_HOLD_MS + 60_000 })).rejects.toThrow("at most 48 hours");
    await expect(hold({ why: " ", until: Date.now() + 60_000 })).rejects.toThrow("Say why");
    const until = Date.now() + 4 * 3_600_000;
    const held = await hold({ why: "eval_reserve spent ($3,007 of $3,000) until the 00:00 UTC roll-over", until });
    expect(held.hold).toMatchObject({ until, by: "jx7hand" });
    // A shorter second hold keeps the later end.
    expect((await hold({ why: "still spent", until: until - 3_600_000 })).hold).toMatchObject({ until, why: "still spent" });
    expect((await sweepCore(ctx, Date.now())).started).toEqual([]);
    const view = await liveFlowView(ctx, tables.live_flows[0], Date.now());
    expect(view.hold).toMatchObject({ why: "still spent", until, by: "jx7hand" });
    expect(view.waiting).toStartWith("held until ");
    expect(view.queue).toEqual([{ task_id: "tasks_g70", waiting: view.waiting }]);
    // Ended, it no longer holds anything.
    expect((await sweepCore(ctx, until + 1000)).started.map((st) => st.task_id)).toEqual(["tasks_g70"]);
  });

  test("a hold set from a session names it by its short id, never by the agent's raw session id", async () => {
    const token = "cx_live_flow_hold_uuid_token";
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], extra: { api_tokens: [{ _id: "api_tokens_1", user_id: HOST, token_hash: await hashToken(token), name: "cli", created_at: 1 }] } });
    const uuid = "378a9c20-019f-485d-9837-9e99fc369bfe";
    tables.conversations.push({ _id: "conversations_hold", session_id: uuid, short_id: "jx7hold", user_id: HOST, team_id: TEAM, status: "active", title: "hold", agent_type: "claude_code", message_count: 1, updated_at: NOW });
    const hold = (from_session: string) => (holdFromCli as any)._handler(ctx, { api_token: token, team_id: TEAM, from_session, why: "disks full", until: Date.now() + 3_600_000 });
    expect((await hold(uuid)).hold.by).toBe("jx7hold");
    expect((await hold("0000aaaa-0000-0000-0000-000000000000")).hold.by).toBe(`user:${HOST}`);
  });

  test("only a team admin clears a hold", async () => {
    const { ctx, tables } = fixtures({ tasks: [problem("g70", "growth", 70)], flow: { hold: { why: "spent", until: Date.now() + 3_600_000, by: "jx7hand", at: 1 } } });
    await expect(clearHoldCore(ctx, MATE as any, tables.live_flows[0])).rejects.toThrow("team admin required");
    await clearHoldCore(ctx, HOST as any, tables.live_flows[0]);
    expect(tables.live_flows[0].hold).toBeUndefined();
    expect((await sweepCore(ctx, NOW)).started.map((st) => st.task_id)).toEqual(["tasks_g70"]);
  });

  test("a run whose task waits holds no machine slot, as a run at a card holds none", async () => {
    const parked = Array.from({ length: LINE_RUNS_PER_RUNNER }, (_, n) => ({ _id: `workflow_runs_p${n}`, user_id: MATE, status: "running", org_role_id: "org_roles_deals", task_id: `tasks_p${n}`, node_statuses: [] }));
    const waits = parked.map((r, n) => problem(`p${n}`, "deals", 10, { _id: r.task_id, status: "in_progress", waiting_since: 1, waits: [{ id: `w${n}`, kind: "time", at: Date.now() + 3_600_000, state: "waiting", added_at: 1 }] }));
    const { ctx } = fixtures({ tasks: [problem("d90", "deals", 90), ...waits], extra: { workflow_runs: parked } });
    // All four of Deals' machine slots hold parked runs, so its next problem still starts.
    expect((await sweepCore(ctx, NOW)).started.map((st) => st.task_id)).toEqual(["tasks_d90"]);
  });
});

// Which graph a live flow's run takes (lib/flowRoute, workflows.lineRouteFor):
// one of the flow's family, whoever runs the seat, never the runner's own line.
describe("liveFlows: each problem runs a graph of the flow's family", () => {
  const WS = `team:${TEAM}`;
  const wf = (id: string, over: Record<string, any>) => ({ _id: `workflows_${id}`, user_id: HOST, workspace: WS, team_id: TEAM, name: id, label: id, nodes: [], edges: [], created_at: 1, updated_at: 1, ...over });
  const spine = wf("spine", { slug: "agentwatch", source: 'digraph a { graph [kind="line"] }', serves: ["person"], runs_from: "library", origin: { file: "outreach/line/agentwatch.cast" } });
  const system = wf("system", { slug: "agentwatch-system", source: 'digraph s { graph [extends="agentwatch.cast"] }', serves: ["union.eval"], runs_from: "library", origin: { file: "outreach/line/agentwatch-system.cast" } });
  const judgeFlow = wf("judge", { slug: "agentwatch-trial-judge", source: 'digraph j { graph [kind="line", serves="judge-review"] }', serves: ["judge-review"], runs_from: "library", origin: { file: "outreach/line/agentwatch-trial-judge.cast" } });
  // HOST's own plain line, and a graph of MATE's that serves person outside the flow: neither may run under the flow.
  const ownLines = [wf("hostline", { slug: "line", workspace: `user:${HOST}` }), wf("mateline", { user_id: MATE, slug: "line", workspace: `user:${MATE}` }), wf("mateperson", { user_id: MATE, slug: "line-person", workspace: `user:${MATE}`, serves: ["person"] })];
  const version = (w: any, n: number) => ({ _id: `workflow_versions_${w._id}`, workflow_id: w._id, graph_hash: `h${n}`, nodes: [], changed: [], by: HOST, at: n, snapshot: { name: w.name, source: w.source, nodes: [], edges: [], file: w.origin.file, files: [] } });
  const judgeCause = { signal_count: 2, first_seen: 1, last_seen: 1, fingerprints: ["judge:codecast:agent-review:ex-3"] };
  const tasks = [
    problem("person", "deals", 90),
    problem("eval", "deals", 80),
    problem("lesson", "growth", 70),
    problem("judge", "deals", 60, { cause: judgeCause }),
  ];
  const signals = [
    { _id: "signals_person", task_id: "tasks_person", source: "person" },
    { _id: "signals_eval", task_id: "tasks_eval", source: "union.eval" },
    { _id: "signals_lesson", task_id: "tasks_lesson", source: "lesson" },
    { _id: "signals_judge", task_id: "tasks_judge", source: "judge-review" },
  ];
  const setup = (flows: any[], flow?: Record<string, any> | null) => fixtures({
    tasks: tasks.map((t) => ({ ...t })),
    flow,
    extra: { workflows: [...flows, ...ownLines], workflow_versions: flows.map(version), signals },
  });
  const graphOf = (tables: Record<string, any[]>, t: string) => tables.workflow_runs.find((r) => r.task_id === `tasks_${t}`)?.workflow_id;

  test("the member serving the source, else the spine, on any runner; each run records its library versions", async () => {
    const { ctx, tables } = setup([spine, system, judgeFlow]);
    expect((await sweepCore(ctx, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_person", "tasks_eval", "tasks_lesson", "tasks_judge"]);
    // Deals runs on MATE's machine, and MATE pushed no graph of the flow's: the runs still take the family's.
    expect(tables.workflow_runs.find((r) => r.task_id === "tasks_person")).toMatchObject({ user_id: MATE, workflow_id: "workflows_spine" });
    expect(graphOf(tables, "eval")).toBe("workflows_system");
    expect(graphOf(tables, "lesson")).toBe("workflows_spine");
    expect(graphOf(tables, "judge")).toBe("workflows_judge");
    // A variant records itself and the spine it extends.
    expect(tables.workflow_runs.find((r) => r.task_id === "tasks_eval")!.flow_versions).toEqual([
      { workflow_id: "workflows_system", version_id: "workflow_versions_workflows_system" },
      { workflow_id: "workflows_spine", version_id: "workflow_versions_workflows_spine" },
    ]);
    expect(tables.workflow_runs.find((r) => r.task_id === "tasks_judge")!.flow_versions).toEqual([{ workflow_id: "workflows_judge", version_id: "workflow_versions_workflows_judge" }]);
  });

  test("with no judge flow in the family a judge problem waits, saying so, and the rest start", async () => {
    const { ctx, tables } = setup([spine, system]);
    expect((await sweepCore(ctx, NOW)).started.map((s) => s.task_id)).toEqual(["tasks_person", "tasks_eval", "tasks_lesson"]);
    expect(graphOf(tables, "judge")).toBeUndefined();
    const view = await liveFlowView(ctx, tables.live_flows[0], NOW);
    expect(view.queue).toEqual([{ task_id: "tasks_judge", waiting: "no judge flow" }]);
    // A start outside the sweep refuses it too, rather than run another line.
    const { startLineRun } = await import("./orgLine");
    await expect(startLineRun(ctx, tables.org_roles.find((r) => r.handle === "deals"), tables.tasks.find((t) => t._id === "tasks_judge"), NOW)).rejects.toThrow("ct-judge waits: no judge flow");
  });

  test("without a live flow a run keeps its runner's own versions", async () => {
    const { ctx, tables } = setup([spine, system, judgeFlow], null);
    const { startLineRun } = await import("./orgLine");
    const deals = tables.org_roles.find((r) => r.handle === "deals")!;
    deals.line_workflow_slug = "line";
    for (const t of ["tasks_person", "tasks_eval"]) await startLineRun(ctx, deals, tables.tasks.find((x) => x._id === t), NOW);
    expect(graphOf(tables, "person")).toBe("workflows_mateperson");
    expect(graphOf(tables, "eval")).toBe("workflows_mateline");
  });

  test("with the flow off, a start by hand keeps the runner's own versions", async () => {
    const { ctx, tables } = setup([spine, system, judgeFlow], { on: false });
    const { startLineRun } = await import("./orgLine");
    const deals = tables.org_roles.find((r) => r.handle === "deals")!;
    deals.line_workflow_slug = "line";
    await startLineRun(ctx, deals, tables.tasks.find((t) => t._id === "tasks_person"), NOW);
    expect(graphOf(tables, "person")).toBe("workflows_mateperson");
  });
});
