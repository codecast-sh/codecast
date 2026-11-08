import { describe, expect, test } from "bun:test";
import { DAY, FUNNEL_ITEM_CAP, foldFunnel, funnelItem, funnelItemsOf, funnelStations, funnelSteps, type FunnelItem, type FunnelRun, type FunnelTask } from "./lineFunnel";

// The onefix graph, as Union's live flow ran it in November 2026.
const N = (id: string, label: string, type: string) => ({ id, label, type });
const nodes = [
  N("bind", "Problem", "command"), N("triage", "Triage", "agent"), N("stopped", "Stopped", "command"), N("harm", "Harm class", "command"),
  N("closed_at_triage", "Closed", "command"), N("queue", "Queue", "command"), N("build", "Build", "agent"), N("critique", "Critique", "parallel_fanout"),
  N("decide", "Decide", "human"), N("push", "Push", "command"), N("ready_to_land", "Ready to land", "command"), N("deploy", "Deploy", "command"),
  N("watch", "Watch", "command"), N("closed_at_build", "Closed", "command"), N("dropped", "Dropped", "command"), N("unfinished", "Not finished", "command"),
  N("c_correctness", "Critique: correctness", "agent"), N("c_reach", "Critique: reach", "agent"), N("critique_done", "Critique in", "parallel_fanin"),
  N("shipped", "Ship", "command"), N("merge", "Merge", "command"), N("exit", "Exit", "exit"),
];
const E = (from: string, ...to: string[]) => to.map((t) => ({ from, to: t }));
const edges = [
  ...E("bind", "triage", "stopped"), ...E("triage", "harm", "closed_at_triage", "stopped"), ...E("stopped", "exit"), ...E("harm", "queue"),
  ...E("closed_at_triage", "exit"), ...E("queue", "build"),
  ...E("build", "critique", "decide", "push", "ready_to_land", "deploy", "watch", "closed_at_build", "dropped", "stopped", "unfinished"),
  ...E("critique", "c_correctness", "c_reach"), ...E("c_correctness", "critique_done"), ...E("c_reach", "critique_done"), ...E("critique_done", "build"),
  ...E("decide", "shipped", "build"), ...E("push", "merge", "build"), ...E("ready_to_land", "build", "stopped"), ...E("deploy", "build"),
  ...E("watch", "exit"), ...E("shipped", "build"), ...E("merge", "build"),
];
const stations = funnelStations(nodes, edges);
const labels = new Map(nodes.map((n) => [n.id, n.label]));
const NOW = Date.UTC(2026, 10, 8, 12);
const level = (key: string) => funnelSteps(stations).findIndex((s) => s.key === key);

const task = (o: Partial<FunnelTask> = {}): FunnelTask => ({ _id: "t1", short_id: "ct-1", title: "A problem", status: "open", created_at: NOW - DAY, ...o });
const done = (...ids: string[]) => ids.map((node_id, i) => ({ node_id, status: "completed", started_at: 1000 + i * 10, completed_at: 1005 + i * 10 }));
const run = (o: Partial<FunnelRun> & { nodes?: string[] } = {}): FunnelRun => ({
  _id: "r1", status: "completed", current_node_id: "exit", graph_nodes: nodes.map((n) => ({ id: n.id })), node_statuses: done(...(o.nodes ?? [])), ...o,
});
const item = (t: FunnelTask, r: FunnelRun | null, waiting = false) => funnelItem({ task: t, run: r, stations, labels, waiting, now: NOW });

describe("funnelStations", () => {
  test("the work stations in graph order, a fan-out for its branches, the landing stations as one, then deploy and watch", () => {
    expect(stations.map((s) => s.label)).toEqual(["Triage", "Build", "Critique", "Decide", "Merge or Ready to land", "Deploy", "Watch"]);
    expect(stations.find((s) => s.key === "critique")!.ids.sort()).toEqual(["c_correctness", "c_reach", "critique", "critique_done"]);
    expect(stations.find((s) => s.key === "land")!.ids.sort()).toEqual(["merge", "push", "ready_to_land"]);
  });
});

describe("funnelItem", () => {
  test("closed at Triage stops at Triage, closed", () => {
    const x = item(task({ status: "done" }), run({ nodes: ["bind", "triage", "closed_at_triage", "exit"] }))!;
    expect([x.level, x.why, x.node]).toEqual([level("triage"), "closed", "Closed"]);
  });

  test("a run standing at the queue has passed Triage and is still moving", () => {
    const r = run({ status: "running", current_node_id: "queue", nodes: ["bind", "triage", "harm"] });
    const x = item(task(), r)!;
    expect([x.level, x.why, x.node, x.status]).toEqual([level("triage"), "here", "Queue", "running"]);
  });

  test("a run paused at the card waits on a person at Decide", () => {
    const r = run({ status: "paused", current_node_id: "decide", nodes: ["bind", "triage", "harm", "queue", "build", "critique", "c_reach", "critique_done"] });
    expect(item(task(), r)).toMatchObject({ level: level("decide"), why: "waiting", node: "Decide" });
  });

  test("a branch of the fan-out counts as reaching Critique; skipping it still reaches Critique once it is past", () => {
    const atBranch = run({ status: "running", current_node_id: "c_reach", nodes: ["bind", "triage", "build", "critique"] });
    expect(item(task(), atBranch)!.level).toBe(level("critique"));
    const skipped = run({ status: "running", current_node_id: "deploy__wait", nodes: ["bind", "triage", "build", "push", "merge"] });
    expect(item(task(), skipped)).toMatchObject({ level: level("deploy"), why: "here", node: "Deploy" });
  });

  test("shipped and under watch: live in production, watching", () => {
    const r = run({ nodes: ["bind", "triage", "build", "push", "merge", "deploy", "watch", "exit"] });
    expect(item(task({ status: "done", watch_until: NOW + 3 * DAY }), r)).toMatchObject({ level: level("live"), why: "watching", node: "Watch" });
  });

  test("a run of an older graph with no deploy station is live once it ships", () => {
    const r = run({ graph_nodes: [{ id: "bind" }, { id: "build" }, { id: "decide" }, { id: "watch" }], nodes: ["bind", "build", "decide", "watch", "exit"] });
    expect(item(task({ status: "done", watch_until: NOW + DAY }), r)).toMatchObject({ level: level("live"), why: "watching" });
  });

  test("its watch passed with the task done: closed clean", () => {
    const r = run({ nodes: ["bind", "triage", "build", "push", "merge", "deploy", "watch", "exit"] });
    expect(item(task({ status: "done", watch_until: NOW - DAY }), r)).toMatchObject({ level: level("clean"), why: null });
  });

  test("a watch the sweep ended quiet (resolved_at, watch_until cleared): closed clean", () => {
    const r = run({ nodes: ["bind", "triage", "build", "push", "merge", "deploy", "watch", "exit"] });
    expect(item(task({ status: "done", closed_at: NOW - 9 * DAY, resolved_at: NOW - 2 * DAY }), r)).toMatchObject({ level: level("clean"), why: null });
  });

  test("shipped and reopened: regressed", () => {
    const r = run({ nodes: ["bind", "triage", "build", "push", "merge", "deploy", "watch", "exit"] });
    expect(item(task({ status: "open" }), r)).toMatchObject({ level: level("live"), why: "regressed" });
  });

  test("merge left to a person stops short of merged, waiting", () => {
    const nodes_ = done("bind", "triage", "build", "push", "merge", "deploy", "watch");
    nodes_[4] = { ...nodes_[4], result_preview: "merge left to a person: checks red" } as any;
    const r = run({ node_statuses: nodes_ });
    expect(item(task({ status: "done", watch_until: NOW + DAY }), r)).toMatchObject({ level: level("watch"), why: "waiting" });
  });

  test("failed, cancelled, stopped, dropped", () => {
    expect(item(task(), run({ status: "failed", current_node_id: "build", nodes: ["bind", "triage", "build"] }))!.why).toBe("failed");
    expect(item(task(), run({ status: "cancelled", nodes: ["bind", "triage"] }))!.why).toBe("cancelled");
    expect(item(task(), run({ nodes: ["bind", "triage", "stopped", "exit"] }))!.why).toBe("failed");
    expect(item(task({ status: "dropped" }), run({ nodes: ["bind", "triage", "build", "dropped", "exit"] }))).toMatchObject({ level: level("build"), why: "dropped" });
  });

  test("ready and over the bar with no run: no owner, source not taken, or eligible", () => {
    const ready = task({ readiness: "ready", goal_ref: "in-1" });
    const why = (o: { owned?: boolean; sourceTaken?: boolean }) => funnelItem({ task: ready, run: null, stations, labels, now: NOW, ...o })!.why;
    expect(why({ owned: false })).toBe("unowned");
    expect(why({ owned: false, sourceTaken: false })).toBe("offsource");
    expect(why({ owned: true, sourceTaken: true })).toBe("unstarted");
  });

  test("a closed problem reads closed though its close station was interrupted and the run failed", () => {
    const r = run({ status: "failed", current_node_id: "closed_at_build", node_statuses: [...done("bind", "triage", "harm", "queue", "build"), { node_id: "closed_at_build", status: "failed", started_at: 2000 }] });
    expect(item(task({ status: "done" }), r)).toMatchObject({ level: level("build"), why: "closed", node: "Closed", status: "failed" });
  });

  test("no run: not started when ready and over the bar, held back when not ready or under it; merged into another problem counts nowhere", () => {
    expect(item(task({ readiness: "ready", goal_ref: "in-1" }), null)).toMatchObject({ level: 0, why: "unstarted", run: null, status: null });
    // No goal named yet: the live queue skips it.
    expect(item(task({ readiness: "ready" }), null)!.why).toBe("held");
    expect(item(task({ readiness: "not_ready" }), null)!.why).toBe("held");
    const bar = { score: 60, findings: 3 };
    const at = (t: FunnelTask) => funnelItem({ task: { goal_ref: "in-1", ...t }, run: null, stations, labels, bar, now: NOW })!.why;
    expect(at(task({ readiness: "ready", cause: { scored: { score: 40 }, signal_count: 1 } }))).toBe("held");
    expect(at(task({ readiness: "ready", cause: { scored: { score: 40 }, signal_count: 3 } }))).toBe("unstarted");
    expect(at(task({ readiness: "ready", cause: { scored: { score: 80 }, signal_count: 1 } }))).toBe("unstarted");
    expect(item(task({ cause: { merged_into: "t9" } }), null)).toBeNull();
  });

  test("named by its cause, else its title when the cause's name is blank", () => {
    expect(item(task({ cause: { named: { name: "The broker double-books" } } }), null)!.title).toBe("The broker double-books");
    expect(item(task({ cause: { named: { name: "" } } }), null)!.title).toBe("A problem");
  });

  test("a blocking decision on the run reads as waiting", () => {
    expect(item(task(), run({ status: "running", current_node_id: "build", nodes: ["bind", "triage"] }), true)!.why).toBe("waiting");
  });
});

describe("foldFunnel", () => {
  const mk = (i: number, o: Partial<FunnelItem>): FunnelItem => ({ task: `t${i}`, ref: `ct-${i}`, title: `p${i}`, run: `r${i}`, at: NOW - DAY, level: 1, why: "here", node: null, status: "running", ...o });
  test("counts reach each step, drops split by why, windows by when the problem opened, signals by UTC day", () => {
    const items = [
      mk(1, { level: 0, why: "unstarted", run: null }),
      mk(2, { level: level("triage"), why: "closed" }),
      mk(3, { level: level("triage"), why: "closed", at: NOW - 10 * DAY }),
      mk(4, { level: level("decide"), why: "waiting" }),
      mk(5, { level: level("clean"), why: null }),
    ];
    const sources = [{ key: "sdk:errors", days: [{ day: "2026-11-08", n: 4 }, { day: "2026-11-01", n: 3 }, { day: "2026-10-20", n: 5 }] }, { key: "judge:x", days: [{ day: "2026-11-07", n: 2 }] }];
    const f = foldFunnel({ items, stations, sources, now: NOW });
    const [w7, w30] = f.windows;
    expect(w7.signals).toBe(6);
    expect(w7.sources).toEqual([{ key: "sdk:errors", n: 4 }, { key: "judge:x", n: 2 }]);
    expect(w30.signals).toBe(14);
    const n = (w: typeof w7) => w.steps.map((s) => s.n);
    expect(n(w7)).toEqual([4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1]);
    expect(w7.steps[level("triage")].drops).toEqual({ closed: 1 });
    expect(w30.steps[level("triage")].drops).toEqual({ closed: 2 });
    expect(w7.steps[0].drops).toEqual({ unstarted: 1 });
    expect(funnelItemsOf(f, 7, level("triage")).map((x) => x.task).sort()).toEqual(["t2", "t4", "t5"]);
    expect(funnelItemsOf(f, 30, level("triage"), "closed").map((x) => x.task)).toEqual(["t2", "t3"]);
  });

  test("keeps at most the cap per bucket, newest first, while the counts stay whole", () => {
    const items = Array.from({ length: FUNNEL_ITEM_CAP + 5 }, (_, i) => mk(i, { at: NOW - i * 1000 }));
    const f = foldFunnel({ items, stations, sources: [], now: NOW });
    expect(f.items.length).toBe(FUNNEL_ITEM_CAP);
    expect(f.items[0].task).toBe("t0");
    expect(f.windows[0].steps[1].drops.here).toBe(FUNNEL_ITEM_CAP + 5);
  });
});
