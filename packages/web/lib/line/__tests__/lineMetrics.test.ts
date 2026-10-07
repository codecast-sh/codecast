import { describe, expect, test } from "bun:test";
import type { LineCauseTask, LineSignal } from "../../lineFlow";
import { dissolveKind, expectationBreaks, explainedShare, fixesThatHold, judgeDefectCauses, lineMetrics, type MetricsRun } from "../lineMetrics";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;
const week = { from: NOW - 7 * DAY, to: NOW };

let n = 0;
const signal = (over: Partial<LineSignal>): LineSignal => ({
  _id: `sg-${++n}`, source: "agentwatch", kind: "prompt_miss", title: "t", observed_at: NOW - DAY, created_at: NOW - DAY, task_id: "ct-1", ...over,
});
const cause = (over: Partial<LineCauseTask>): LineCauseTask => ({
  _id: `ct-${++n}`, title: "c", status: "done", created_at: NOW - 30 * DAY, cause: { signal_count: 1, first_seen: 0, last_seen: 0, fingerprints: [] }, ...over,
});
const run = (task_id: string, endNode: string, at: number, preview?: string): MetricsRun => ({
  task_id,
  node_statuses: [
    { node_id: "ground", status: "completed", completed_at: at - 2 },
    { node_id: "prove", status: "completed", completed_at: at - 1 },
    { node_id: endNode, status: "completed", completed_at: at, result_preview: preview },
  ],
});

describe("explainedShare", () => {
  test("fingerprint and judge attaches over everything the attach step placed, in the window", () => {
    const rows = [
      signal({ attach: "fingerprint" }),
      signal({ attach: "judge" }),
      signal({ attach: "judge" }),
      signal({ attach: "new" }),
      signal({ attach: "person" }),
      signal({ attach: "new", created_at: NOW - 8 * DAY }),
    ];
    expect(explainedShare(rows, week)).toEqual({ explained: 3, opened: 1, share: 0.75 });
  });

  test("no signals is no number, not zero", () => {
    expect(explainedShare([], week).share).toBeNull();
  });
});

describe("fixesThatHold", () => {
  test("watches that ended quiet over every watch that ended, a reopen dated by its signal", () => {
    const tasks = [
      cause({ resolved_at: NOW - 2 * DAY, closed_at: NOW - 9 * DAY }),
      cause({ watch_until: NOW - DAY, closed_at: NOW - 8 * DAY }),
      cause({ watch_until: NOW + DAY, closed_at: NOW - 6 * DAY }),
      cause({ resolved_at: NOW - 10 * DAY, closed_at: NOW - 17 * DAY }),
      cause({ status: "open" }),
    ];
    const signals = [signal({ reopened: true }), signal({ reopened: true, created_at: NOW - 9 * DAY }), signal({})];
    expect(fixesThatHold(tasks, signals, week, NOW)).toEqual({ held: 2, reopened: 1, share: 2 / 3 });
  });
});

describe("judge mistakes", () => {
  test("the dissolve station's line says which way it dissolved", () => {
    expect(dissolveKind('{"dissolved": "judge_defect", "moments": 2}')).toBe("judge_defect");
    expect(dissolveKind('noise\n{"dissolved": "no_repro"}')).toBe("no_repro");
    expect(dissolveKind("Dissolved.")).toBeNull();
    expect(dissolveKind(undefined)).toBeNull();
  });

  test("a cause counts when its latest line run dissolved as the judge's mistake", () => {
    const runs = [
      run("ct-a", "dissolve", NOW - DAY, '{"dissolved": "judge_defect", "moments": 1}'),
      run("ct-b", "dissolve", NOW - DAY, '{"dissolved": "no_repro"}'),
      run("ct-c", "dissolve", NOW - 3 * DAY, '{"dissolved": "judge_defect", "moments": 1}'),
      run("ct-c", "watch", NOW - DAY),
      run("ct-d", "dissolve", NOW - DAY),
    ];
    expect([...judgeDefectCauses(runs)]).toEqual(["ct-a"]);
  });
});

describe("expectationBreaks", () => {
  test("signals citing an expectation, minus the refuted, per day", () => {
    const rows = [
      signal({ subject: "ex-union-3", task_id: "ct-a" }),
      signal({ subject: "ex-union-4", task_id: "ct-b" }),
      signal({ subject: "ex-union-4", task_id: "ct-b" }),
      signal({ subject: "comms", task_id: "ct-b" }),
      signal({ subject: "ex-union-5", task_id: "ct-b", created_at: NOW - 8 * DAY }),
    ];
    expect(expectationBreaks(rows, new Set(["ct-a"]), week)).toEqual({ breaks: 2, days: 7, perDay: 2 / 7 });
  });
});

test("lineMetrics reads all three over one window", () => {
  const signals = [signal({ subject: "ex-union-1", task_id: "ct-a", attach: "new" }), signal({ subject: "ex-union-1", task_id: "ct-b", attach: "judge" })];
  const m = lineMetrics({ signals, tasks: [], runs: [run("ct-a", "dissolve", NOW - DAY, '{"dissolved": "judge_defect", "moments": 1}')], window: week, now: NOW });
  expect(m.breaks.breaks).toBe(1);
  expect(m.explained.share).toBe(0.5);
  expect(m.holding.share).toBeNull();
});
