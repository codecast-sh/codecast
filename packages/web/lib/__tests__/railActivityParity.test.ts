// The server's `cast sessions` split (convex dormantRailActivities) and the web
// rail's (lib/railActivity rowActivity) read the same shared rules, so one row
// says one thing in the terminal and in the inbox. This runs both over the
// same facts (runs, triggers, pull requests, decisions) and asserts the same
// section, flavor and words: the guard that would have caught the two drifting.
//
// Run: bun test lib/__tests__/railActivityParity.test.ts
import { describe, expect, test } from "bun:test";
import { sourceTakesSessionChange } from "@codecast/shared/contracts/flowPool";
import { sessionActivityWords } from "@codecast/shared/contracts/sessionActivityWords";
import { makeFakeDb } from "@codecast/convex/convex/testDb";
import { dormantRailActivities } from "@codecast/convex/convex/lib/sessionsTally";
import { rowActivity } from "../railActivity";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const VIEWER = "user_me";
const ROW = "jx7row00000000000000000000000000";

const CHANGE = `digraph change {\n  graph [kind="line", takes="task,branch"]\n}`;
const EXTENDS_CHANGE = `digraph change {\n  graph [extends="change"]\n}`;
const OWN_LANDING = `digraph land_built_change {\n  graph [label="Built change", takes="task,branch"]\n  land [label="Land", flow="ship"]\n}`;
const EVAL = `digraph eval {\n  graph [kind="line", label="Eval"]\n}`;
const BUILD = `digraph build {\n  graph [kind="line", label="Build"]\n}`;
const WORKFLOWS = [
  { _id: "wf_change", slug: "change", source: CHANGE },
  { _id: "wf_ext", slug: "change", source: EXTENDS_CHANGE },
  { _id: "wf_own", slug: "land-built-change", source: OWN_LANDING },
  { _id: "wf_eval", slug: "eval", source: EVAL },
  { _id: "wf_build", slug: "build", source: BUILD },
];

type Facts = {
  row?: Record<string, unknown>;
  runs?: Record<string, unknown>[];
  triggers?: Record<string, unknown>[];
  prs?: Record<string, unknown>[];
  decisions?: Record<string, unknown>[];
};

const run = (id: string, workflow: string, name: string, over: Record<string, unknown> = {}) => ({
  _id: id, workflow_id: workflow, workflow_name: name, spawner_conversation_id: ROW, status: "running",
  created_at: NOW - 30 * MIN, updated_at: NOW - MIN, node_statuses: [], ...over,
});
const trigger = (id: string, pr: number, repository: string, event_type = "pr_merged") => ({
  _id: id, title: `Wake on #${pr}`, originating_conversation_id: ROW, status: "scheduled", schedule_type: "event",
  event_filter: { event_type, pr_number: pr, repository }, created_at: NOW - 60 * MIN,
});

function rowOf(facts: Facts) {
  return {
    _id: ROW, session_id: "s-row", title: "Row", work_state: "dormant", agent_status: "dormant", message_count: 9,
    updated_at: NOW - 5 * MIN, last_heartbeat: NOW - 5_000, thread_state: "Parked", thread_state_status: "dormant",
    armed_trigger_kind: facts.triggers?.length ? "standing" : "none", ...facts.row,
  };
}

/** The server's verdict, as `cast sessions` shows it. */
async function serverSays(facts: Facts) {
  const db = makeFakeDb({
    workflows: WORKFLOWS,
    workflow_runs: facts.runs ?? [],
    agent_tasks: facts.triggers ?? [],
    pull_requests: facts.prs ?? [],
    session_decisions: facts.decisions ?? [],
  } as never);
  const out = await dormantRailActivities({ db }, [rowOf(facts)], NOW, VIEWER);
  return out.get(ROW);
}

/** The web rail's verdict over a store fed the same rows (runs stamped as the run feeds stamp them). */
function webSays(facts: Facts) {
  const source = (wf: string) => WORKFLOWS.find((w) => w._id === wf)?.source;
  const state = {
    sessions: { [ROW]: rowOf(facts) },
    workflowRuns: Object.fromEntries((facts.runs ?? []).map((r: any) => [r._id, { ...r, takes_change: sourceTakesSessionChange(source(r.workflow_id)) }])),
    agentTasks: Object.fromEntries((facts.triggers ?? []).map((t: any) => [t._id, t])),
    pullRequests: Object.fromEntries((facts.prs ?? []).map((p: any) => [p._id, p])),
    sessionDecisions: Object.fromEntries((facts.decisions ?? []).map((d: any) => [d._id, d])),
    currentUser: { _id: VIEWER },
    clientState: { ui: {} },
  };
  const a = rowActivity(state as never, state.sessions[ROW] as never, NOW);
  return { state: a.state, flavor: a.state === "sleeping" ? a.flavor : null, words: sessionActivityWords(a, NOW) };
}

const CASES: Array<[string, Facts, { state: string; words: string }]> = [
  ["an older eval run and a newer change run: the change run speaks", {
    runs: [run("r_eval", "wf_eval", "eval", { created_at: NOW - 60 * MIN }), run("r_change", "wf_change", "change", { current_node_id: "ci", pr: { repository: "acme/app", number: 263 } })],
  }, { state: "shipping", words: "CI running · #263" }],
  ["a live ship run beats a newer run that ships nothing", {
    runs: [run("r_change", "wf_change", "change", { created_at: NOW - 60 * MIN, current_node_id: "merge" }), run("r_eval", "wf_eval", "eval")],
  }, { state: "shipping", words: "Merging" }],
  ["a paused change run at a gate the viewer answers", {
    runs: [run("r_gate", "wf_change", "change", { status: "paused", current_node_id: "decide", gate_decision_id: "dec_1", gate_decision_status: "pending" })],
    decisions: [{ _id: "dec_1", user_id: VIEWER, status: "pending" }],
  }, { state: "shipping", words: "Your call" }],
  ["a flow that takes the change though it is not named change", {
    runs: [run("r_own", "wf_own", "land_built_change", { current_node_id: "land" })],
  }, { state: "shipping", words: "Merging" }],
  ["a project flow that only extends change, on another machine, not parked on it", {
    runs: [run("r_ext", "wf_ext", "change", { current_node_id: "verdicts", runner_device: "other-mac" })],
  }, { state: "shipping", words: "In review" }],
  ["Go live", {
    runs: [run("r_live", "wf_ext", "change", { current_node_id: "deploy__wait", current_node_label: "Go live" })],
  }, { state: "shipping", words: "Checking it's live" }],
  ["a live run that ships nothing", {
    runs: [run("r_build", "wf_build", "build", { current_node_id: "implement" })],
    row: { parked_wake_kind: "run" },
  }, { state: "working", words: "running build" }],
  ["its own merged PR with a standing trigger on it", {
    row: { pr_status: { repository: "acme/app", number: 7, state: "merged" } },
    triggers: [trigger("t_own", 7, "acme/app")],
  }, { state: "sleeping", words: "" }],
  ["someone else's merged PR", {
    triggers: [trigger("t_other", 4351, "union/mobile")],
    prs: [{ _id: "pr_4351", repository: "union/mobile", number: 4351, state: "merged" }],
  }, { state: "sleeping", words: "" }],
  ["someone else's open PR", {
    triggers: [trigger("t_open", 4352, "union/mobile")],
    prs: [{ _id: "pr_4352", repository: "union/mobile", number: 4352, state: "open" }],
  }, { state: "sleeping", words: "waiting on #4352" }],
];

describe("cast sessions and the web rail split a row the same way", () => {
  for (const [name, facts, want] of CASES) {
    test(name, async () => {
      const server = await serverSays(facts);
      const web = webSays(facts);
      expect(server).toEqual(web);
      expect(web.state).toBe(want.state);
      if (want.words) expect(web.words).toBe(want.words);
    });
  }

  test("a trigger on a merged PR is a schedule on both sides, never a wait", async () => {
    for (const facts of [CASES[7][1], CASES[8][1]]) {
      expect((await serverSays(facts))?.flavor).toBe("scheduled");
      expect(webSays(facts).flavor).toBe("scheduled");
    }
  });
});
