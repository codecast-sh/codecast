import { describe, expect, test } from "bun:test";
import { DAY, type FunnelRun, type FunnelTask } from "./lineFunnel";
import {
  BACKLOG_ITEM_CAP, backlogItem, backlogItemsOf, backlogStand, coverageTotals, flowEvents, foldBacklog, foldCoverage, foldDays, momentCoverage, recordingCoverage,
  type BacklogItem,
} from "./lineVolume";

const NOW = Date.UTC(2026, 10, 11, 12);
const HOUR = 3_600_000;
type T = FunnelTask & { project_id?: string | null };
const task = (o: Partial<T> = {}): T => ({ _id: "t1", short_id: "ct-1", title: "A problem", status: "open", created_at: NOW - 60 * DAY, project_id: "p1", readiness: "ready", goal_ref: "g", ...o });
const run = (o: Partial<FunnelRun> & { updated_at?: number; created_at?: number; nodes?: Array<[string, number]> } = {}) => ({
  _id: "r1", status: "running", current_node_id: "build", graph_nodes: [], updated_at: NOW - HOUR, created_at: NOW - 2 * HOUR,
  node_statuses: (o.nodes ?? []).map(([node_id, at]) => ({ node_id, status: "completed", started_at: at - 1, completed_at: at })), ...o,
});
const stand = (t: T, r: ReturnType<typeof run> | null, extra: Partial<Parameters<typeof backlogStand>[0]> = {}) => backlogStand({ task: t, run: r, now: NOW, ...extra });

describe("backlogStand", () => {
  test("before a run, ownership comes first: no project, then a project with no lead", () => {
    expect(stand(task({ project_id: null, readiness: undefined }), null, { owned: false })).toBe("noproject");
    expect(stand(task({ readiness: undefined }), null, { owned: false })).toBe("nolead");
  });
  test("an owned problem is held by its source, its readiness, its goal, then the bar, else eligible", () => {
    expect(stand(task(), null, { owned: true, sourceTaken: false })).toBe("offsource");
    expect(stand(task({ readiness: "needs_context" }), null, { owned: true })).toBe("notready");
    expect(stand(task({ goal_ref: " " }), null, { owned: true })).toBe("nogoal");
    expect(stand(task({ cause: { scored: { score: 10 } } }), null, { owned: true, bar: { score: 50, findings: 3 } })).toBe("underbar");
    expect(stand(task(), null, { owned: true })).toBe("eligible");
    expect(stand(task({ status: "in_progress" }), null)).toBe("inhand");
  });
  test("a live run is running, waiting on a person, ready to land, or stalled after eight quiet hours", () => {
    expect(stand(task(), run())).toBe("running");
    expect(stand(task(), run({ status: "paused", current_node_id: "decide" }))).toBe("waiting");
    expect(stand(task(), run(), { waiting: true })).toBe("waiting");
    expect(stand(task(), run({ status: "paused", current_node_id: "ready_to_land" }))).toBe("land");
    expect(stand(task(), run({ updated_at: NOW - 9 * HOUR }))).toBe("stalled");
  });
  test("an ended run on a still open problem: failed, under watch, merge left to a person, or other", () => {
    expect(stand(task(), run({ status: "failed" }))).toBe("failed");
    expect(stand(task(), run({ status: "cancelled" }))).toBe("failed");
    expect(stand(task({ watch_until: NOW + DAY }), run({ status: "completed" }))).toBe("watching");
    expect(stand(task(), run({ status: "completed", node_statuses: [{ node_id: "merge", status: "completed", result_preview: "merge left to a person: switch off" }] }))).toBe("land");
    expect(stand(task(), run({ status: "completed", current_node_id: "exit" }))).toBe("other");
  });
});

describe("backlogItem", () => {
  test("only open problems that stand on their own", () => {
    const labels = new Map([["build", "Build"]]);
    expect(backlogItem({ task: task({ status: "done" }), run: null, labels, now: NOW })).toBeNull();
    expect(backlogItem({ task: task({ cause: { merged_into: "x" } }), run: null, labels, now: NOW })).toBeNull();
    expect(backlogItem({ task: task(), run: run(), labels, now: NOW })).toMatchObject({ stand: "running", node: "Build", project: "p1", run: "r1" });
  });
});

describe("flowEvents and foldDays", () => {
  test("a run started today on an old problem counts today; a landing counts when its landing station completed", () => {
    const e = flowEvents(task({ status: "done", watch_until: NOW - HOUR, closed_at: NOW - 3 * DAY }), run({ status: "completed", created_at: NOW - 2 * HOUR, nodes: [["merge", NOW - 3 * DAY]] }), NOW)!;
    expect(e).toMatchObject({ opened: NOW - 60 * DAY, ran: NOW - 2 * HOUR, landed: NOW - 3 * DAY, clean: NOW - HOUR });
    const days = foldDays([e], NOW);
    expect(days).toHaveLength(30);
    expect(days.at(-1)).toMatchObject({ ran: 1, clean: 1, opened: 0 });
    expect(days.at(-4)!.landed).toBe(1);
  });
  test("a merge left to a person never counts as landed", () => {
    const r = run({ status: "completed", node_statuses: [{ node_id: "merge", status: "completed", completed_at: NOW - HOUR, result_preview: "merge left to a person: red checks" }] });
    expect(flowEvents(task(), r, NOW)!.landed).toBeUndefined();
  });
});

describe("foldBacklog", () => {
  const it = (i: number, o: Partial<BacklogItem>): BacklogItem => ({ task: `t${i}`, ref: null, title: "p", run: null, at: NOW - i, stand: "nolead", node: null, status: null, project: "p1", ...o });
  test("counts every problem by stand and project, largest first, and keeps a capped list per stand", () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => it(i, {})),
      ...Array.from({ length: 3 }, (_, i) => it(100 + i, { stand: "running", node: "Build", run: "r" })),
      it(200, { stand: "noproject", project: null }),
    ];
    const b = foldBacklog({ items, events: [], now: NOW });
    expect(b.total).toBe(34);
    expect(b.stands).toEqual([{ stand: "nolead", n: 30 }, { stand: "running", n: 3 }, { stand: "noproject", n: 1 }]);
    expect(b.projects[0]).toEqual({ project: "p1", stand: "nolead", n: 30 });
    expect(b.projects.find((p) => p.stand === "noproject")).toEqual({ project: null, stand: "noproject", n: 1 });
    expect(b.stations).toEqual([{ stand: "running", node: "Build", n: 3 }]);
    expect(backlogItemsOf(b, "nolead")).toHaveLength(BACKLOG_ITEM_CAP);
    expect(backlogItemsOf(b, "nolead", "p1")[0].task).toBe("t0");
  });
});

describe("coverage", () => {
  test("a moment is judged, failed (extract or judge), or still waiting", () => {
    expect(momentCoverage({ created_at: NOW, status: "ready", judged_at: NOW }, "ok")).toMatchObject({ arrived: 1, read: 1, judged: 1, failed: 0, waiting: 0 });
    expect(momentCoverage({ created_at: NOW, status: "ready", judged_at: NOW }, "failed")).toMatchObject({ judged: 0, failed: 1 });
    expect(momentCoverage({ created_at: NOW, status: "failed" }, null)).toMatchObject({ failed: 1, read: 0 });
    expect(momentCoverage({ created_at: NOW, status: "ready" }, null)).toMatchObject({ waiting: 1, read: 1 });
    expect(recordingCoverage({ started_at: NOW })).toMatchObject({ arrived: 1, read: 0 });
    expect(recordingCoverage({ started_at: NOW, imported_at: NOW })).toMatchObject({ read: 1 });
  });
  test("recounts days from `from`, keeps older days of the last row, drops days outside the window", () => {
    const day = (d: number) => new Date(NOW - d * DAY).toISOString().slice(0, 10);
    const prev = [{ source_id: "s", kind: "conversation", days: [
      { day: day(40), arrived: 9, read: 9, judged: 9, failed: 0, waiting: 0 },
      { day: day(5), arrived: 4, read: 4, judged: 3, failed: 1, waiting: 0 },
      { day: day(0), arrived: 1, read: 0, judged: 0, failed: 0, waiting: 1 },
    ] }];
    const one = { arrived: 1, read: 1, judged: 1, failed: 0, waiting: 0 };
    const rows = [{ source_id: "s", kind: "conversation", day: day(0), ...one }, { source_id: "s", kind: "conversation", day: day(0), ...one }, { source_id: "s", kind: "conversation", day: day(5), ...one }];
    const out = foldCoverage({ prev, from: NOW - DAY, now: NOW, rows });
    expect(out[0].days.map((d) => [d.day, d.arrived, d.judged])).toEqual([[day(5), 4, 3], [day(0), 2, 2]]);
    expect(coverageTotals(out[0], NOW, 1)).toMatchObject({ arrived: 2, judged: 2 });
    expect(coverageTotals(out[0], NOW, 7)).toMatchObject({ arrived: 6, judged: 5, failed: 1 });
  });
});
