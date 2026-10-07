import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { buildLineMap } from "../lineMap";
import { buildLineTrace, decisionAnswer, resolveTraceRef, traceBlocks, tracePathChips, tracePathSummary, type TraceRows } from "../lineTrace";
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
    expect(t.steps[2]).toMatchObject({ title: "Broker replies skip the question asked", detail: "prompt · review risk · ready", links: [{ label: "Open ct-101", href: "/tasks/ct-101" }] });
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
    expect(g.detail).toContain("The same finding also opened 1 other cause");
    expect(g.links).toEqual([{ label: "Intro email sent twice", href: "/line/trace/ct-102", ref: "ct-102" }]);
  });

  test("a lone signal seen before says so in its headline, never 'only this signal'", () => {
    const a1 = F.rows.signals.find((s) => s._id === "sig_a1")!;
    const dup = { ...a1, _id: "sig_dup", task_id: "task_b" };
    const others = F.rows.signals.filter((s) => s.task_id !== "task_a");
    const g = trace("ct-101", { signals: [a1, ...others, dup] }).steps[1];
    expect(g.title).toBe("Seen before: filed to 1 other cause too");
    expect(g.detail).not.toContain("also opened");
    expect(g.links).toEqual([{ label: "Intro email sent twice", href: "/line/trace/ct-102", ref: "ct-102" }]);
  });

  test("a lone signal nothing else saw is the only one so far", () => {
    const a1 = F.rows.signals.find((s) => s._id === "sig_a1")!;
    const g = trace("ct-101", { signals: [a1, ...F.rows.signals.filter((s) => s.task_id !== "task_a")] }).steps[1];
    expect(g.title).toBe("Only this signal so far");
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
    expect(chips.map((c) => c.nodeId)).toEqual([...firsts.filter((id) => !id.startsWith("end:")), ...firsts.filter((id) => id.startsWith("end:"))]);
    expect(chips[0]).toMatchObject({ label: "Expectations" });
    expect(chips.find((c) => c.nodeId === "source:agentwatch")?.label).toBe("agentwatch");
    expect(chips.find((c) => c.nodeId === "causes")?.label).toBe("Causes");
    expect(chips.reduce((n, c) => n + c.times, 0)).toBe(t.pathNodeIds.length);
    // A chip's status is its newest step's, as the story's dot shows it.
    for (const c of chips) {
      const step = [...t.steps].reverse().find((s) => s.nodeId === c.nodeId);
      if (step) expect(c.status).toBe(step.status);
    }
  });

  test("repeats collapse, in a row or across runs, and a stopped end reads as the line stopping it", () => {
    const chips = tracePathChips({ pathNodeIds: ["causes", "prove", "prove", "end:stopped", "causes", "prove", "red"], pathLabels: { causes: "Causes", prove: "Prove", red: "Red", "end:stopped": "Stopped" }, steps: [] });
    expect(chips.map((c) => `${c.label}x${c.times}`)).toEqual(["Causesx2", "Provex3", "Redx1", "Stoppedx1"]);
    expect(chips.find((c) => c.nodeId === "end:stopped")?.status).toBe("failed");
  });

  test("the summary: when found, how many runs, where it stopped most", () => {
    const t = trace("sg-a1");
    expect(tracePathSummary(t)).toMatch(/^Found \w+ \d+, 1 run/);
    const failed = (title: string, runId: string) => ({ id: `${runId}:${title}`, stage: "station" as const, title, at: 1, durationMs: null, status: "failed" as const, detail: "", links: [], artifacts: [], nodeId: title.toLowerCase(), runId });
    const summary = tracePathSummary({ steps: [...t.steps, failed("Prove", "r2"), failed("Prove", "r3"), failed("Verify", "r3")] });
    expect(summary).toContain("3 runs");
    expect(summary).toContain("stopped twice at Prove");
  });
});
