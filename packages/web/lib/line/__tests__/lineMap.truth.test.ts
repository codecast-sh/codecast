// Data truth for the map and the trace (line-map.md LX2, LX4): every row the
// store holds lands on the map exactly once, and a trace's path ends where the
// map counted it.
import { describe, expect, test } from "bun:test";
import { SHIPPED_LINE } from "../shippedLine.generated";
import { buildLineMap, endNodeId, runVisits, type MapDecision, type MapRun, type MapSignal } from "../lineMap";
import { buildLineTrace } from "../lineTrace";
import type { LineCauseTask } from "../../lineFlow";
import * as F from "./lineFixtures";

const { NOW, DAY, HOUR, MIN } = F;
const node = (m: ReturnType<typeof buildLineMap>, id: string) => m.nodes.find((x) => x.id === id);

describe("intake: every signal in the window has its source", () => {
  test("an undeclared source quiet for a week still counts in a 30 day window", () => {
    const old: MapSignal = { _id: "sig_old", short_id: "sg-90", task_id: "task_d", created_at: NOW - 20 * DAY, observed_at: NOW - 20 * DAY, source: "sentry", kind: "bug", title: "Crash on save" };
    const m = buildLineMap({ ...F.rows, signals: [...F.rows.signals, old], finders: F.finders, now: NOW, windowMs: 30 * DAY });
    expect(node(m, "source:sentry")?.through).toBe(1);
    expect(m.edges.find((e) => e.id === "source:sentry->signals")?.count).toBe(1);
    const fromSources = m.nodes.filter((n) => n.kind === "source").reduce((s, n) => s + n.through, 0);
    expect(fromSources).toBe(node(m, "signals")!.through);
  });
});

describe("loops: a gate round counts only for an answer", () => {
  test("a withdrawn card on the run adds no round", () => {
    const withdrawn: MapDecision = { _id: "dec_w", short_id: "sd-9", status: "withdrawn", blocking: true, task_id: "task_a", workflow_run_id: "run_a", gate_node_id: "decide", created_at: F.runA.created_at + 30 * HOUR, options: [{ label: "Ship" }, { label: "Revise" }, { label: "Drop" }] };
    const base = runVisits(F.runA, SHIPPED_LINE, F.decisionsA).map((v) => v.node);
    expect(runVisits(F.runA, SHIPPED_LINE, [...F.decisionsA, withdrawn]).map((v) => v.node)).toEqual(base);
  });
});

describe("a run that ended with nothing landed", () => {
  const t0 = NOW - 2 * DAY;
  const cause: LineCauseTask = { _id: "task_r", short_id: "ct-120", title: "Rejected at review", status: "open", created_at: t0, cause: { signal_count: 1, first_seen: t0, last_seen: t0, fingerprints: ["ci:r"] }, goal_ref: "in-3", category: "code", risk: "low", readiness: "ready", project_id: "proj" };
  const run = (status: string): MapRun => ({
    _id: "run_r", status, task_id: "task_r", workflow_name: "line", current_node_id: "exit",
    node_statuses: [F.n("ground", t0 + MIN, 3), F.n("analyze", t0 + 5 * MIN), F.n("prove", t0 + 10 * MIN), F.n("red", t0 + 20 * MIN), F.n("implement", t0 + 30 * MIN, 30), F.n("verify", t0 + HOUR), F.n("green", t0 + HOUR + 10 * MIN), F.n("eval", t0 + HOUR + 20 * MIN), F.n("review", t0 + HOUR + 30 * MIN, 10)],
    created_at: t0, updated_at: t0 + 2 * HOUR,
  });
  for (const status of ["completed", "cancelled"]) {
    test(`${status}: the trace ends at Stopped, where the map counted it`, () => {
      const rows = { signals: [], tasks: [cause], runs: [run(status)], decisions: [] };
      const m = buildLineMap({ ...rows, now: NOW, windowMs: 7 * DAY });
      expect(m.edges.find((e) => e.id === `review->${endNodeId("stopped")}`)?.count).toBe(1);
      const tr = buildLineTrace(cause, rows, { now: NOW });
      expect(tr.outcome).toBe("stopped");
      expect(tr.pathNodeIds[tr.pathNodeIds.length - 1]).toBe(endNodeId("stopped"));
    });
  }
});

describe("after ship: a watch past its end that the sweep has not closed yet", () => {
  // The sweep stamps resolved_at; until it runs, a done cause keeps its past watch_until (LE12).
  const cause: LineCauseTask = { ...F.causeA, resolved_at: undefined, watch_until: NOW - 6 * HOUR };
  const rows = { ...F.rows, tasks: F.rows.tasks.map((t) => (t._id === cause._id ? cause : t)) };

  test("the map counts it held, not lost between Watch and its end", () => {
    const m = buildLineMap({ ...rows, finders: F.finders, now: NOW, windowMs: 7 * DAY });
    expect(node(m, endNodeId("held"))?.through).toBe(1);
    expect(node(m, "watch")!.now.some((it) => it.id === cause._id)).toBe(false);
  });

  test("the trace says held, as its watch step does", () => {
    const tr = buildLineTrace(cause, rows, { now: NOW });
    expect(tr.steps.find((s) => s.stage === "watch")?.title).toBe("The watch ended quiet");
    expect(tr.outcome).toBe("held");
    expect(tr.pathNodeIds[tr.pathNodeIds.length - 1]).toBe(endNodeId("held"));
  });
});

describe("a trace ref from the URL", () => {
  test("survives the router's own decoding: a fingerprint with a percent sign does not throw", async () => {
    const { lineTraceHref, traceRefOf } = await import("../lineMapUrl");
    for (const ref of ["ct-101", "aw:c-42", "load:100%", "  sg-3 "]) {
      const segment = lineTraceHref(ref).split("/").pop()!;
      expect(traceRefOf(segment)).toBe(ref.trim());
      // The router may hand the segment over decoded already.
      expect(traceRefOf(decodeURIComponent(segment))).toBe(ref.trim());
    }
  });
});
