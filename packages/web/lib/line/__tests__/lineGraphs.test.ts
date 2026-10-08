import { describe, expect, test } from "bun:test";
import { CAUSES_NODE, buildLineMap, endNodeId, type LineGraph, type MapRun } from "../lineMap";
import { foundBy, graphForMap, graphFromIds, graphKeyOf, guessPhase, pickGraph, projectGraphs, stationPurpose, stationWho, terminalSteps, type GraphRun } from "../lineGraphs";
import * as F from "./lineFixtures";

const { DAY, HOUR } = F;

// A small graph shaped like a repo's own line (Union's AgentWatch): its own
// station ids, script steps, two person gates, and terminal steps that record
// how a run ended. Synthetic, so no real prompt text enters the repo.
const nodes = [
  { id: "start", label: "Start", type: "start", shape: "Mdiamond" },
  { id: "exit", label: "Exit", type: "exit", shape: "Msquare" },
  { id: "bind", label: "Bind", type: "command", shape: "parallelogram", script: "bun line.ts bind" },
  { id: "investigate", label: "Investigate", type: "agent", shape: "box", prompt: "You find the mechanism behind one cluster.\n\nRead the members first." },
  { id: "propose", label: "Propose", type: "agent", shape: "box", prompt: "You write the fix strategy for one proven cause." },
  { id: "proposal_gate", label: "Proposal", type: "human", shape: "hexagon", prompt: "$propose.json.question" },
  { id: "build", label: "Build", type: "agent", shape: "box", prompt: "You build the fix a person approved." },
  { id: "review", label: "Review", type: "agent", shape: "box", prompt: "You are the independent reviewer of one fix." },
  { id: "decide", label: "Decide", type: "human", shape: "hexagon", prompt: "Ship the fix?" },
  { id: "ship", label: "Ship", type: "command", shape: "parallelogram", script: "bun line.ts rule ship" },
  { id: "drop", label: "Drop", type: "command", shape: "parallelogram", script: "bun line.ts rule drop" },
  { id: "watch", label: "Watch", type: "command", shape: "parallelogram", script: "watch 7d" },
  { id: "dissolved_at_investigate", label: "Dissolved", type: "command", shape: "parallelogram", script: "finish dissolved" },
  { id: "failed_at_build", label: "Failed", type: "command", shape: "parallelogram", script: "finish failed" },
];
const edges = [
  { from: "start", to: "bind" },
  { from: "bind", to: "investigate" },
  { from: "investigate", to: "propose" },
  { from: "investigate", to: "dissolved_at_investigate" },
  { from: "propose", to: "proposal_gate" },
  { from: "proposal_gate", to: "build", label: "[A] Approve :: Build this strategy" },
  { from: "proposal_gate", to: "propose", label: "[R] Revise :: Your note goes back" },
  { from: "proposal_gate", to: "drop", label: "[D] Drop :: Nothing is built" },
  { from: "build", to: "review" },
  { from: "build", to: "failed_at_build" },
  { from: "review", to: "decide" },
  { from: "decide", to: "ship", label: "[S] Ship :: Approve the fix" },
  { from: "decide", to: "build", label: "[R] Revise :: Your note goes back" },
  { from: "decide", to: "drop", label: "[D] Drop :: Not wanted" },
  { from: "ship", to: "watch" },
  { from: "watch", to: "exit" },
  { from: "drop", to: "exit" },
  { from: "dissolved_at_investigate", to: "exit" },
  { from: "failed_at_build", to: "exit" },
];

const run = (id: string, over: Partial<GraphRun> = {}): GraphRun => ({ _id: id, status: "completed", created_at: F.NOW - DAY, updated_at: F.NOW - DAY, ...over });

describe("projectGraphs", () => {
  test("groups a project's runs by the graph each ran, busiest first, named by the work it carries", () => {
    const runs = [
      run("r1", { task_id: "t1", workflow_slug: "agentwatch", workflow_id: "w_aw", updated_at: F.NOW - HOUR }),
      run("r2", { task_id: "t2", workflow_slug: "agentwatch", workflow_id: "w_aw", graph_nodes: [{ id: "bind", h: "a" }] }),
      run("r3", { task_id: "t3", workflow_name: "line", status: "running" }),
    ];
    const signals = [{ task_id: "t1", source: "agentwatch" }, { task_id: "t2", source: "agentwatch" }, { task_id: "t2", source: "union.eval" }, { task_id: "t3", source: "person" }];
    const g = projectGraphs(runs, signals);
    expect(g.map((x) => x.key)).toEqual(["agentwatch", "line"]);
    expect(g[0]).toMatchObject({ title: "Agentwatch", runs: 2, problems: 2, runId: "r1", workflowId: "w_aw", nodeIds: ["bind"], work: "2 problems, found by agentwatch and union.eval" });
    expect(g[1]).toMatchObject({ title: "Codecast's line", live: 1, workflowId: null, work: "1 problem, filed by people" });
  });

  test("the graph the URL names wins when the project runs it, else the busiest", () => {
    const g = projectGraphs([run("a", { workflow_slug: "agentwatch" }), run("b", { workflow_slug: "agentwatch" }), run("c")]);
    expect(pickGraph(g, "line")).toBe("line");
    expect(pickGraph(g, "nope")).toBe("agentwatch");
    expect(pickGraph([], null)).toBe("line");
  });

  test("a run with no slug falls back to its name, and to codecast's line", () => {
    expect(graphKeyOf({ workflow_name: "AgentWatch" })).toBe("agentwatch");
    expect(graphKeyOf({})).toBe("line");
  });

  test("found by: busiest source first, people for a person", () => {
    expect(foundBy(new Map([["a", 1], ["b", 5], ["c", 2], ["d", 1]]))).toBe("found by b, c and 2 more");
    expect(foundBy(new Map())).toBeNull();
  });
});

describe("a foreign graph on the map", () => {
  test("terminal steps are ends with their meaning; watch and drop keep their stations", () => {
    const t = terminalSteps(nodes, edges);
    expect(Object.fromEntries(t)).toEqual({ drop: "dropped", watch: "shipped", dissolved_at_investigate: "dissolved", failed_at_build: "stopped" });
    const g = graphForMap(nodes, edges);
    expect(g.ends).toEqual({ dissolved_at_investigate: "dissolved", failed_at_build: "stopped" });
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.phase]))).toMatchObject({ bind: "understand", investigate: "understand", propose: "build", build: "build", review: "check", decide: "decide", ship: "ship" });
  });

  const graph = graphForMap(nodes, edges) as LineGraph;
  const t0 = F.NOW - 2 * DAY;
  const awRun = (id: string, statuses: MapRun["node_statuses"], status = "completed"): MapRun => ({
    _id: id, status, task_id: `task_${id}`, workflow_name: "agentwatch", node_statuses: statuses, created_at: t0, updated_at: t0 + 10 * HOUR,
  } as MapRun);
  const tasks = ["d", "s", "l"].map((id) => ({ _id: `task_${id}`, title: `Problem ${id}`, status: "open", created_at: t0, cause: { signal_count: 1, first_seen: t0, last_seen: t0, fingerprints: [] } }));
  const m = buildLineMap({
    graph, signals: [], tasks, decisions: [], now: F.NOW, windowMs: 7 * DAY,
    runs: [
      awRun("d", [F.n("bind", t0), F.n("investigate", t0 + HOUR), F.n("dissolved_at_investigate", t0 + 2 * HOUR)]),
      awRun("s", [F.n("bind", t0), F.n("investigate", t0 + HOUR), F.n("propose", t0 + 2 * HOUR), F.n("proposal_gate", t0 + 3 * HOUR), F.n("build", t0 + 4 * HOUR), F.n("review", t0 + 5 * HOUR), F.n("decide", t0 + 6 * HOUR), F.n("ship", t0 + 7 * HOUR), F.n("watch", t0 + 8 * HOUR)]),
      awRun("l", [F.n("bind", t0), F.n("investigate", t0 + HOUR), F.n("propose", t0 + 2 * HOUR), F.n("proposal_gate", t0 + 3 * HOUR, 0, "running")], "paused"),
    ],
  });
  const node = (id: string) => m.nodes.find((x) => x.id === id);

  test("draws the graph's own stations, without its terminal steps", () => {
    expect(node("investigate")?.kind).toBe("station");
    expect(node("dissolved_at_investigate")).toBeUndefined();
    expect(node("ground")).toBeUndefined();
    expect(m.edges.some((e) => e.from === "investigate" && e.to === endNodeId("dissolved"))).toBe(true);
    expect(m.edges.some((e) => e.from === "build" && e.to === endNodeId("stopped"))).toBe(true);
    expect(m.edges.some((e) => e.from === CAUSES_NODE && e.to === "bind")).toBe(true);
  });

  test("marks who does each station; the two gates are a person's", () => {
    expect(node("proposal_gate")?.who).toBe("person");
    expect(node("decide")?.who).toBe("person");
    expect(node("bind")?.who).toBe("script");
    expect(node("investigate")?.who).toBe("agent");
  });

  test("a run that ended at a terminal step lands on the end it means", () => {
    const dissolved = node("investigate")!.passed.find((p) => p.item.runId === "d")!;
    expect(dissolved).toMatchObject({ left: "dissolved", to: endNodeId("dissolved") });
    expect(node(endNodeId("dissolved"))!.through).toBe(1);
    // The shipped run is watched, not stopped; the live one waits on a person at the proposal.
    expect(node(endNodeId("stopped"))?.through ?? 0).toBe(0);
    expect(node("proposal_gate")!.now.map((i) => i.runId)).toEqual(["l"]);
  });
});

describe("what a station is for", () => {
  test("a person gate names the answers it takes", () => {
    expect(stationPurpose(nodes[5], edges)).toBe("You read the proposed fix before anything is built, then decide: Approve, Revise or Drop.");
    expect(stationPurpose(nodes[8], edges)).toBe("You read the finished change and its proof, then decide: Ship, Revise or Drop.");
  });

  test("an agent's comes from its instructions, in the third person, unless the line already says it", () => {
    expect(stationPurpose({ id: "x", type: "agent", prompt: "You find the mechanism behind one cluster.\n\nMore." })).toBe("Finds the mechanism behind one cluster.");
    expect(stationPurpose({ id: "x", type: "agent", prompt: "You are the independent reviewer of one fix." })).toBe("Acts as the independent reviewer of one fix.");
    expect(stationPurpose(nodes[3], edges)).toBe("Finds the real mechanism behind the problem.");
  });

  test("a script with nothing known says what step it runs", () => {
    expect(stationPurpose({ id: "tidy_up", label: "Tidy up", type: "command", shape: "parallelogram" })).toBe("A script runs the tidy up step.");
    expect(stationWho({ id: "tidy_up", type: "command" })).toBe("script");
  });

  test("a phase for a station codecast's line does not name", () => {
    expect(guessPhase("eval_scope")).toBe("check");
    expect(guessPhase("ground")).toBe("understand");
    expect(guessPhase("merge")).toBe("ship");
  });

  test("a graph known only from recorded ids is a chain", () => {
    const g = graphFromIds(["start", "bind", "build"]);
    expect(g.edges).toEqual([{ from: "start", to: "bind" }, { from: "bind", to: "build" }, { from: "build", to: "exit" }]);
    expect(g.nodes.find((n) => n.id === "bind")?.label).toBe("Bind");
  });
});
