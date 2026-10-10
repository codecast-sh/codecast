import { describe, expect, test } from "bun:test";
import { runVisits, type LineGraph, type MapRun } from "../lineMap";
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
    expect(g[0]).toMatchObject({ title: "Agentwatch", runs: 2, causes: 2, runId: "r1", workflowId: "w_aw", nodeIds: ["bind"], work: "2 problems, found by agentwatch and union.eval" });
    expect(g[1]).toMatchObject({ title: "Codecast's line", live: 1, workflowId: null, work: "1 problem, filed by people" });
  });

  test("given the queue, each waiting cause counts once, on the graph its newest run ran, so the graphs sum to the waiting ones that ran", () => {
    const runs = [
      run("r1", { task_id: "t1", workflow_slug: "agentwatch", updated_at: F.NOW - 2 * HOUR }),
      run("r2", { task_id: "t1", workflow_name: "line", updated_at: F.NOW - HOUR }),
      run("r3", { task_id: "t2", workflow_slug: "agentwatch" }),
      run("r4", { task_id: "t3", workflow_slug: "agentwatch" }),
    ];
    const g = projectGraphs(runs, [], undefined, new Set(["t1", "t2", "t9"]));
    expect(Object.fromEntries(g.map((x) => [x.key, x.waiting]))).toEqual({ agentwatch: 1, line: 1 });
    expect(g.find((x) => x.key === "agentwatch")?.work).toBe("1 waiting");
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

describe("a foreign graph", () => {
  test("terminal steps are ends with their meaning; watch and drop keep their stations", () => {
    const t = terminalSteps(nodes, edges);
    expect(Object.fromEntries(t)).toEqual({ drop: "dropped", watch: "shipped", dissolved_at_investigate: "dissolved", failed_at_build: "stopped" });
    const g = graphForMap(nodes, edges);
    expect(g.ends).toEqual({ dissolved_at_investigate: "dissolved", failed_at_build: "stopped" });
    expect(Object.fromEntries(g.nodes.map((n) => [n.id, n.phase]))).toMatchObject({ bind: "understand", investigate: "understand", propose: "build", build: "build", review: "check", decide: "decide", ship: "ship" });
  });

  test("marks who does each station; the two gates are a person's", () => {
    const who = (id: string) => stationWho(nodes.find((n) => n.id === id)!);
    expect(who("proposal_gate")).toBe("person");
    expect(who("decide")).toBe("person");
    expect(who("bind")).toBe("script");
    expect(who("investigate")).toBe("agent");
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
    expect(guessPhase("shared", "Shared text", true)).toBe("understand");
    expect(guessPhase("dissolve", "Dissolve", true)).toBe("understand");
    expect(guessPhase("merge")).toBe("ship");
  });

  test("a graph known only from recorded ids is a chain", () => {
    const g = graphFromIds(["start", "bind", "build"]);
    expect(g.edges).toEqual([{ from: "start", to: "bind" }, { from: "bind", to: "build" }, { from: "build", to: "exit" }]);
    expect(g.nodes.find((n) => n.id === "bind")?.label).toBe("Bind");
  });
});

describe("a station's text in words", () => {
  test("template references read as what they are", async () => {
    const { readableTemplate, gateAnswers } = await import("../lineGraphs");
    expect(readableTemplate("$propose.json.question\n\nShip $task_title? $human_message, as $propose.json.why says", nodes)).toBe("> **Inserted when it runs:** the question text from the [Propose](#station-propose) step.\n\nShip *(the problem's title)*? *(your note)*, as *(the why from [Propose](#station-propose))* says");
    expect(gateAnswers("decide", edges)).toEqual([{ answer: "Ship", does: "Approve the fix" }, { answer: "Revise", does: "Your note goes back" }, { answer: "Drop", does: "Not wanted" }]);
  });

  test("a person's step answered with a key is no failure", () => {
    const g = graphForMap(nodes, edges) as LineGraph;
    const t = F.NOW - DAY;
    const r = { _id: "k", status: "completed", task_id: "task_k", workflow_name: "agentwatch", created_at: t, updated_at: t + 5 * HOUR,
      node_statuses: [F.n("bind", t), F.n("investigate", t + HOUR), F.n("propose", t + 2 * HOUR), F.n("proposal_gate", t + 3 * HOUR, 5, "failed", { outcome: "D" }), F.n("drop", t + 4 * HOUR)] } as MapRun;
    expect(runVisits(r, g).find((v) => v.node === "proposal_gate")?.state).toBe("done");
  });
});
