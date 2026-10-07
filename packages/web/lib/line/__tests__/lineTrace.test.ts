import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { buildLineMap } from "../lineMap";
import { buildLineTrace, decisionAnswer, replacedWords, resolveTraceRef, traceBlocks, tracePathChips, tracePathSummary, type TraceRows } from "../lineTrace";
import { isRoutineStation } from "../runReport";
const HOUR_MS = 3_600_000;
import * as F from "./lineFixtures";

const rows: TraceRows = F.rows;
const trace = (ref: string, over: Partial<TraceRows> = {}) => {
  const r = { ...rows, ...over };
  const resolved = resolveTraceRef(ref, r);
  if (!resolved) throw new Error(`no cause for ${ref}`);
  return buildLineTrace(resolved, r, { now: F.NOW, answeredBy: (d) => (d.answered_by?.id === "u1" ? "Ashot Petrosian" : null) });
};
const stages = (t: ReturnType<typeof trace>) => t.steps.filter((s) => s.stage !== "station").map((s) => `${s.stage}:${s.status}`);

describe("resolveTraceRef", () => {
  test.each([
    ["ct-101", "cause", "task_a"],
    ["task_a", "cause", "task_a"],
    ["sg-a2", "signal", "sig_a2"],
    ["sig_a3", "signal", "sig_a3"],
    ["aw:c-42", "fingerprint", "sig_a2"],
    ["run_a", "run", "run_a"],
    ["sd-1", "decision", "dec_a1"],
    ["dec_a2", "decision", "dec_a2"],
  ])("%s resolves through its %s", (ref, via, focusId) => {
    const r = resolveTraceRef(ref, rows)!;
    expect(r.cause._id).toBe("task_a");
    expect(r).toMatchObject({ via, focusId });
  });

  test("a fingerprint only the cause row keeps", () => {
    const r = resolveTraceRef("aw:c-42", { ...rows, signals: [] })!;
    expect(r).toMatchObject({ via: "fingerprint", focusId: "task_a" });
  });

  test("a decision without a task finds it through its run", () => {
    const d = { ...F.decisionsA[0], task_id: undefined };
    expect(resolveTraceRef("sd-1", { ...rows, decisions: [d] })?.cause._id).toBe("task_a");
  });

  test("an unknown ref, or one whose cause the rows lack, is null", () => {
    expect(resolveTraceRef("ct-999", rows)).toBeNull();
    expect(resolveTraceRef("  ", rows)).toBeNull();
    expect(resolveTraceRef("sg-a1", { ...rows, tasks: [] })).toBeNull();
  });
});

describe("buildLineTrace: a cause that shipped after a revise and held", () => {
  const t = trace("sg-a1");

  test("one step per stage, in the story's order", () => {
    expect(stages(t)).toEqual(["finding:done", "group:done", "cause:done", "ground:done", "card:done", "card:done", "ship:done", "watch:done", "outcome:done"]);
    expect(t.outcome).toBe("held");
    expect(t.steps.findIndex((s) => s.stage === "station")).toBe(4);
  });

  test("the finding: the finder's words, the expectation it breaks, a link back to where it was seen", () => {
    const f = t.steps[0];
    expect(f).toMatchObject({ stage: "finding", title: "Reply skipped the broker's question", detail: "The agent answered a different question than the broker asked.", nodeId: "source:agentwatch" });
    expect(f.links).toEqual([{ label: "Where it was seen", href: "https://admin.example.com/agentwatch/clusters/c-42", external: true }]);
    expect(f.artifacts).toContainEqual({ kind: "expectation", label: "Breaks ex-union-3", ref: "ex-union-3" });
  });

  test("the group: siblings and how this one attached", () => {
    const g = t.steps[1];
    expect(g.title).toBe("3 signals share this cause");
    expect(g.detail).toBe("It opened this cause. From agentwatch and chat");
    expect(g.artifacts.map((a) => a.ref)).toEqual(["sg-a2", "sg-a3"]);
  });

  test("the cause and its ground", () => {
    expect(t.steps[2]).toMatchObject({ title: "Broker replies skip the question asked", detail: "prompt · review risk · 1 run so far", links: [{ label: "Open ct-101", href: "/tasks/ct-101" }] });
    expect(t.steps[3]).toMatchObject({ stage: "ground", detail: "Serves in-3. Three replies show it", nodeId: "ground", durationMs: 4 * F.MIN });
    expect(t.steps[3].artifacts).toEqual([expect.objectContaining({ kind: "session", href: "/conversation/jx_ground" })]);
  });

  test("each run station by station, the earlier round drawn as inferred", () => {
    const st = t.steps.filter((s) => s.stage === "station");
    const impl = st.filter((s) => s.nodeId === "implement");
    expect(impl).toHaveLength(2);
    expect(impl[0]).toMatchObject({ inferred: true, at: null, status: "done", artifacts: [] });
    expect(impl[1]).toMatchObject({ detail: "Built the change", durationMs: 40 * F.MIN, round: 1, runId: "run_a" });
    expect(impl[1].artifacts).toEqual([expect.objectContaining({ kind: "session", href: "/conversation/jx_impl2" })]);
    expect(st.find((s) => s.nodeId === "decide" && !s.inferred)!.detail).toBe("Answered Ship");
    // Ground is its own stage, not repeated as a station.
    expect(st.some((s) => s.nodeId === "ground")).toBe(false);
  });

  test("the cards: what each decided, its recommendation, who answered and when", () => {
    const cards = t.steps.filter((s) => s.stage === "card");
    expect(cards.map((c) => c.title)).toEqual(["Revise: Replies answer the question asked", "Ship: Replies answer the question asked"]);
    expect(cards[1].detail).toMatch(/^Recommends ship: every miss passes, guards hold\. Ashot Petrosian answered Ship /);
    expect(cards[0].detail).toMatch(/Answered Revise/);
    expect(cards[1]).toMatchObject({ durationMs: F.HOUR, links: [{ label: "Open the card", href: "/decisions/sd-2" }] });
  });

  test("ship, watch and the outcome", () => {
    const by = (stage: string) => t.steps.find((s) => s.stage === stage)!;
    expect(by("ship")).toMatchObject({ title: "Shipped", detail: "Merged", nodeId: "merge" });
    expect(by("watch")).toMatchObject({ title: "The watch ended quiet", status: "done" });
    expect(by("outcome")).toMatchObject({ title: "Held: the fix stayed fixed through its watch", nodeId: "end:held" });
    expect(t.where.text).toMatch(/The watch ended quiet\.$/);
  });

  test("the path on the map repeats the loop", () => {
    const p = t.pathNodeIds;
    expect(p.slice(0, 5)).toEqual(["expectations", "source:agentwatch", "signals", "causes", "ground"]);
    expect(p.filter((x) => x === "implement")).toHaveLength(2);
    expect(p.filter((x) => x === "decide")).toHaveLength(2);
    expect(p.slice(-4)).toEqual(["ship", "merge", "watch", "end:held"]);
  });

  test("every path node is a node on the map", () => {
    const ids = new Set(buildLineMap({ ...rows, finders: F.finders, now: F.NOW, windowMs: 30 * F.DAY }).nodes.map((n) => n.id));
    for (const ref of ["ct-101", "ct-102", "ct-103", "ct-104", "ct-105", "ct-106"]) {
      for (const id of trace(ref).pathNodeIds) expect(ids.has(id)).toBe(true);
      for (const s of trace(ref).steps) if (s.nodeId) expect(ids.has(s.nodeId)).toBe(true);
    }
  });
});

describe("buildLineTrace: other ends", () => {
  test("a run at work: the station it is at is current, the rest wait and say on what", () => {
    const t = trace("ct-103");
    expect(stages(t)).toEqual(["finding:done", "group:done", "cause:done", "ground:done", "card:waiting", "ship:waiting", "watch:waiting", "outcome:waiting"]);
    const st = t.steps.filter((s) => s.stage === "station");
    expect(st[st.length - 1]).toMatchObject({ nodeId: "implement", status: "current" });
    expect(t.steps.find((s) => s.stage === "card")!.detail).toBe("Waiting for a card: it is written once the change passes review");
    expect(t.where.text).toBe("Working: at Implement.");
    expect(t.pathNodeIds[t.pathNodeIds.length - 1]).toBe("implement");
  });

  test("a cause never run waits to be admitted", () => {
    const t = trace("ct-105");
    expect(t.steps.find((s) => s.stage === "ground")).toMatchObject({ status: "waiting", detail: "Waiting to be admitted: the line grounds a cause when a run starts on it" });
    expect(t.steps.find((s) => s.stage === "cause")!.detail).toBe("Not rated yet");
    expect(t.steps[1].detail).toBe("A person filed it here");
    expect(t.steps[0].detail).toBe("chat filed a UX problem");
    expect(t.pathNodeIds).toEqual(["source:chat", "signals", "causes"]);
    expect(t.outcome).toBe("open");
  });

  test("dissolved: no card, nothing shipped, and why", () => {
    const t = trace("ci:intro");
    expect(t.via).toBe("fingerprint");
    expect(stages(t)).toEqual(["finding:done", "group:done", "cause:done", "ground:done", "card:skipped", "ship:skipped", "watch:skipped", "outcome:done"]);
    expect(t.steps.find((s) => s.stage === "card")!.detail).toBe("No card: the problem did not reproduce");
    expect(t.pathNodeIds.slice(-3)).toEqual(["prove", "dissolve", "end:dissolved"]);
    expect(t.outcome).toBe("dissolved");
  });

  test("reopened: the signal that came back fails the watch", () => {
    const t = trace("sg-f2");
    expect(t.focusId).toBe("sig_f2");
    expect(t.steps[0].title).toBe("Timezone test fails again");
    const watch = t.steps.find((s) => s.stage === "watch")!;
    expect(watch).toMatchObject({ status: "failed", artifacts: [expect.objectContaining({ ref: "sg-f2" })] });
    expect(watch.title).toMatch(/^Its signal came back /);
    expect(t.outcome).toBe("reopened");
    expect(t.pathNodeIds[t.pathNodeIds.length - 1]).toBe("end:reopened");
    // The store held no decision row: the card reads from the run.
    expect(t.steps.find((s) => s.stage === "card")).toMatchObject({ title: "Answered Ship", status: "done" });
  });

  test("two stopped runs: each round goes back to the queue, the last one stops", () => {
    const t = trace("run_p2");
    expect(t.via).toBe("run");
    expect(t.steps[0]).toMatchObject({ stage: "finding", status: "skipped" });
    expect(t.steps.filter((s) => s.stage === "station").map((s) => s.round)).toEqual([1, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    expect(t.steps.filter((s) => s.status === "failed" && s.stage === "station")).toHaveLength(2);
    const p = t.pathNodeIds;
    expect(p.filter((x) => x === "end:stopped")).toHaveLength(2);
    expect(p.indexOf("end:stopped")).toBeLessThan(p.lastIndexOf("causes"));
    expect(t.outcome).toBe("stopped");
  });

  test("a pending card is where the cause is now", () => {
    const pending = { ...F.decisionsA[1], status: "pending", answer_index: undefined, resolved_at: undefined };
    const t = trace("ct-101", { decisions: [F.decisionsA[0], pending] });
    const card = t.steps.filter((s) => s.stage === "card")[1];
    expect(card).toMatchObject({ status: "current", title: "Waiting for an answer: Replies answer the question asked" });
    expect(card.durationMs).toBe(F.NOW - pending.created_at!);
  });

  test("a trace on a customized line uses its stations' labels", () => {
    const graph = { nodes: SHIPPED_LINE.nodes.map((n) => (n.id === "prove" ? { ...n, label: "Reproduce" } : n)), edges: SHIPPED_LINE.edges };
    const t = buildLineTrace(resolveTraceRef("ct-102", rows)!, rows, { now: F.NOW, graph });
    expect(t.steps.find((s) => s.nodeId === "prove")!.title).toBe("Reproduce");
  });
});

test("decisionAnswer reads the option's words", () => {
  expect(decisionAnswer(F.decisionsA[0])).toBe("Revise");
  expect(decisionAnswer({ ...F.decisionsA[0], answer_text: "[S] Ship :: Land it" })).toBe("Ship");
  expect(decisionAnswer({ ...F.decisionsA[0], answer_index: undefined })).toBeNull();
});

describe("the finder's words and the goal, as a person reads them", () => {
  test("the finding drops markdown's marks", () => {
    const md = "## Finding\n**An intro reaches both people** (see `ex-1`, [cluster](https://x.test/c))";
    const t = trace("sg-a1", { signals: F.rows.signals.map((s) => (s._id === "sig_a1" ? { ...s, detail_md: md } : s)) });
    expect(t.steps[0].detail).toBe("An intro reaches both people (see ex-1, cluster)");
  });

  test("ground names the goal when the caller knows it, else keeps its ref", () => {
    const r = resolveTraceRef("ct-102", rows)!;
    expect(buildLineTrace(r, rows, { now: F.NOW, goalName: (g) => (g === "in-3" ? "Matching that lands" : null) }).steps.find((s) => s.stage === "ground")?.detail).toBe("Serves Matching that lands");
    expect(buildLineTrace(r, rows, { now: F.NOW }).steps.find((s) => s.stage === "ground")?.detail).toBe("Serves in-3");
  });
});

describe("AgentWatch findings as a person traces them (LX4)", () => {
  const awMd = "**An intro reaches both people and says why they fit** (severity 7/10, ex-union-3)\n\nThe intro gave only titles and a vague overlap.\n\n16 findings in this AgentWatch cluster (match judge).";
  test("the finding says what the finder saw, not the expectation it breaks again", () => {
    const t = trace("ct-101", { signals: F.rows.signals.map((s) => (s._id === "sig_a1" ? { ...s, detail_md: awMd } : s)) });
    expect(t.steps[0].detail).toBe("The intro gave only titles and a vague overlap.");
    expect(t.focusSignalId).toBe("sig_a1");
  });

  test("the group names other causes the same fingerprint opened", () => {
    const dup = { ...F.rows.signals.find((s) => s._id === "sig_a1")!, _id: "sig_dup", task_id: "task_b" };
    const g = trace("ct-101", { signals: [...F.rows.signals, dup] }).steps[1];
    expect(g.detail).toEndWith("The same AgentWatch finding also opened:");
    // The other cause reads by where it lives and its state, so a near-identical title is told apart.
    expect(g.links).toEqual([{ label: "Intro email sent twice", href: "/line/trace/ct-102", ref: "ct-102", note: expect.any(String), state: expect.any(String), earlier: expect.any(Boolean) }]);
  });

  test("a lone signal seen before says so in its headline, never 'only this signal'", () => {
    const a1 = F.rows.signals.find((s) => s._id === "sig_a1")!;
    const dup = { ...a1, _id: "sig_dup", task_id: "task_b" };
    const others = F.rows.signals.filter((s) => s.task_id !== "task_a");
    const g = trace("ct-101", { signals: [a1, ...others, dup] }).steps[1];
    expect(g.title).toBe("Seen before: filed to 1 other cause too");
    // It never reads as opening this cause right before naming the others it opened.
    expect(g.detail).toBe("The same AgentWatch finding also opened:");
    expect(g.links[0]).toMatchObject({ ref: "ct-102" });
  });

  test("a lone signal nothing else saw is the only one so far", () => {
    const a1 = F.rows.signals.find((s) => s._id === "sig_a1")!;
    const g = trace("ct-101", { signals: [a1, ...F.rows.signals.filter((s) => s.task_id !== "task_a")] }).steps[1];
    expect(g.title).toBe("Only this signal so far");
  });
});

describe("where it is now: one value", () => {
  test("a newer run building while an older run's card is open says both, and the strip rings the newer run's station", () => {
    const open = { ...F.decisionsA[1], _id: "dec_open", short_id: "sd-9", status: "pending", resolved_at: undefined, answer_index: undefined, answered_by: null };
    const later = { ...F.runA, _id: "run_a2", status: "running" as const, current_node_id: "eval", gate_decision_short_id: undefined, gate_answer: undefined, created_at: F.NOW - HOUR_MS, updated_at: F.NOW, node_statuses: [F.n("ground", F.NOW - HOUR_MS, 3), F.n("eval", F.NOW - HOUR_MS + 5 * F.MIN, 0, "running")] };
    const t = trace("ct-101", { runs: [...F.rows.runs, later], decisions: [F.decisionsA[0], open] });
    expect(t.where.text).toBe("Run 2 is at Eval. Card sd-9 from run 1 is still open; answering Ship ships run 1's change.");
    expect(t.hereNodeId).toBe("eval");
    expect(t.steps.at(-1)?.detail).toBe(t.where.text);
    expect(t.runs.map((r) => r.end)).toEqual(["shipped", "working"]);
  });

  test("a withdrawn card is finished and neutral, and says why", () => {
    const withdrawn = { ...F.decisionsA[1], status: "withdrawn", answer_index: undefined, answered_by: null };
    const step = trace("ct-101", { decisions: [F.decisionsA[0], withdrawn] }).steps.find((s) => s.id === "card:dec_a2")!;
    expect(step.status).toBe("noted");
    expect(step.detail).toEndWith("The card was withdrawn before anyone answered it.");
  });
});

describe("traceBlocks", () => {
  test("a card reads right after the run that wrote it, before a later run", () => {
    const later = { ...F.runA, _id: "run_a2", status: "running" as const, gate_decision_short_id: undefined, gate_answer: undefined, created_at: F.NOW - HOUR_MS, updated_at: F.NOW, node_statuses: [F.n("ground", F.NOW - HOUR_MS, 3), F.n("analyze", F.NOW - HOUR_MS + 5 * F.MIN, 0, "running")] };
    const t = trace("ct-101", { runs: [...F.rows.runs, later] });
    const order = traceBlocks(t).map((b) => (b.kind === "run" ? `run:${b.runId}` : b.step.stage));
    expect(order.slice(order.indexOf("run:run_a"), order.indexOf("run:run_a2") + 1)).toEqual(["run:run_a", "card", "card", "run:run_a2"]);
  });

  test("the recommendation's own period is not doubled", () => {
    const d = { ...F.decisionsA[1], card: { headline: "x", recommend: { verdict: "ship", why: "every miss passes." } } };
    const t = trace("ct-101", { decisions: [F.decisionsA[0], d] });
    expect(t.steps.find((s) => s.id === "card:dec_a2")?.detail).toStartWith("Recommends ship: every miss passes. ");
  });
});

describe("the path strip and its summary", () => {
  test("chips follow the path, each node once with how many times it went, the ends last", () => {
    const t = trace("sg-a1");
    const chips = tracePathChips(t);
    const firsts = t.pathNodeIds.filter((id, i) => t.pathNodeIds.indexOf(id) === i);
    // The card's routine steps read as one chip, Card, at the first of them.
    const shown = firsts.filter((id) => !isRoutineStation(id) || id === firsts.find(isRoutineStation));
    expect(chips.map((c) => c.nodeId)).toEqual([...shown.filter((id) => !id.startsWith("end:")), ...shown.filter((id) => id.startsWith("end:"))]);
    expect(chips[0]).toMatchObject({ label: "Expectations" });
    expect(chips.find((c) => c.nodeId === "source:agentwatch")?.label).toBe("agentwatch");
    expect(chips.find((c) => c.nodeId === "causes")?.label).toBe("Causes");
    expect(chips.reduce((n, c) => n + c.times, 0)).toBe(t.pathNodeIds.filter((id, i) => !isRoutineStation(id) || !isRoutineStation(t.pathNodeIds[i - 1] ?? "")).length);
    // A chip's status is its newest step's, as the story's dot shows it.
    for (const c of chips.filter((c) => !isRoutineStation(c.nodeId))) {
      const step = [...t.steps].reverse().find((s) => s.nodeId === c.nodeId);
      if (step) expect(c.status).toBe(step.status);
    }
  });

  test("repeats collapse, in a row or across runs; a run stopped along the way is no chip, the trace's own stop is", () => {
    const labels = { causes: "Causes", prove: "Prove", red: "Red", "end:stopped": "Stopped" };
    const along = tracePathChips({ pathNodeIds: ["causes", "prove", "prove", "end:stopped", "causes", "prove", "red"], pathLabels: labels, steps: [] });
    expect(along.map((c) => `${c.label}x${c.times}`)).toEqual(["Causesx2", "Provex3", "Redx1"]);
    const ended = tracePathChips({ pathNodeIds: ["causes", "prove", "end:stopped", "causes", "red", "end:stopped"], pathLabels: labels, steps: [] });
    expect(ended.map((c) => `${c.label}x${c.times}`)).toEqual(["Causesx2", "Provex1", "Redx1", "Stoppedx1"]);
    expect(ended.find((c) => c.nodeId === "end:stopped")?.status).toBe("failed");
  });

  test("the card's routine steps are one chip, Card, counted once a run", () => {
    const chips = tracePathChips({ pathNodeIds: ["causes", "eval", "card_draft", "card_write", "card", "decide", "causes", "eval", "card_draft", "card_write", "card", "decide"], pathLabels: { causes: "Causes", eval: "Eval", card_draft: "Card words", card_write: "Card", card: "Card", decide: "Decide" }, steps: [] });
    expect(chips.map((c) => `${c.label}x${c.times}`)).toEqual(["Causesx2", "Evalx2", "Cardx2", "Decidex2"]);
  });

  test("a chip counts the runs that reached it, and a replaced run's step takes its own tone (LX4)", () => {
    const step = (nodeId: string, runId: string, status: "done" | "failed" = "done") => ({ id: `${nodeId}:${runId}`, stage: "station" as const, title: nodeId, at: 1, durationMs: null, status, detail: "", links: [], artifacts: [], nodeId, runId });
    const chips = tracePathChips({
      pathNodeIds: ["causes", "implement", "verify", "causes", "implement", "verify", "implement", "verify"],
      pathLabels: { causes: "Causes", implement: "Implement", verify: "Verify" },
      steps: [step("implement", "r1"), step("verify", "r1"), step("implement", "r2"), step("verify", "r2")],
      runs: [{ runId: "r1", round: 1, end: "stopped", at: null }, { runId: "r2", round: 2, end: "replaced", at: null, by: 3 }],
    });
    const at = (id: string) => chips.find((c) => c.nodeId === id)!;
    // Causes: each of the two runs started there, so x2 says nothing the tally does not.
    expect(at("causes")).toMatchObject({ times: 2, runs: 2 });
    // Implement went three times in two runs: a loop inside one, worth its count.
    expect(at("implement")).toMatchObject({ times: 3, runs: 2 });
    // Its newest step is in the replaced run: it passed, and reads replaced, not green.
    expect(at("verify")).toMatchObject({ status: "done", tone: "replaced" });
  });

  test("the summary: when found, how many runs, where it stopped most", () => {
    const t = trace("sg-a1");
    expect(tracePathSummary(t)).toMatch(/^Found \w+ \d+, 1 run/);
    // Every run counts, each by how it ended; the stopped ones say where they stopped most.
    const run = (round: number, end: "stopped" | "working" | "shipped", at: string | null = null) => ({ runId: `r${round}`, round, end, at });
    const summary = tracePathSummary({ steps: t.steps, runs: [run(1, "stopped", "Prove"), run(2, "stopped", "Implement"), run(3, "stopped", "Prove"), run(4, "working")] });
    expect(summary).toMatch(/^Found \w+ \d+, 4 runs: 3 stopped \(2 at Prove\), 1 working$/);
    expect(tracePathSummary({ steps: t.steps, runs: [run(1, "stopped", "Prove"), run(2, "stopped", "Prove")] })).toEndWith("2 runs: 2 stopped (all at Prove)");
    expect(tracePathSummary({ steps: t.steps, runs: [run(1, "stopped", "Red")] })).toEndWith("1 run, stopped at Red");
  });
});

describe("a run replaced by a newer run (LX4)", () => {
  // Run 1 reached its card; while the card waited a new signal joined and run 2
  // started, which withdrew the card. Run 2 failed at Prove; run 3 waits on its card.
  const t0 = F.NOW - 10 * F.HOUR;
  const at = (h: number) => t0 + h * F.HOUR;
  const base = { ...F.runA, gate_answer: undefined, gate_response: undefined };
  const r1 = { ...base, _id: "run_r1", status: "failed" as const, fail_reason: "gate withdrawn", gate_node_id: "decide", gate_decision_status: "withdrawn", current_node_id: "decide", created_at: at(0), updated_at: at(2), node_statuses: [F.n("ground", at(0), 3), F.n("eval", at(0.5), 20)] };
  const r2 = { ...base, _id: "run_r2", status: "failed" as const, fail_reason: "prove failed", gate_node_id: undefined, gate_decision_status: undefined, current_node_id: "prove", created_at: at(2) + 2 * F.MIN, updated_at: at(3), node_statuses: [F.n("ground", at(2) + 2 * F.MIN, 3), F.n("prove", at(2.5), 10, "failed")] };
  const r3 = { ...base, _id: "run_r3", status: "paused" as const, gate_node_id: "decide", gate_decision_status: "pending", current_node_id: "decide", created_at: at(4), updated_at: at(6), node_statuses: [F.n("ground", at(4), 3), F.n("eval", at(4.5), 20)] };
  const card1 = { ...F.decisionsA[0], _id: "dec_r1", short_id: "sd-71", status: "withdrawn", workflow_run_id: "run_r1", created_at: at(1), resolved_at: at(2), answer_index: undefined, answered_by: null, card: { headline: "Intro emails say what each side wants" } };
  const card3 = { ...F.decisionsA[0], _id: "dec_r3", short_id: "sd-73", status: "pending", workflow_run_id: "run_r3", created_at: at(5), resolved_at: undefined, answer_index: undefined, answered_by: null, card: { headline: "Intro emails say what each person wants and can offer the other" } };
  const joined = { ...F.rows.signals.find((s) => s.task_id === "task_a")!, _id: "sig_new", short_id: "sg-new", created_at: at(1.5), observed_at: at(1.5), source: "agentwatch" };
  const t = trace("ct-101", { runs: [r1, r2, r3], decisions: [card1, card3], signals: [...F.rows.signals, joined] });

  test("its end is replaced, never stopped, with the run that replaced it and what started that run", () => {
    expect(t.runs.map((r) => r.end)).toEqual(["replaced", "stopped", "waiting"]);
    expect(t.runs[0]).toMatchObject({ by: 2, why: "Run 2 started when a new AgentWatch signal joined the cause" });
    expect(replacedWords(t.runs[0])).toBe("Reached a card; replaced by run 2 before anyone answered.");
  });

  test("the summary leaves it out of the stops and says it was replaced", () => {
    expect(tracePathSummary(t)).toMatch(/ 3 runs: 1 stopped, 1 reached a card and was replaced by a newer run, 1 waiting on you$/);
  });

  test("its card says the same, and the path goes back to the queue, not to Stopped", () => {
    expect(t.steps.find((s) => s.id === "card:dec_r1")?.detail).toEndWith("run 2 started and replaced it. Run 2 started when a new AgentWatch signal joined the cause.");
    // Only run 2, the real stop, visits Stopped.
    expect(t.pathNodeIds.filter((id) => id === "end:stopped")).toHaveLength(1);
    expect(tracePathChips(t).some((c) => c.nodeId === "end:stopped")).toBe(false);
  });

  test("the story folds its card into its run block and stops its rows at the card gate", () => {
    const blocks = traceBlocks(t);
    const run1 = blocks.find((b) => b.kind === "run" && b.runId === "run_r1");
    expect(run1?.kind === "run" && run1.card).toEqual({ title: "Intro emails say what each side wants", href: "/decisions/sd-71" });
    expect(blocks.some((b) => b.kind === "step" && b.step.id === "card:dec_r1")).toBe(false);
    // The open card of run 3 still follows its run as a step.
    expect(blocks.some((b) => b.kind === "step" && b.step.id === "card:dec_r3")).toBe(true);
    if (run1?.kind === "run") {
      const nodes = run1.rows.flatMap((r) => (r.kind === "station" ? [r.step.nodeId] : []));
      if (nodes.includes("decide")) expect(nodes[nodes.length - 1]).toBe("decide");
    }
  });

  test("the cause says its runs, and the open card carries its headline", () => {
    expect(t.steps.find((s) => s.stage === "cause")?.detail).toEndWith("on its 3rd run");
    expect(t.steps.find((s) => s.id === "card:dec_r3")?.headline).toBe("Intro emails say what each person wants and can offer the other");
  });
});

describe("after the card is answered (LX4)", () => {
  const T0 = F.NOW - 8 * HOUR_MS;
  const approvedRun = {
    ...F.runA, _id: "run_ok", status: "running" as const, current_node_id: "decide", gate_answer: undefined, gate_decision_short_id: undefined, created_at: T0, updated_at: F.NOW - 5 * HOUR_MS,
    node_statuses: [F.n("ground", T0, 3), F.n("implement", T0 + HOUR_MS, 20), F.n("card", T0 + 2 * HOUR_MS, 1), F.n("decide", T0 + 2 * HOUR_MS + 5 * F.MIN, 0, "running")],
  };
  const answered = { ...F.decisionsA[1], _id: "dec_ok", workflow_run_id: "run_ok", created_at: T0 + 2 * HOUR_MS, resolved_at: F.NOW - 5 * HOUR_MS };
  const t = trace("ct-101", { runs: [approvedRun], decisions: [answered] });

  test("the header says Ship was answered and the ship step waits, not that the run works at Decide", () => {
    // Five hours with nothing from the run: past the usual pickup, said in the warning tone with why.
    expect(t.where).toMatchObject({ tone: "stuck", text: "You answered Ship 5h ago, but run 1 has reported nothing in 5h: no runner is driving it." });
    expect(t.whereRun).toEqual({ runId: "run_ok", round: 1 });
    // It stands at Decide with the answer on the row, so it resumes there rather than starting over.
    expect(t.stalledRun).toEqual({ runId: "run_ok", round: 1, resumable: true });
    expect(t.runs.map((r) => r.end)).toEqual(["approved"]);
    expect(tracePathSummary(t)).toEndWith("1 run, approved, waiting to ship");
  });

  test("Ship and Watch are titled by what they wait on; the stall is said once, in the header", () => {
    const ship = t.steps.find((s) => s.stage === "ship")!;
    expect(ship).toMatchObject({ title: "Waiting for a runner since you answered Ship", status: "waiting", detail: "" });
    expect(t.steps.find((s) => s.stage === "watch")!.title).toBe("Waiting for the change to land");
    const outcome = t.steps.find((s) => s.stage === "outcome")!;
    expect(outcome.detail).toBe("Known about 7 days after it ships");
    expect(t.steps.filter((s) => /no runner/.test(`${s.title} ${s.detail}`))).toEqual([]);
  });

  test("answered minutes ago, the wait is plain: a runner picks a card up within seconds", () => {
    const early = trace("ct-101", { runs: [{ ...approvedRun, updated_at: F.NOW - 5 * F.MIN }], decisions: [{ ...answered, resolved_at: F.NOW - 5 * F.MIN }] });
    expect(early.where).toMatchObject({ tone: "waiting", text: "You answered Ship 5m ago; the ship step has not started." });
    expect(early.stalledRun).toBeNull();
    expect(early.steps.find((s) => s.stage === "ship")!.title).toBe("Waiting for the ship step to start");
  });

  test("the strip rings the chip the cause is at as under way", () => {
    expect(tracePathChips(t).find((c) => c.nodeId === "decide")).toMatchObject({ tone: "current" });
  });
});

describe("a run stopped for looping (LX4)", () => {
  test("its looped station counts every visit, so 'looped three times' has its rows", () => {
    const looped = { ...F.pastRuns[0], task_id: "task_a" };
    const t = trace("ct-101", { runs: [looped], decisions: [] });
    const impl = t.steps.find((s) => s.nodeId === "implement")!;
    expect(impl.visits).toBe(3);
    expect(t.steps.find((s) => s.nodeId === "verify")!.visits).toBeUndefined();
    // A chip counts the runs that stopped at it, so an earlier stop shows on the strip.
    expect(tracePathChips(t).find((c) => c.nodeId === "verify")?.stops).toBe(1);
  });

  test("a chip shows how many runs stopped there", () => {
    const stop = (id: string, at: number) => ({ ...F.runA, _id: id, status: "failed" as const, current_node_id: "prove", fail_reason: "no outgoing edge from prove", gate_answer: undefined, created_at: at, updated_at: at + HOUR_MS, node_statuses: [F.n("ground", at, 3), F.n("prove", at + 5 * F.MIN, 10, "failed")] });
    const t = trace("ct-101", { runs: [stop("s1", F.NOW - 9 * HOUR_MS), stop("s2", F.NOW - 6 * HOUR_MS), { ...F.runC, _id: "live", task_id: "task_a", created_at: F.NOW - 2 * HOUR_MS }], decisions: [] });
    expect(tracePathChips(t).find((c) => c.nodeId === "prove")?.stops).toBe(2);
  });
});
