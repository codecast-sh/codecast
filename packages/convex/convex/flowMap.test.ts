import { describe, expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";
import * as flowMap from "./flowMap";
import { foldRollup, recountFrom } from "./flowMap";
import { DAY_MS, STALLED_MS, normalDay, problemOutcome, sourceState, utcDayKey, windowDays } from "@codecast/shared/contracts/flowMap";

// The flow map (flowMap.ts): the hourly rollup of a workspace's sources and
// problems, and the view the Flows page reads from it and from the live rows.

const h = (fn: any) => fn._handler;
const VIEWER = "users_viewer";
const MATE = "users_mate";
const TEAM = "teams_union";
const WS = `team:${TEAM}`;
// Mid-day UTC, so "today" and "yesterday" are both real days.
const NOW = Date.parse("2026-10-24T12:00:00Z");
const H = 3_600_000;

const node = (id: string, type = "agent") => ({ id, label: id[0].toUpperCase() + id.slice(1), shape: "box", type });
const spineNodes = [node("start", "start"), node("investigate"), node("rebase", "command"), node("build"), node("decide", "human"), node("exit", "exit")];

function fixtures(extra: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: VIEWER, name: "Viewer" }, { _id: MATE, name: "Mate" }],
    teams: [{ _id: TEAM, name: "Union" }],
    team_memberships: [
      { _id: "team_memberships_1", user_id: VIEWER, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "team_memberships_2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    live_flows: [{ _id: "live_flows_1", workspace: WS, team_id: TEAM, workflow_id: "workflows_spine", on: true, caps: { hands_per_day: 100 }, counters: { day: utcDayKey(NOW), hands: 7 }, changed_by: VIEWER, changed_at: 1, created_at: 1 }],
    workflows: [
      { _id: "workflows_spine", user_id: VIEWER, workspace: WS, slug: "agentwatch", name: "agentwatch", label: "Union fix flow", serves: ["judge:agent-review", "person"], nodes: spineNodes, edges: [], created_at: 1, updated_at: 1 },
      { _id: "workflows_system", user_id: VIEWER, workspace: WS, slug: "agentwatch-system", name: "agentwatch-system", label: "Union fix flow · system", source: 'digraph x { graph [extends="agentwatch"] }', serves: ["sdk:union-errors"], nodes: spineNodes, edges: [], created_at: 1, updated_at: 2 },
      { _id: "workflows_line", user_id: MATE, workspace: `user:${MATE}`, slug: "line", name: "line", nodes: [], edges: [], created_at: 1, updated_at: 1 },
    ],
    signals: [],
    tasks: [],
    workflow_runs: [],
    flow_map_rollups: [],
    event_sources: [
      { _id: "event_sources_errors", workspace: WS, team_id: TEAM, owner_user_id: VIEWER, short_id: "src-1", provider: "sdk", name: "union-errors", promote: ["new", "regressed"], status: "active", created_at: 1, updated_at: 1 },
      { _id: "event_sources_ci", workspace: WS, team_id: TEAM, owner_user_id: VIEWER, short_id: "src-2", provider: "github", name: "github-ci", promote: [], status: "active", created_at: 1, updated_at: 1 },
      { _id: "event_sources_posthog", workspace: WS, team_id: TEAM, owner_user_id: VIEWER, short_id: "src-3", provider: "posthog", name: "union-posthog", promote: ["new"], status: "error", created_at: 1, updated_at: 1 },
    ],
    external_events: [],
    event_groups: [],
    metric_watches: [
      { _id: "metric_watches_1", workspace: WS, source_id: "event_sources_posthog", short_id: "mw-1", name: "Exceptions (24h)", status: "active", state: "alert" },
      { _id: "metric_watches_2", workspace: WS, source_id: "event_sources_posthog", short_id: "mw-2", name: "Visitors (24h)", status: "active", state: "ok" },
    ],
    judges: [{ _id: "judges_ar", source_id: "event_sources_errors", name: "agent-review", workspace: WS }],
    projects: [{ _id: "projects_1", workspace: WS, team_id: TEAM, title: "Union", line_profile: { finders: [{ id: "union.desk", source: "union.desk", kind: "any", fingerprint: "f", label: "Desk corrections", what: "An expert edits an agent step", group: "people" }] } }],
    session_decisions: [],
    ...extra,
  };
  const db = makeFakeDb(tables, { indexes: schemaIndexes(schema as any) });
  return { db: db as any, tables };
}

/** An action ctx whose runQuery/runMutation call the module's own handlers on the fake db. */
function actionCtx(db: any) {
  const call = (ref: any, args: any) => {
    const name = getFunctionName(ref).split(":")[1];
    return h((flowMap as any)[name])({ db }, args);
  };
  return { runQuery: call, runMutation: call };
}

const signal = (id: string, source: string, at: number, over: Record<string, any> = {}) => ({
  _id: `signals_${id}`, user_id: VIEWER, workspace: WS, short_id: `sg-${id}`, source, kind: "bug", fingerprint: id, title: id, observed_at: at, created_at: at, attach: "new", ...over,
});
const problem = (id: string, over: Record<string, any> = {}) => ({
  _id: `tasks_${id}`, short_id: `ct-${id}`, title: id, status: "open", source: "signal", readiness: "ready", workspace: WS, team_id: TEAM, user_id: VIEWER, created_at: NOW - DAY_MS, updated_at: NOW - DAY_MS, cause: { signal_count: 1 }, ...over,
});

describe("a problem's outcome", () => {
  const run = (status: string, nodes: string[] = []) => ({ status, node_statuses: nodes.map((node_id) => ({ node_id, status: "completed" })) });
  test("reads the task and its newest run", () => {
    expect(problemOutcome(problem("a"), null)).toBe("queued");
    expect(problemOutcome(problem("a", { readiness: "needs_context" }), null)).toBe("notReady");
    expect(problemOutcome(problem("a", { workflow_run_id: "r" }), run("running"))).toBe("running");
    expect(problemOutcome(problem("a", { status: "in_review", workflow_run_id: "r" }), run("paused"))).toBe("waiting");
    expect(problemOutcome(problem("a", { status: "in_review", workflow_run_id: "r" }), run("completed", ["build", "ship", "watch", "exit"]))).toBe("shipped");
    expect(problemOutcome(problem("a", { status: "done", workflow_run_id: "r" }), run("completed", ["dissolved_at_investigate", "exit"]))).toBe("closed");
    expect(problemOutcome(problem("a", { status: "in_review", workflow_run_id: "r" }), run("completed", ["failed_at_refine", "exit"]))).toBe("failed");
    expect(problemOutcome(problem("a", { workflow_run_id: "r" }), run("completed", ["park", "exit"]))).toBe("parked");
  });
  test("a merged problem counts on the one it merged into", () => {
    expect(problemOutcome(problem("a", { status: "dropped", cause: { merged_into: "tasks_b" } }), null)).toBeNull();
  });
});

describe("a source's normal day and state", () => {
  test("normal is the median of the days that had any", () => {
    expect(normalDay([0, 0, 4, 0, 10, 6])).toBe(6);
    expect(normalDay([0, 0])).toBe(0);
  });
  test("quiet when nothing came for twice its usual gap; stopped when nothing came in the window or the source is broken", () => {
    const daily = Array(14).fill(3);
    expect(sourceState({ lastAt: NOW - 3 * H, days: daily, now: NOW })).toBe("flowing");
    expect(sourceState({ lastAt: NOW - 3 * DAY_MS, days: daily, now: NOW })).toBe("quiet");
    // A batch every four days is not quiet two days after its last batch.
    const batches = [5, 0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5, 0];
    expect(sourceState({ lastAt: NOW - 2 * DAY_MS, days: batches, now: NOW })).toBe("flowing");
    expect(sourceState({ lastAt: NOW - 9 * DAY_MS, days: batches, now: NOW })).toBe("quiet");
    expect(sourceState({ lastAt: NOW - 20 * DAY_MS, days: Array(14).fill(0), now: NOW })).toBe("stopped");
    expect(sourceState({ lastAt: NOW - H, days: daily, now: NOW, broken: true })).toBe("stopped");
  });
});

describe("the rollup's fold", () => {
  const days = windowDays(NOW);
  test("a new row counts the whole window; a fresh one recounts yesterday and today", () => {
    expect(utcDayKey(recountFrom(null, NOW))).toBe(days[0]);
    expect(utcDayKey(recountFrom({ rolled_at: NOW - H }, NOW))).toBe(days[12]);
    expect(utcDayKey(recountFrom({ rolled_at: NOW - 5 * DAY_MS }, NOW))).toBe(days[0]);
  });
  test("keeps the last row's older days, replaces the recounted ones, drops days outside the window", () => {
    const prev = {
      sources: [{ key: "person", days: [{ day: "2026-09-01", n: 9 }, { day: days[5], n: 4 }, { day: days[12], n: 99 }], last_at: NOW - 2 * DAY_MS, outcomes: {} as any, escapes: 5 }],
      reopened: [{ task_id: "tasks_old", at: NOW - 30 * DAY_MS }, { task_id: "tasks_kept", at: NOW - 3 * DAY_MS }],
    };
    const out = foldRollup({
      workspace: WS, now: NOW, from: recountFrom({ rolled_at: NOW - H }, NOW), prev,
      counts: [{ source: "person", day: days[12], n: 2, last_at: NOW - 20 * H }, { source: "person", day: days[13], n: 1, last_at: NOW - H }],
      reopened: [{ task_id: "tasks_new", at: NOW - H }],
      outcomes: [{ source: "person", outcome: "queued" }, { source: "person", outcome: "failed" }],
      escapes: {},
    });
    expect(out.sources).toEqual([{ key: "person", days: [{ day: days[5], n: 4 }, { day: days[12], n: 2 }, { day: days[13], n: 1 }], last_at: NOW - H, outcomes: { queued: 1, notReady: 0, running: 0, waiting: 0, shipped: 0, closed: 0, failed: 1, parked: 0, total: 2 }, escapes: 0 }]);
    expect(out.reopened.map((r) => r.task_id).sort()).toEqual(["tasks_kept", "tasks_new"]);
  });
});

describe("rollup then forTeam", () => {
  function union() {
    const runs = [
      // On the spine, at Build: one healthy, one unchanged past STALLED_MS; one paused at the card, never stalled.
      { _id: "workflow_runs_1", workspace: WS, user_id: VIEWER, workflow_id: "workflows_spine", task_id: "tasks_ar1", status: "running", current_node_id: "build", created_at: NOW - H, updated_at: NOW - H },
      { _id: "workflow_runs_2", workspace: WS, user_id: VIEWER, workflow_id: "workflows_spine", task_id: "tasks_ar2", status: "running", current_node_id: "build", created_at: NOW - DAY_MS, updated_at: NOW - STALLED_MS - H },
      { _id: "workflow_runs_3", workspace: WS, user_id: VIEWER, workflow_id: "workflows_spine", task_id: "tasks_p1", status: "paused", current_node_id: "decide", created_at: NOW - DAY_MS, updated_at: NOW - 2 * DAY_MS },
      // A person's plain line on a teammate report, stalled at Rebase: off the flow, and an escape.
      { _id: "workflow_runs_4", workspace: WS, user_id: MATE, workflow_id: "workflows_line", task_id: "tasks_p2", status: "running", current_node_id: "rebase", graph_nodes: [{ id: "rebase", label: "Rebase" }], created_at: NOW - DAY_MS, updated_at: NOW - 20 * H },
      // Sitting at Rebase for 20h, but its runner's blocking decision names it: waiting on a person, not stalled.
      { _id: "workflow_runs_7", workspace: WS, user_id: MATE, workflow_id: "workflows_line", task_id: "tasks_p3", status: "running", current_node_id: "rebase", graph_nodes: [{ id: "rebase", label: "Rebase" }], created_at: NOW - DAY_MS, updated_at: NOW - 20 * H },
      // On the spine at Build, unchanged a day, its task holding a wait: waiting too.
      { _id: "workflow_runs_8", workspace: WS, user_id: VIEWER, workflow_id: "workflows_spine", task_id: "tasks_ar5", status: "running", current_node_id: "build", created_at: NOW - DAY_MS, updated_at: NOW - DAY_MS },
      { _id: "workflow_runs_other", workspace: "team:other", user_id: MATE, status: "paused", current_node_id: "decide", created_at: NOW - H, updated_at: NOW - H },
      // Finished today on the system variant.
      { _id: "workflow_runs_5", workspace: WS, user_id: VIEWER, workflow_id: "workflows_system", task_id: "tasks_e1", status: "completed", current_node_id: "exit", node_statuses: [{ node_id: "watch", status: "completed" }], created_at: NOW - 5 * H, updated_at: NOW - 2 * H },
    ];
    const tasks = [
      problem("ar1", { status: "in_progress", workflow_run_id: "workflow_runs_1", cause: { signal_count: 3, scored: { score: 80 } } }),
      problem("ar2", { status: "in_progress", workflow_run_id: "workflow_runs_2" }),
      problem("ar3", { cause: { signal_count: 1, scored: { score: 40 } } }),
      problem("ar4", { status: "dropped", cause: { merged_into: "tasks_ar3" } }),
      problem("p1", { status: "in_review", workflow_run_id: "workflow_runs_3" }),
      problem("p2", { status: "in_progress", workflow_run_id: "workflow_runs_4" }),
      problem("e1", { status: "in_review", workflow_run_id: "workflow_runs_5", watch_until: NOW + 6 * DAY_MS }),
      problem("jr", {}),
      problem("p3", { status: "in_progress", workflow_run_id: "workflow_runs_7", created_at: NOW - 40 * DAY_MS }),
      problem("ar5", { status: "in_progress", workflow_run_id: "workflow_runs_8", waiting_since: NOW - DAY_MS, created_at: NOW - 40 * DAY_MS }),
      problem("old", { created_at: NOW - 40 * DAY_MS }),
    ];
    const signals = [
      signal("1", "judge:agent-review", NOW - 3 * DAY_MS, { task_id: "tasks_ar1" }),
      signal("2", "judge:agent-review", NOW - 2 * DAY_MS, { task_id: "tasks_ar2" }),
      signal("3", "judge:agent-review", NOW - 2 * H, { task_id: "tasks_ar3" }),
      signal("4", "judge:agent-review", NOW - 2 * H, { task_id: "tasks_ar4" }),
      signal("5", "person", NOW - 5 * DAY_MS, { task_id: "tasks_p1" }),
      signal("6", "person", NOW - 4 * DAY_MS, { task_id: "tasks_p2" }),
      signal("7", "sdk:union-errors", NOW - 6 * H, { task_id: "tasks_e1" }),
      signal("8", "sdk:union-errors", NOW - 3 * H, { task_id: "tasks_e1", reopened: true }),
      signal("9", "judge-review", NOW - 4 * H, { task_id: "tasks_jr" }),
      signal("10", "person", NOW - 40 * DAY_MS, { task_id: "tasks_old" }),
    ];
    const ev = (id: string, source_id: string, kind: string, at: number) => ({ _id: `external_events_${id}`, team_id: TEAM, source: "ingest", source_id, kind, title: id, created_at: at });
    const external_events = [
      ev("1", "event_sources_errors", "error_new", NOW - 6 * H),
      ev("2", "event_sources_errors", "job_failed", NOW - 5 * H),
      ev("3", "event_sources_errors", "job_failed", NOW - 2 * DAY_MS),
      ev("4", "event_sources_errors", "deploy", NOW - H),
      ev("5", "event_sources_ci", "check_failed", NOW - 4 * H),
    ];
    const group = (id: string, source_id: string, kind: string, over: Record<string, any> = {}) => ({ _id: `event_groups_${id}`, workspace: WS, source_id, short_id: `eg-${id}`, kind, fingerprint: id, title: id, status: "open", first_seen: 1, last_seen: NOW - H, count: 1, buckets: [], updated_at: 1, ...over });
    const event_groups = [
      group("1", "event_sources_errors", "error", { signal_task_id: "tasks_e1" }),
      group("2", "event_sources_errors", "error"),
      group("3", "event_sources_errors", "job"),
      group("4", "event_sources_errors", "job"),
      group("5", "event_sources_ci", "check"),
      group("6", "event_sources_ci", "check", { status: "resolved" }),
    ];
    const decision = (id: string, user_id: string, over: Record<string, any> = {}) => ({ _id: `session_decisions_${id}`, user_id, conversation_id: "c", session_id: "s", question: "q", options: [], blocking: true, status: "pending", workflow_run_id: "workflow_runs_3", created_at: 1, ...over });
    // A decision names no workspace: its run's decides.
    const session_decisions = [decision("1", VIEWER), decision("2", MATE), decision("3", MATE, { workflow_run_id: "workflow_runs_other" }), decision("4", VIEWER, { blocking: false }), decision("5", MATE, { workflow_run_id: "workflow_runs_7" })];
    return fixtures({ tasks, signals, workflow_runs: runs, external_events, event_groups, session_decisions });
  }

  async function rolledMap(viewer = VIEWER) {
    const { db } = union();
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await h(flowMap.rollup)(actionCtx(db), { workspace: WS });
      return await h(flowMap.forTeam)({ db, auth: { getUserIdentity: async () => ({ subject: `${viewer}|sess` }) } }, { workspace: WS });
    } finally {
      Date.now = realNow;
    }
  }

  test("an outsider reads nothing", async () => {
    expect(await rolledMap("users_outsider")).toBeNull();
  });

  test("the live flow, its lanes, and runs at the step they stand at", async () => {
    const map = (await rolledMap())!;
    expect(map.rolledAt).toBe(NOW);
    expect(map.liveFlow).toMatchObject({ id: "live_flows_1", label: "Union fix flow", on: true, cap: 100, handsToday: 7, running: 2, stalled: 1, finishedToday: 1 });
    expect(map.lanes.map((l) => [l.key, l.kind, l.sources])).toEqual([["agentwatch", "spine", ["judge:agent-review", "person"]], ["agentwatch-system", "variant", ["sdk:union-errors"]]]);
    const spine = map.lanes[0];
    // The work stations, in graph order; a command station shows only while a run stands at it.
    expect(spine.steps).toEqual([
      { id: "investigate", label: "Investigate", running: 0, stalled: 0, waiting: 0 },
      { id: "build", label: "Build", running: 2, stalled: 1, waiting: 1 },
      { id: "decide", label: "Decide", running: 0, stalled: 0, waiting: 1 },
    ]);
    expect(map.off).toEqual({ running: 1, stalled: 1, steps: [{ id: "rebase", label: "Rebase", running: 1, stalled: 1, waiting: 1 }] });
  });

  test("each source: its counts, its lane, its escapes and where its problems stand", async () => {
    const map = (await rolledMap())!;
    const by = Object.fromEntries(map.sources.map((s) => [s.key, s]));
    const ar = by["judge:agent-review"];
    expect(ar).toMatchObject({ label: "agent-review judge", group: "conversations", route: "agentwatch", lastAt: NOW - 2 * H, opens: { judgeIds: ["judges_ar"] } });
    expect(ar.days.slice(-4)).toEqual([1, 1, 0, 2]);
    // ar4 merged into ar3: counted there, not here.
    expect(ar.outcomes).toMatchObject({ running: 2, queued: 1, total: 3 });

    const person = by.person;
    expect(person).toMatchObject({ label: "Teammate reports", group: "people", route: "agentwatch", escapes: 1 });
    // p2's run is on a person's plain line: it still counts as running.
    expect(person.outcomes).toMatchObject({ waiting: 1, running: 1, total: 2 });

    // No family member serves judge-review: its problems wait outside the flow.
    expect(by["judge-review"]).toMatchObject({ label: "Judge mistakes", route: "off", outcomes: { queued: 1, total: 1 } });

    const errors = by["sdk:union-errors"];
    expect(errors).toMatchObject({ route: "agentwatch-system", state: "flowing", today: 2, unfiled: 1, opens: { eventSourceId: "event_sources_errors" }, outcomes: { shipped: 1, total: 1 } });
    expect(by["sdk:union-errors:job_failed"]).toMatchObject({ label: "union-errors failed jobs", route: "unfiled", unfiled: 2, today: 1, lastAt: NOW - 5 * H });
    expect(by["github:github-ci:check_failed"]).toMatchObject({ route: "unfiled", unfiled: 1, today: 1 });
    // Metric watches on a source that files no metric alerts: a row of their own, the alerts counted as unfiled.
    expect(by["posthog:union-posthog:metric_alert"]).toMatchObject({ route: "unfiled", unfiled: 1, state: "stopped", opens: { eventSourceId: "event_sources_posthog", metricWatchIds: ["metric_watches_1", "metric_watches_2"] } });
    // An event source that promotes but has filed nothing yet still has its row; an erroring one is stopped.
    expect(by["posthog:union-posthog"]).toMatchObject({ state: "stopped", outcomes: { total: 0 } });
    // A deploy is not a problem kind.
    expect(by["sdk:union-errors:deploy"]).toBeUndefined();
  });

  test("header numbers", async () => {
    const map = (await rolledMap())!;
    // Open: ar1, ar2, ar3, ar5, p1, p2, p3, e1, jr, old (ar4 merged); scored: ar1, ar3.
    expect(map.header).toEqual({ problemsOpen: 10, problemsScored: 2, decisionsForYou: 1, decisionsForTeam: 2, watching: 1, regressed: 1 });
    expect(map.liveFlow!.queued).toBe(3);
  });

  test("a finder's declaration names its row", async () => {
    const { db } = fixtures({ signals: [signal("d", "union.desk", NOW - H)] });
    const realNow = Date.now;
    Date.now = () => NOW;
    try {
      await h(flowMap.rollup)(actionCtx(db), {});
      const map = await h(flowMap.forTeam)({ db, auth: { getUserIdentity: async () => ({ subject: `${VIEWER}|sess` }) } }, { workspace: WS });
      expect(map.sources.find((s: any) => s.key === "union.desk")).toMatchObject({ label: "Desk corrections", what: "An expert edits an agent step", group: "people", opens: { finderId: "union.desk" }, route: "agentwatch" });
    } finally {
      Date.now = realNow;
    }
  });
});
