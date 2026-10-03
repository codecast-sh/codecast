import { describe, expect, it } from "bun:test";
import { buildLineFlow, defaultLineKey, goalChip, groupBuild, lineHeadline, lineRollup, runName, scopeLine, ALL_PROJECTS, DAY, HOUR, NO_PROJECT, type LineCauseTask, type LineDecision, type LineFlowRun, type LineProject, type LineSignal } from "./lineFlow";

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

  it("a swept quiet watch stays resolved; a cause it closed without a ship is not shipped", () => {
    const f = flow({
      tasks: [
        cause("held", { status: "done", closed_at: NOW - 5 * DAY, resolved_at: NOW - HOUR }),
        cause("quiet", { status: "done", closed_at: NOW - HOUR, resolved_at: NOW - HOUR }),
        cause("unswept", { status: "done", closed_at: NOW - 6 * DAY, watch_until: NOW - 2 * HOUR }),
        cause("again", { status: "done", closed_at: NOW - 2 * HOUR, resolved_at: NOW - 3 * DAY }),
      ],
    });
    expect(f.closed.items.map((c) => [c.task._id, c.outcome, c.at])).toEqual([
      ["held", "resolved", NOW - HOUR],
      ["quiet", "resolved", NOW - HOUR],
      ["unswept", "resolved", NOW - 2 * HOUR],
      ["again", "shipped", NOW - 2 * HOUR],
    ]);
    // held and unswept shipped this week and their watches held; quiet never shipped.
    expect(f.throughput.shipped).toBe(3);
  });

  it("a ship still in its watch counts as shipped and says it sits in Watching, not Closed", () => {
    const f = flow({ tasks: [cause("w", { status: "done", closed_at: NOW - DAY, watch_until: NOW + 5 * DAY })] });
    expect(f.throughput.shipped).toBe(1);
    expect(f.throughput.shippedInWatch).toBe(1);
    expect(f.watching.count).toBe(1);
    expect(f.closed.count).toBe(0);
  });

  it("only cards at the decide gate hold admission; Awaiting lists every blocking ask", () => {
    const asks = [1, 2, 3, 4, 5].map((i) => card(`d${i}`, { created_at: NOW - i * HOUR, gate_node_id: i === 1 ? "review" : "decide" }));
    const f = flow({ tasks: [cause("a")], decisions: asks });
    expect(f.awaiting.count).toBe(5);
    expect(f.causes.state.kind).toBe("running");
  });

  it("a run paused at a pending gate is the card, not a build", () => {
    const f = flow({ runs: [run("r1", { status: "paused", gate_decision_id: "d1", gate_decision_status: "pending" })] });
    expect(f.build.count).toBe(0);
  });

  it("a live run silent for a day is stalled: listed last, not counted as building", () => {
    const f = flow({ tasks: [cause("a"), cause("b")], runs: [run("old", { task_id: "a", created_at: NOW - 40 * DAY, updated_at: NOW - 30 * DAY }), run("new", { task_id: "b" })] });
    expect(f.build.items.map((b) => [b.run._id, b.stalled])).toEqual([["new", false], ["old", true]]);
    expect(f.build.state).toMatchObject({ kind: "running", why: "1 building, 1 stalled" });
  });

  it("sense groups by source with a seven day sparkline", () => {
    const f = flow({
      signals: [
        signal("s1", { created_at: NOW - 30 * 60_000 }),
        signal("s2", { created_at: NOW - 5 * HOUR }),
        signal("s3", { source: "evals", created_at: NOW - 3 * DAY }),
      ],
    });
    expect(f.sense.items.map((s) => [s.source, s.day, s.week])).toEqual([["sentry", 2, 2], ["evals", 0, 1]]);
    expect(f.sense.items[0].spark).toEqual([0, 0, 0, 0, 0, 0, 2]);
    expect(f.sense.items[1].spark).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(f.sense.count).toBe(2);
    expect(f.sense.state.kind).toBe("running");
  });

  it("stage states: idle before the first signal, starved when signals stop, paused behind open cards, failing on a failed run", () => {
    expect(flow({}).sense.state).toMatchObject({ kind: "idle", why: "waiting for the first signal" });
    expect(flow({ signals: [signal("s1", { created_at: NOW - 3 * DAY })] }).sense.state).toMatchObject({ kind: "starved", why: "no signal in 24h" });
    expect(flow({ tasks: [cause("a")] }).build.state).toMatchObject({ kind: "starved", why: "causes wait, nothing building" });
    expect(flow({ decisions: [card("d1")] }).awaiting.state.kind).toBe("ask");
    const capped = flow({ tasks: [cause("a")], decisions: [1, 2, 3, 4, 5].map((i) => card(`d${i}`, { created_at: NOW - i * HOUR })) });
    expect(capped.causes.state).toMatchObject({ kind: "paused", why: "queued behind 5 open cards", since: NOW - HOUR });
    const failing = flow({ tasks: [cause("a")], runs: [run("r1", { task_id: "a", status: "failed", fail_reason: "tests red", updated_at: NOW - HOUR })] });
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
      shippedInWatch: 0,
      reopened: 1,
      medianToShip: 3.5 * DAY,
      tokensPerShip: 2000,
      daily: {
        signalsIn: [0, 0, 0, 0, 0, 0, 1],
        opened: [0, 0, 0, 0, 0, 2, 0],
        dissolved: [0, 0, 0, 0, 0, 0, 1],
        shipped: [0, 0, 0, 0, 0, 0, 2],
        reopened: [0, 0, 0, 0, 0, 0, 1],
      },
    });
  });

  it("a line that never started is idle, never starved; downstream stations read clear", () => {
    const f = flow({});
    expect(f.started).toBe(false);
    expect([f.sense.state.kind, f.causes.state.kind, f.build.state.kind]).toEqual(["idle", "idle", "idle"]);
    expect([f.awaiting.state.kind, f.watching.state.kind, f.closed.state.kind]).toEqual(["clear", "clear", "clear"]);
  });

  it("In build holds only runs on a cause; other live runs are counted apart", () => {
    const f = flow({
      tasks: [cause("a"), { _id: "plain", title: "not a cause", status: "open", created_at: NOW }],
      runs: [run("r1", { task_id: "a" }), run("r2", { task_id: "plain" }), run("r3"), run("r4", { status: "failed", updated_at: NOW - HOUR })],
    });
    expect(f.build.items.map((b) => b.run._id)).toEqual(["r1"]);
    expect(f.build.otherRuns).toBe(2);
    expect(f.build.state.kind).toBe("running");
    expect(f.moved.build).toBe(1);
  });

  it("counts what entered each station this week", () => {
    const f = flow({
      tasks: [cause("a", { created_at: NOW - DAY }), cause("b", { created_at: NOW - 10 * DAY })],
      runs: [run("r1", { task_id: "a", created_at: NOW - DAY }), run("r2", { task_id: "a", created_at: NOW - 9 * DAY }), run("r3", { created_at: NOW - DAY })],
      decisions: [card("d1"), card("d2", { status: "answered" }), card("d3", { created_at: NOW - 8 * DAY })],
    });
    expect(f.moved).toMatchObject({ causes: 1, build: 1, awaiting: 2 });
  });
});

describe("runName", () => {
  it("never shows a bare workflow: task, goal, phase, real name, then step and id", () => {
    expect(runName(run("r1", { workflow_name: "workflow", task_title: "Fix the login" }))).toEqual({ name: "Fix the login", workflow: null });
    expect(runName(run("r1", { workflow_name: "workflow", goal_override: "Audit the evals\nmore" }))).toEqual({ name: "Audit the evals", workflow: null });
    expect(runName(run("r1", { workflow_name: "workflow", phases: [{ title: "Survey" }] })).name).toBe("Survey");
    expect(runName(run("r1", { workflow_name: "eval-rehaul-wave1" }))).toEqual({ name: "eval rehaul wave1", workflow: null });
    expect(runName(run("abc12345", { workflow_name: "workflow" }), undefined, "Implement").name).toBe("Implement · 12345");
    expect(runName(run("r1", { workflow_name: "line" }), { title: "Crash on save" })).toEqual({ name: "Crash on save", workflow: "line" });
  });
});

describe("lineHeadline", () => {
  const text = (f: ReturnType<typeof flow>) => lineHeadline(f, NOW).map((p) => p.text).join(", ");
  it("leads with cards waiting, then building and stalled", () => {
    const f = flow({
      tasks: [cause("a"), cause("b")],
      runs: [run("r1", { task_id: "a" }), run("r2", { task_id: "b", updated_at: NOW - 3 * DAY })],
      decisions: [card("d1", { created_at: NOW - 2 * HOUR })],
    });
    expect(text(f)).toBe("1 card waits on you, oldest 2h, 1 building, 1 stalled 3d");
  });
  it("ends calm when nothing waits", () => {
    expect(text(flow({ tasks: [cause("a")], runs: [run("r1", { task_id: "a" })] }))).toBe("1 building, nothing waiting on you");
    expect(text(flow({ tasks: [cause("a", { status: "done", closed_at: NOW - 9 * DAY })] }))).toBe("The line is quiet: nothing building, nothing waiting on you");
    expect(text(flow({ runs: [run("r1")] }))).toBe("Nothing has reached the line yet");
    expect(text(flow({}))).toBe("Nothing has reached the line yet");
  });
  it("points the actionable parts at their stations and says all clear in its own tone", () => {
    const parts = lineHeadline(flow({ tasks: [cause("a"), cause("b")] }), NOW);
    expect(parts.map((p) => [p.text, p.tone, p.station ?? null])).toEqual([
      ["2 causes queued", "live", "causes"],
      ["nothing waiting on you", "clear", null],
    ]);
  });
});

describe("groupBuild", () => {
  const live = (id: string, label: string) => run(id, { task_id: id, current_node_id: label, node_statuses: [{ node_id: label, status: "running", started_at: NOW - HOUR }] });
  it("groups a step only when it holds two runs; a lone run carries its step as a chip", () => {
    const f = flow({ tasks: ["a", "b", "c"].map((id) => cause(id)), runs: [live("a", "implement"), live("b", "implement"), live("c", "verify")] });
    const blocks = groupBuild(f.build.items);
    expect(blocks.map((b) => [b.label, b.rows.map((r) => [r.run._id, r.chip, r.order])])).toEqual([
      ["implement", [["a", null, 0], ["b", null, 1]]],
      [null, [["c", "verify", 2]]],
    ]);
  });
  it("places a line run on its five step stepper; other workflows have no place", () => {
    const f = flow({ tasks: ["a", "b", "c"].map((id) => cause(id)), runs: [{ ...live("a", "implement"), workflow_name: "line" }, { ...live("b", "card_write"), workflow_name: "line" }, { ...live("c", "implement"), workflow_name: "feature" }] });
    expect(Object.fromEntries(f.build.items.map((b) => [b.run._id, b.stepIndex]))).toEqual({ a: 2, b: 4, c: null });
  });
});

describe("per project lines (line-profile.md LP1, LP3)", () => {
  const rows = {
    tasks: [
      cause("a", { project_id: "pA" }),
      cause("b", { project_id: "pA" }),
      cause("c", { project_id: "pB" }),
      cause("d"),
      { _id: "plain", title: "plain task", status: "open", created_at: NOW, project_id: "pA" },
    ] as LineCauseTask[],
    signals: [
      signal("s1", { task_id: "a", project_id: "pA", source: "agentwatch" }),
      signal("s2", { task_id: "c", project_id: "pB", source: "union.error" }),
      // Filed before signals carried a project: it follows its cause.
      signal("s3", { task_id: "b", source: "agentwatch" }),
      signal("s4", { task_id: "d", source: "person" }),
    ],
    runs: [run("r1", { task_id: "a" }), run("r2", { task_id: "plain" }), run("r3", { task_id: "c" })],
    decisions: [card("k1", { task_id: "c" }), card("k2")],
  };
  const projects: LineProject[] = [
    { _id: "pA", short_id: "pj-a", title: "Agent Quality", line_profile: { finders: [
      { id: "clusters", source: "agentwatch", kind: ["prompt_miss", "bug"] },
      { id: "guards", source: "union.guard", kind: ["prompt_miss"], runs: "daily" },
    ], root: "/src/union", default: true, changed_at: NOW } },
    { _id: "pB", short_id: "pj-b", title: "Infrastructure", project_path: "/src/infra" },
    { _id: "pC", short_id: "pj-c", title: "Quiet" },
  ];

  it("scopes causes, signals, runs and cards to one project", () => {
    const a = scopeLine(rows, "pA");
    expect(a.tasks.map((t) => t._id)).toEqual(["a", "b", "plain"]);
    expect(a.signals.map((s) => s._id)).toEqual(["s1", "s3"]);
    expect(a.runs.map((r) => r._id)).toEqual(["r1", "r2"]);
    expect(a.decisions).toEqual([]);
    const none = scopeLine(rows, NO_PROJECT);
    expect([none.tasks.map((t) => t._id), none.signals.map((s) => s._id)]).toEqual([["d"], ["s4"]]);
    expect(scopeLine(rows, ALL_PROJECTS)).toBe(rows);
  });

  it("a declared finder is a Sense row even when silent, and an undeclared source is flagged", () => {
    const f = flow({ ...scopeLine(rows, "pA"), finders: projects[0].line_profile!.finders });
    const bySource = Object.fromEntries(f.sense.items.map((s) => [s.source, s]));
    expect(bySource.agentwatch).toMatchObject({ day: 2, silent: false, undeclared: false, finder: { id: "clusters" } });
    expect(bySource["union.guard"]).toMatchObject({ day: 0, week: 0, newest: null, silent: true, finder: { id: "guards" } });
    expect(f.sense.state.why).toBe("signals arriving, 1 of 2 finders silent");
    const loose = flow({ signals: [signal("x", { source: "person" })], finders: [{ id: "g", source: "union.guard", kind: "any" }] });
    expect(loose.sense.items.find((s) => s.source === "person")?.undeclared).toBe(true);
  });

  it("the roll-up counts each line, busiest first, no project last", () => {
    const r = lineRollup(rows, projects, NOW);
    expect(r.map((x) => [x.key, x.causes, x.build, x.awaiting, x.signalsDay, x.finders, x.silent])).toEqual([
      ["pA", 1, 1, 0, 2, 2, 1],
      ["pB", 0, 1, 1, 1, 0, 0],
      [NO_PROJECT, 1, 0, 0, 1, 0, 0],
    ]);
  });

  it("opens on the repo's project, else the busiest line", () => {
    const r = lineRollup(rows, projects, NOW);
    expect(defaultLineKey(r, projects, "/src/union/outreach")).toBe("pA");
    expect(defaultLineKey(r, projects, "/src/infra")).toBe("pB");
    expect(defaultLineKey(r, projects, "/elsewhere")).toBe("pA");
    expect(defaultLineKey([], projects, null)).toBe(ALL_PROJECTS);
  });
});
