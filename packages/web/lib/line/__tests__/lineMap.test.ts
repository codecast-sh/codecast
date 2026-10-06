import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { CAUSES_NODE, SIGNALS_NODE, buildLineMap, endNodeId, runVisits, sourceNodeId, windowLabel, type LineGraph, type MapRun } from "../lineMap";
import * as F from "./lineFixtures";

const { HOUR, DAY } = F;
const map = (over: Partial<Parameters<typeof buildLineMap>[0]> = {}) => buildLineMap({ ...F.rows, finders: F.finders, now: F.NOW, windowMs: 7 * F.DAY, ...over });
const node = (m: ReturnType<typeof buildLineMap>, id: string) => m.nodes.find((x) => x.id === id)!;
const edge = (m: ReturnType<typeof buildLineMap>, from: string, to: string) => m.edges.find((e) => e.from === from && e.to === to)!;

describe("runVisits", () => {
  test("a revise round the run row overwrote comes back between red and reopen", () => {
    const v = runVisits(F.runA, SHIPPED_LINE, F.decisionsA);
    expect(v.map((x) => x.node)).toEqual([
      "ground", "analyze", "prove", "red",
      "implement", "verify", "eval", "review", "card_draft", "card_write", "card", "decide",
      "reopen", "implement", "verify", "eval", "review", "card_draft", "card_write", "card", "decide",
      "ship", "merge", "watch",
    ]);
    // The first round is inferred: no time of its own, dated by the next timed visit.
    const firstImpl = v.find((x) => x.node === "implement")!;
    expect(firstImpl.inferred).toBe(true);
    expect(firstImpl.startedAt).toBeNull();
    expect(firstImpl.at).toBe(F.runA.node_statuses!.find((n) => n.node_id === "reopen")!.started_at!);
    // A category prompt cause goes verify -> eval: the path prefers stations the run reached.
    expect(v.filter((x) => x.node === "green")).toHaveLength(0);
  });

  test("a gate answered with its key is done, not failed", () => {
    const decide = runVisits(F.runA, SHIPPED_LINE, F.decisionsA).filter((x) => x.node === "decide");
    expect(decide.map((x) => x.state)).toEqual(["done", "done"]);
  });

  test("a gate answered more often than the path shows gets its earlier rounds back", () => {
    const t = F.NOW - DAY;
    const run: MapRun = {
      _id: "run_plan", status: "running", task_id: "task_a", workflow_name: "line", current_node_id: "analyze",
      node_statuses: [F.n("ground", t), F.n("plan", t + 3 * F.HOUR, 20), F.n("plan_gate", t + 4 * F.HOUR, 30, "failed", { outcome: "A" }), F.n("analyze", t + 5 * F.HOUR, 0, "running")],
      created_at: t, updated_at: t + 5 * F.HOUR,
    };
    const asked = (id: string, at: number, answer: number) => ({ _id: id, status: "answered", blocking: true, workflow_run_id: "run_plan", gate_node_id: "plan_gate", created_at: at, options: [{ label: "Approve" }, { label: "Revise" }, { label: "Drop" }], answer_index: answer });
    const v = runVisits(run, SHIPPED_LINE, [asked("d1", t + HOUR, 1), asked("d2", t + 4 * F.HOUR, 0)]);
    expect(v.map((x) => `${x.node}${x.inferred ? "*" : ""}`)).toEqual(["ground", "plan", "plan_gate*", "plan*", "plan_gate", "analyze"]);
    expect(v[v.length - 1].state).toBe("live");
  });

  test("a live run whose current station has no status yet is at that station", () => {
    const run: MapRun = { ...F.runC, node_statuses: F.runC.node_statuses!.filter((n) => n.node_id !== "implement") };
    const v = runVisits(run, SHIPPED_LINE);
    expect(v[v.length - 1]).toMatchObject({ node: "implement", inferred: false });
  });
});

describe("buildLineMap: nodes from the definition", () => {
  const m = map();

  test("sources: each declared finder, plus a source that files without a declaration", () => {
    const sources = m.nodes.filter((n) => n.kind === "source");
    expect(sources.map((s) => s.id).sort()).toEqual(["source:agentwatch", "source:chat", "source:ci"]);
    expect(node(m, "source:agentwatch").finder?.id).toBe("agentwatch-judge");
    expect(node(m, "source:ci").finder).toBeUndefined();
    expect(node(m, "source:ci").marks).toEqual([{ level: "info", words: "Files signals, but the profile does not declare it" }]);
  });

  test("expectations feed the finders that judge behavior", () => {
    expect(node(m, "expectations").kind).toBe("expectations");
    expect(edge(m, "expectations", "source:agentwatch").count).toBe(2);
    expect(m.edges.some((e) => e.from === "expectations" && e.to === "source:ci")).toBe(false);
  });

  test("every station of the line, in order, then the ends", () => {
    const ids = m.nodes.map((n) => n.id);
    const stations = SHIPPED_LINE.nodes.filter((n) => n.type !== "start" && n.type !== "exit").map((n) => n.id);
    for (const s of stations) expect(ids).toContain(s);
    const at = (id: string) => node(m, id).col;
    expect(at(SIGNALS_NODE)).toBeLessThan(at(CAUSES_NODE));
    for (const [a, b] of [["ground", "analyze"], ["analyze", "prove"], ["prove", "red"], ["red", "implement"], ["implement", "verify"], ["review", "card_draft"], ["card", "decide"], ["decide", "ship"], ["ship", "merge"], ["merge", "watch"], ["watch", "end:held"]]) {
      expect(at(a)).toBeLessThan(at(b));
    }
    // The node list itself reads left to right.
    const cols = m.nodes.map((n) => n.col);
    expect([...cols].sort((a, b) => a - b)).toEqual(cols);
    expect(m.nodes.filter((n) => n.kind === "end").map((n) => n.end).sort()).toEqual(["dissolved", "dropped", "held", "reopened", "stopped"]);
  });

  test("kinds and phases", () => {
    expect(node(m, "decide").kind).toBe("decide");
    expect(node(m, "ship").kind).toBe("ship");
    expect(node(m, "watch").kind).toBe("watch");
    expect(node(m, "prove")).toMatchObject({ kind: "station", phase: "prove" });
    expect(node(m, CAUSES_NODE).phase).toBe("admit");
    expect(node(m, "end:held").phase).toBe("end");
  });

  test("branches draw as branches, loops as loops", () => {
    // The card's assembly is on every cause's path; plan, dissolve and reopen are not.
    for (const id of ["ground", "card_draft", "card_write", "card", "decide", "watch"]) expect(node(m, id).main).toBe(true);
    for (const id of ["plan", "plan_gate", "park", "dissolve", "reopen", "drop", "unscored"]) expect(node(m, id).main).toBe(false);
    expect(edge(m, "prove", "dissolve").kind).toBe("branch");
    expect(edge(m, "reopen", "implement").kind).toBe("loop");
    expect(edge(m, "verify", "implement")).toMatchObject({ kind: "loop", label: "checks failed" });
    expect(edge(m, "plan_gate", "plan")).toMatchObject({ kind: "loop", label: "Revise" });
    expect(edge(m, "review", "card_draft").kind).toBe("flow");
    // Park sends a cause back to the queue.
    expect(edge(m, "park", CAUSES_NODE).kind).toBe("loop");
    expect(edge(m, "dissolve", endNodeId("dissolved")).kind).toBe("branch");
    expect(edge(m, "drop", endNodeId("dropped"))).toBeTruthy();
    expect(edge(m, "unscored", endNodeId("stopped"))).toBeTruthy();
  });

  test("a customized line draws as customized", () => {
    const graph: LineGraph = {
      nodes: [...SHIPPED_LINE.nodes, { id: "lint", label: "Lint", type: "command" }],
      edges: SHIPPED_LINE.edges.flatMap((e) => (e.from === "verify" && e.to === "green" ? [{ from: "verify", to: "lint" }, { from: "lint", to: "green" }] : [e])),
    };
    const custom = map({ graph });
    expect(node(custom, "lint")).toMatchObject({ label: "Lint", kind: "station", main: true });
    expect(node(custom, "lint").col).toBeGreaterThan(node(custom, "verify").col);
    expect(node(custom, "lint").col).toBeLessThan(node(custom, "green").col);
  });
});

describe("buildLineMap: the data over a window", () => {
  const m = map();

  test("signals: source -> signals -> causes, one crossing per signal in the window", () => {
    expect(edge(m, "source:agentwatch", SIGNALS_NODE).count).toBe(3);
    expect(edge(m, "source:ci", SIGNALS_NODE).count).toBe(3);
    expect(edge(m, "source:chat", SIGNALS_NODE).count).toBe(2);
    expect(edge(m, SIGNALS_NODE, CAUSES_NODE).count).toBe(8);
    expect(node(m, SIGNALS_NODE).through).toBe(8);
    expect(edge(m, SIGNALS_NODE, CAUSES_NODE).items[0]).toMatchObject({ kind: "signal", ref: expect.stringMatching(/^sg-/) });
  });

  test("the queue now is the open causes /line ranks", () => {
    expect(node(m, CAUSES_NODE).now.map((i) => i.ref).sort()).toEqual(["ct-104", "ct-105"]);
    expect(node(m, CAUSES_NODE).through).toBe(5);
  });

  test("a loop counts again: two rounds through implement and decide", () => {
    // run A twice, run F once; run C entered implement and is there now.
    expect(edge(m, "implement", "verify").count).toBe(3);
    expect(edge(m, "red", "implement").count).toBe(3);
    expect(node(m, "decide").through).toBe(3);
    expect(edge(m, "decide", "reopen")).toMatchObject({ count: 1, label: "Revise" });
    expect(edge(m, "reopen", "implement").count).toBe(1);
    expect(edge(m, "decide", "ship").count).toBe(2);
    // One item per run on an edge, however often it crossed.
    expect(edge(m, "implement", "verify").items.map((i) => i.runId).sort()).toEqual(["run_a", "run_f"]);
  });

  test("ends: dissolved, held, reopened", () => {
    expect(edge(m, "prove", "dissolve").count).toBe(1);
    expect(edge(m, "dissolve", endNodeId("dissolved")).count).toBe(1);
    expect(node(m, endNodeId("dissolved")).through).toBe(1);
    expect(edge(m, "watch", endNodeId("held"))).toMatchObject({ count: 1, items: [expect.objectContaining({ ref: "ct-101" })] });
    expect(edge(m, "watch", endNodeId("reopened"))).toMatchObject({ count: 1, items: [expect.objectContaining({ ref: "ct-106" })] });
  });

  test("now: a run at its station, a cause in its watch", () => {
    expect(node(m, "implement").now).toEqual([expect.objectContaining({ kind: "run", runId: "run_c", ref: "run_c", title: "Call summary drops the action items" })]);
    expect(node(m, "watch").now.map((i) => i.ref)).toEqual(["ct-106"]);
  });

  test("through: how each visit left and how long it stayed", () => {
    const red = node(m, "red").passed.find((p) => p.item.runId === "run_c")!;
    expect(red).toMatchObject({ left: "moved", to: "implement", durationMs: 5 * F.MIN });
    expect(node(m, "implement").passed.find((p) => p.item.runId === "run_c")).toMatchObject({ left: "live", to: null });
    expect(node(m, "dissolve").passed[0]).toMatchObject({ left: "dissolved", to: endNodeId("dissolved") });
    // Newest first.
    const at = node(m, "prove").passed.map((p) => p.at);
    expect([...at].sort((a, b) => b - a)).toEqual(at);
  });

  test("a narrower window counts less, and now does not depend on it", () => {
    const day = map({ windowMs: DAY });
    // C and E arrived today, and F's reopening signal exactly a day ago (the window includes its edge).
    expect(edge(day, SIGNALS_NODE, CAUSES_NODE).count).toBe(3);
    expect(edge(day, "implement", "verify").count).toBe(0);
    expect(node(day, "implement").now).toHaveLength(1);
    expect(day.window).toEqual({ from: F.NOW - DAY, to: F.NOW, label: "24h" });
  });
});

describe("buildLineMap: marks in words", () => {
  test("stuck: a run past three times the station's usual time", () => {
    const m = map();
    const impl = node(m, "implement");
    expect(impl.medianMs).toBe(40 * F.MIN);
    expect(impl.now[0].stuck).toBe(true);
    expect(impl.marks).toContainEqual({ level: "warn", words: "1 run here past three times the usual 40m" });
  });

  test("not stuck without enough finished visits to know the usual time", () => {
    const m = map({ runs: [F.runA, F.runB, F.runC, F.runF] });
    expect(node(m, "implement").marks.some((x) => /usual/.test(x.words))).toBe(false);
  });

  test("failure share over the window", () => {
    const m = map({ windowMs: 30 * DAY });
    expect(node(m, "verify")).toMatchObject({ failed: 2 });
    expect(node(m, "verify").marks).toContainEqual({ level: "warn", words: `2 of ${node(m, "verify").through} failed in the last 30d` });
    expect(edge(m, "verify", endNodeId("stopped")).count).toBe(2);
    expect(node(m, endNodeId("stopped")).through).toBe(2);
  });

  test("a silent finder says so", () => {
    const m = map({ signals: F.rows.signals.filter((s) => s.source !== "chat") });
    expect(node(m, "source:chat").through).toBe(0);
    expect(node(m, "source:chat").marks[0]).toMatchObject({ level: "warn", words: expect.stringMatching(/^Silent: nothing filed in/) });
  });

  test("a run silent for a day", () => {
    const m = map({ runs: [{ ...F.runC, updated_at: F.NOW - 2 * DAY }] });
    expect(node(m, "implement").marks).toContainEqual({ level: "warn", words: "1 run silent for a day" });
  });

  test("admission paused behind open cards", () => {
    const cards = [1, 2, 3].map((i) => ({ _id: `card${i}`, status: "pending", blocking: true, workflow_run_id: `r${i}`, gate_node_id: "decide", created_at: F.NOW - i * HOUR }));
    const m = map({ decisions: cards, cardsCap: 3 });
    expect(node(m, CAUSES_NODE).marks[0]).toMatchObject({ level: "warn", words: "Admission paused: queued behind 3 open cards" });
  });
});

describe("windowLabel", () => {
  test("names the switch's windows, else the largest unit", () => {
    expect(windowLabel(DAY)).toBe("24h");
    expect(windowLabel(7 * DAY)).toBe("7d");
    expect(windowLabel(30 * DAY)).toBe("30d");
    expect(windowLabel(3 * DAY)).toBe("3d");
  });
});

test("an empty line still draws its whole graph", () => {
  const m = buildLineMap({ signals: [], tasks: [], runs: [], decisions: [], now: F.NOW, windowMs: 7 * DAY });
  expect(m.nodes.find((n) => n.id === "ground")).toBeTruthy();
  expect(m.nodes.some((n) => n.kind === "source")).toBe(false);
  expect(m.edges.every((e) => e.count === 0)).toBe(true);
  expect(sourceNodeId("AgentWatch")).toBe("source:agentwatch");
});
