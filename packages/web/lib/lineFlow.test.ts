import { describe, expect, it } from "bun:test";
import { buildLineFlow, goalChip, DAY, HOUR, type LineCauseTask, type LineDecision, type LineFlowRun, type LineSignal } from "./lineFlow";

const NOW = 1_800_000_000_000;

const cause = (id: string, over: Partial<LineCauseTask> = {}): LineCauseTask => ({
  _id: id,
  short_id: `ct-${id}`,
  title: `cause ${id}`,
  status: "open",
  priority: "medium",
  created_at: NOW - 2 * DAY,
  cause: { signal_count: 1, first_seen: NOW - 2 * DAY, last_seen: NOW - HOUR, fingerprints: [id] },
  ...over,
});
const signal = (id: string, over: Partial<LineSignal> = {}): LineSignal => ({
  _id: id, source: "sentry", kind: "bug", title: id, observed_at: NOW - HOUR, created_at: NOW - HOUR, task_id: "t1", ...over,
});
const run = (id: string, over: Partial<LineFlowRun> = {}): LineFlowRun => ({
  _id: id, status: "running", created_at: NOW - 3 * HOUR, updated_at: NOW - HOUR, ...over,
});
const card = (id: string, over: Partial<LineDecision> = {}): LineDecision => ({
  _id: id, status: "pending", blocking: true, workflow_run_id: `r-${id}`, gate_node_id: "decide", created_at: NOW - HOUR, ...over,
});

const flow = (over: Partial<Parameters<typeof buildLineFlow>[0]>) =>
  buildLineFlow({ signals: [], tasks: [], runs: [], decisions: [], initiatives: [], projects: [], now: NOW, ...over });

describe("goalChip", () => {
  const initiatives = [{ short_id: "in-3", title: "Retention", priority: "p0" as const }];
  const projects = [{ short_id: "pj-a", title: "Web" }];
  it("reads an initiative ref with its metric and priority", () => {
    expect(goalChip("in-3:week4", initiatives, projects)).toMatchObject({ kind: "initiative", label: "Retention · week4", priority: "p0" });
  });
  it("a project without a priority is unranked, none is parked, empty is ungrounded", () => {
    expect(goalChip("pj-a", initiatives, projects)).toMatchObject({ kind: "project", priority: "unranked" });
    expect(goalChip("none", initiatives, projects)).toMatchObject({ kind: "parked", priority: null });
    expect(goalChip(undefined, initiatives, projects)).toMatchObject({ kind: "ungrounded", priority: null });
  });
});

describe("buildLineFlow", () => {
  it("ranks open causes by computed priority and folds parked ones", () => {
    const f = flow({
      tasks: [
        cause("a", { goal_ref: "in-3" }),
        cause("b", { goal_ref: "none", cause: { signal_count: 40, first_seen: NOW - DAY, last_seen: NOW, fingerprints: [] } }),
        cause("c"),
        { _id: "plain", title: "not a cause", status: "open", created_at: NOW },
      ],
      initiatives: [{ short_id: "in-3", title: "Retention", priority: "p0" }],
    });
    expect(f.causes.items.map((r) => r.task._id)).toEqual(["a", "c"]);
    expect(f.causes.parked.map((r) => r.task._id)).toEqual(["b"]);
    expect(f.causes.count).toBe(3);
  });

  it("puts each cause in exactly one place: build, awaiting, watching or closed", () => {
    const f = flow({
      tasks: [
        cause("build"),
        cause("await"),
        cause("watch", { status: "done", closed_at: NOW - DAY, watch_until: NOW + 3 * DAY }),
        cause("ship", { status: "done", closed_at: NOW - DAY }),
        cause("drop", { status: "dropped", closed_at: NOW - 2 * DAY }),
        cause("old", { status: "done", closed_at: NOW - 30 * DAY }),
      ],
      runs: [run("r1", { task_id: "build", current_node_id: "implement", node_statuses: [{ node_id: "implement", status: "running", started_at: NOW - HOUR }] })],
      decisions: [card("d1", { task_id: "await" })],
    });
    expect(f.causes.count).toBe(0);
    expect(f.build.items.map((b) => b.run._id)).toEqual(["r1"]);
    expect(f.build.items[0].node?.label).toBe("implement");
    expect(f.build.items[0].since).toBe(NOW - HOUR);
    expect(f.awaiting.items.map((d) => d._id)).toEqual(["d1"]);
    expect(f.watching.items).toEqual([expect.objectContaining({ daysLeft: 3 })]);
    expect(f.closed.items.map((c) => [c.task._id, c.outcome])).toEqual([["ship", "shipped"], ["drop", "dissolved"]]);
  });

  it("a run paused at a pending gate is the card, not a build", () => {
    const f = flow({ runs: [run("r1", { status: "paused", gate_decision_id: "d1", gate_decision_status: "pending" })] });
    expect(f.build.count).toBe(0);
  });

  it("sense groups by source with a 24 hour sparkline", () => {
    const f = flow({
      signals: [
        signal("s1", { created_at: NOW - 30 * 60_000 }),
        signal("s2", { created_at: NOW - 5 * HOUR }),
        signal("s3", { source: "evals", created_at: NOW - 3 * DAY }),
      ],
    });
    expect(f.sense.items.map((s) => [s.source, s.day, s.week])).toEqual([["sentry", 2, 2], ["evals", 0, 1]]);
    expect(f.sense.items[0].spark[23]).toBe(1);
    expect(f.sense.items[0].spark[18]).toBe(1);
    expect(f.sense.count).toBe(2);
    expect(f.sense.state.kind).toBe("running");
  });

  it("stage states: starved when empty, paused behind open cards, failing on a failed run", () => {
    expect(flow({}).sense.state).toMatchObject({ kind: "starved", why: "no finder has written yet" });
    const capped = flow({ tasks: [cause("a")], decisions: [1, 2, 3, 4, 5].map((i) => card(`d${i}`, { created_at: NOW - i * HOUR })) });
    expect(capped.causes.state).toMatchObject({ kind: "paused", why: "queued behind 5 open cards", since: NOW - HOUR });
    const failing = flow({ runs: [run("r1", { status: "failed", fail_reason: "tests red", updated_at: NOW - HOUR })] });
    expect(failing.build.state).toMatchObject({ kind: "failing", why: "tests red" });
  });

  it("throughput for the week", () => {
    const f = flow({
      tasks: [
        cause("a", { status: "done", created_at: NOW - 2 * DAY, closed_at: NOW - DAY, cause: { signal_count: 2, first_seen: NOW - 3 * DAY, last_seen: NOW - DAY, fingerprints: [] } }),
        cause("b", { status: "done", created_at: NOW - 20 * DAY, closed_at: NOW - HOUR, cause: { signal_count: 1, first_seen: NOW - 5 * DAY - HOUR, last_seen: NOW, fingerprints: [] } }),
        cause("c", { status: "dropped", closed_at: NOW - HOUR }),
      ],
      signals: [signal("s1", { reopened: true }), signal("s2", { created_at: NOW - 10 * DAY })],
      runs: [run("r1", { task_id: "a", status: "completed", total_tokens: 3000 }), run("r2", { task_id: "b", status: "completed", total_tokens: 1000 })],
    });
    expect(f.throughput).toEqual({
      signalsIn: 1,
      opened: 2,
      dissolved: 1,
      shipped: 2,
      reopened: 1,
      medianToShip: 3.5 * DAY,
      tokensPerShip: 2000,
    });
  });
});
