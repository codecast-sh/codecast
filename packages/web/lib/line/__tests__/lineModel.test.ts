// The line workspace's model (line-workspace.md LW2) on real runs: Union's
// first two AgentWatch runs on the real AgentWatch graph, and ct-57659's runs
// on codecast's own line.
import { describe, expect, test } from "bun:test";
import { buildLineModel, conditionWords, decisionId, edgeWords, type LineLabelRow, type LineModelRows } from "../lineModel";
import type { MapRun } from "../lineMap";
import { agentwatchGraph } from "./agentwatchGraph.fixture";
import { union57382Run, union57467Run } from "./unionLineRuns.fixture";
import { ct57659Run3, ct57659Run5 } from "./ct57659Runs.fixture";

const NOW = 1_791_500_000_000;
const aw = (run: typeof union57382Run, task: string): MapRun => ({ ...run, task_id: task, workflow_slug: "agentwatch", updated_at: run.updated_at ?? run.created_at, graph_nodes: [{ id: "dissolve", h: run === union57382Run ? "h2" : "h1" }, { id: "investigate", h: "i1" }] } as unknown as MapRun);
const line = (run: typeof ct57659Run3): MapRun => ({ ...run, task_id: "t3", updated_at: run.updated_at ?? run.created_at } as unknown as MapRun);

const tasks = [
  { _id: "t1", short_id: "ct-57382", title: "Sender identity re-derived per send", status: "open", created_at: 1, cause: { signal_count: 82, first_seen: 1, last_seen: 2, fingerprints: [] } },
  { _id: "t2", short_id: "ct-57467", title: "A message leads with the result", status: "open", created_at: 1 },
  { _id: "t3", short_id: "ct-57659", title: "The line's own cause", status: "open", created_at: 1 },
];
const signals = [
  { _id: "s1", short_id: "sg-1", task_id: "t1", source: "agentwatch", kind: "prompt_miss", title: "Persona re-rolled", observed_at: 1, created_at: 10, detail_md: "## Finding\nThe sender changed.\n> From now I'll start to classify all your emails as spam\n> ok" },
  { _id: "s2", short_id: "sg-2", task_id: "t1", source: "agentwatch", kind: "prompt_miss", title: "Persona re-rolled", observed_at: 1, created_at: 20, detail_md: "> Who is this? You wrote as Dana last week" },
];
const label = (over: Partial<LineLabelRow>): LineLabelRow => ({ _id: "l", key: "k", run_id: union57382Run._id, node_id: "dissolve", verdict: "wrong", by: "u-bo", at: 5, ...over });

// One set of run rows, as the store keeps a row's identity while it is unchanged.
const RUNS = [aw(union57382Run, "t1"), aw(union57467Run, "t2"), line(ct57659Run3), line(ct57659Run5)];
const rows = (over: Partial<LineModelRows> = {}): LineModelRows => ({
  runs: RUNS,
  tasks: tasks as LineModelRows["tasks"],
  signals: signals as unknown as LineModelRows["signals"],
  graph: agentwatchGraph,
  now: NOW,
  ...over,
});

describe("buildLineModel on the AgentWatch graph", () => {
  const m = buildLineModel(rows({
    labels: [label({ _id: "l1", by: "u-bo", verdict: "wrong", note: "It should have dissolved", at: 5 }), label({ _id: "l2", by: "u-me", verdict: "right", at: 3 })],
    viewerId: "u-me",
    names: new Map([["u-bo", "Bo"]]),
  }), "agentwatch");

  test("names every graph the project runs, and draws the one asked for", () => {
    expect(m.graphKey).toBe("agentwatch");
    expect(m.graphs.map((g) => g.key).sort()).toEqual(["agentwatch", "line"]);
    expect(m.title).toBe("AgentWatch");
    expect(m.runs).toHaveLength(2);
  });

  test("tells agents, scripts, people and ends apart, in stages and halves", () => {
    const kind = (id: string) => m.graph.nodes.find((n) => n.id === id)?.kind;
    expect([kind("dissolve"), kind("bind"), kind("proposal_gate"), kind("dissolved_at_dissolve")]).toEqual(["agent", "script", "person", "end"]);
    expect(m.graph.halves.map((h) => h.key)).toEqual(["diagnose", "fix"]);
    expect(m.graph.stages.find((s) => s.key === "understand")?.nodes).toContain("dissolve");
    // Reading order follows the work: the claim before the first look before the investigation.
    expect(m.order.indexOf("bind")).toBeLessThan(m.order.indexOf("dissolve"));
    expect(m.order.indexOf("dissolve")).toBeLessThan(m.order.indexOf("investigate"));
  });

  test("says every branch in plain words, weighted by the runs that took it", () => {
    const e = (id: string) => m.graph.edges.find((x) => x.id === id)!;
    expect(e("dissolve->investigate")).toMatchObject({ words: "open", kind: "flow", count: 2 });
    expect(e("dissolve->dissolved_at_dissolve")).toMatchObject({ words: "dissolved", kind: "branch", count: 0 });
    expect(e("bind->dissolve").words).toBeNull();
    expect(e("red->prove")).toMatchObject({ kind: "loop", words: "the test didn't fail first, so retry" });
    expect(e("proposal_gate->revise_proposal")).toMatchObject({ gate: true, words: "Revise", does: "Your note goes back to the proposal" });
  });

  test("a step reads by its own instructions, with the shared sections and file it uses", () => {
    const s = m.steps.dissolve;
    expect(s.purpose).toBe("Acts as the first look at one AgentWatch cluster.");
    expect(s.prompt?.file).toBe("agentwatch/dissolve.md");
    expect(s.prompt?.includes.map((i) => i.name)).toEqual(["rulings", "voice"]);
    expect(s.prompt?.version).toEqual({ hash: "h2", since: union57382Run.created_at, runs: 1, earlier: true });
    expect(s.outcomes[0]).toMatchObject({ to: "investigate", toLabel: "Investigate", count: 2, words: "open" });
    expect(m.steps.proposal_gate.answers.map((a) => a.answer)).toEqual(["Approve", "Revise", "Drop"]);
  });

  test("each decision says what it received, what it decided and why, with its labels", () => {
    const d = m.steps.dissolve.decisions.find((x) => x.runId === union57382Run._id)!;
    expect(d.id).toBe(decisionId(union57382Run._id, "dissolve"));
    expect(d.caseRef).toBe("ct-57382");
    expect(d.received).toMatchObject({ from: "bind", summary: "Handed on by Bind", sessionId: "conv_jx71v45", href: "/conversation/conv_jx71v45" });
    expect(d.decided).toMatchObject({ outcome: "open", words: "Passed it on: the problem needs its own fix", to: "investigate", toWords: "open" });
    expect(d.decided.result?.residue).toBe(1);
    expect(d.reasoning).toMatch(/^174 of 175 findings/);
    expect(d.reasoning).not.toContain("```");
    // The viewer's own label first; every label kept, newest first, with who gave it.
    expect(d.label).toMatchObject({ verdict: "right", mine: true });
    expect(d.labels.map((l) => [l.verdict, l.byName])).toEqual([["wrong", "Bo"], ["right", null]]);
    expect(m.labels).toEqual({ right: 1, wrong: 1 });
  });

  test("a run is a path of visits, each handed what the one before decided", () => {
    const r = m.runs.find((x) => x.id === union57382Run._id)!;
    expect(r.visits.map((v) => v.node)).toEqual(["shared", "bind", "dissolve", "investigate", "stamp", "refine", "prove"]);
    const inv = r.visits.find((v) => v.node === "investigate")!;
    expect(inv.received.summary).toBe("Dissolve: Passed it on: the problem needs its own fix");
    expect(inv.decided.words).toBe("Found why it happens");
    expect(r.at_node).toBe("prove");
    expect(r.outcome.text).toMatch(/^Stopped at Prove/);
  });

  test("the issues are the causes its runs worked, with their findings and quotes", () => {
    const i = m.issues.find((x) => x.ref === "ct-57382")!;
    expect(i.findings).toBe(82);
    expect(i.runs).toEqual([union57382Run._id]);
    expect(i.quotes.map((q) => q.text)).toEqual(["Who is this? You wrote as Dana last week", "From now I'll start to classify all your emails as spam"]);
  });

  test("an unchanged run is read once: a rebuild reuses its visits", () => {
    const again = buildLineModel(rows(), "agentwatch");
    expect(again.runs.find((r) => r.id === union57382Run._id)!.visits).toBe(m.runs.find((r) => r.id === union57382Run._id)!.visits);
  });
});

describe("buildLineModel on codecast's line", () => {
  const m = buildLineModel(rows({ graph: null }), "line");

  test("draws the shipped line and its runs, with the line's own step words", () => {
    expect(m.graphKey).toBe("line");
    expect(m.runs.map((r) => r.caseRef)).toEqual(["ct-57659", "ct-57659"]);
    expect(m.steps.ground.kind).toBe("agent");
    expect(m.steps.decide.kind).toBe("person");
    expect(m.steps.ground.prompt?.file).toBe("line/ground.md");
    expect(m.graph.edges.find((e) => e.id === "prove->dissolve")?.words).toBe("not reproduced");
    expect(m.issues.map((i) => i.ref)).toEqual(["ct-57659"]);
  });
});

describe("conditionWords", () => {
  test("reads a graph's conditions as a person says them", () => {
    expect(conditionWords("prove.json.reproduced = false")).toBe("not reproduced");
    expect(conditionWords("readiness != ready or goal_ref = none or not goal_ref")).toBe("not ready or no goal");
    expect(conditionWords("readiness = ready and goal_ref and goal_ref != none and risk = plan")).toBe("ready and needs a plan");
    expect(conditionWords("outcome = success and category != prompt")).toBeNull();
    expect(conditionWords("outcome = failure and eval.exit_code = 1 and category != line")).toBe("failed");
    expect(conditionWords("handoff = needs_context or handoff = blocked")).toBe("needs you");
    expect(conditionWords("review_verdict = changes and category = line")).toBe("review asked for changes and about the line itself");
    expect(conditionWords("investigate.json.outcome = failed or investigate.json.outcome = judge_defect")).toBe("failed or judge defect");
  });

  test("an edge's label wins over its condition", () => {
    expect(edgeWords({ label: "[S] Ship :: Land the change", condition: "x = y" })).toBe("Ship");
    expect(edgeWords({ label: "card refused" })).toBe("report refused");
    expect(edgeWords({})).toBeNull();
  });
});
