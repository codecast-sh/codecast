import { expect, test } from "bun:test";
import { problemOrigins, problemSources, runNext, sourceChipWords } from "../stepRuns";

const d = (reasoning: string | null, words: string, result: Record<string, unknown> | null = null, toLabel: string | null = null) => ({
  reasoning, status: "done" as const, closed: null, caseTitle: "Fee answer invents structure", decided: { outcome: null, words, result, to: toLabel ? "x" : null, toLabel, toWords: null },
});

test("a problem's source is the one most of its findings name, with that source's commonest judge", () => {
  const m = problemSources([
    { source: "agentwatch", judge: "comms_judge", task_id: "t1" },
    { source: "agentwatch", judge: "comms_judge", task_id: "t1" },
    { source: "agentwatch", judge: "fee-judge", task_id: "t1" },
    { source: "person", task_id: "t1" },
    { source: "sentry", task_id: "t2" },
  ]);
  expect(m.get("t1")).toEqual({
    source: "agentwatch", judge: "comms_judge", by: null, findings: 4, others: 1,
    all: [{ source: "agentwatch", n: 3 }, { source: "person", n: 1 }], judges: ["agentwatch/comms_judge", "agentwatch/fee-judge"],
  });
  expect(sourceChipWords(m.get("t1")!)).toBe("AgentWatch comms judge");
  expect(sourceChipWords(m.get("t2")!)).toBe("Sentry");
  expect(sourceChipWords({ source: "judge:comms", judge: "comms" })).toBe("Codecast comms judge");
  expect(sourceChipWords({ source: "person", judge: null, findings: 1, others: 0 })).toBe("Person");
});

test("one reading for every surface: findings, else kept quotes, else who filed it by hand", () => {
  const m = problemOrigins({
    signals: [{ source: "sentry", task_id: "t1" }],
    issues: [{ id: "t2", findings: 3, quotes: [{ source: "AgentWatch" }, { source: "AgentWatch" }] }],
    tasks: [{ _id: "t3", source: "manual", user_id: "u1" }, { _id: "t4", source: "signal" }],
    isCause: () => true,
    names: new Map([["u1", "Ashot Petrosian"]]),
  });
  expect(m.get("t1")!.all).toEqual([{ source: "sentry", n: 1 }]);
  expect(m.get("t2")).toMatchObject({ source: "AgentWatch", all: [{ source: "AgentWatch", n: 2 }] });
  expect(m.get("t3")).toMatchObject({ source: "person", by: "Ashot", all: [{ source: "person", n: 0 }] });
  expect(m.has("t4")).toBe(false);
  // A problem whose findings all left it (withdrawn when a run closed it as the judge's mistake) still names the source that raised it.
  const gone = problemOrigins({ signals: [], issues: [], tasks: [{ _id: "t4", source: "signal" }], isCause: () => true, occurrences: [{ task_id: "t4", sources: ["judge:match"] }, { task_id: "t5", sources: [] }] });
  expect(gone.get("t4")).toMatchObject({ source: "judge:match", findings: 0, all: [{ source: "judge:match", n: 0 }] });
  expect(sourceChipWords(gone.get("t4")!)).toBe("Codecast match judge");
  expect(gone.has("t5")).toBe(false);
});

test("a person's finding names who filed it", () => {
  const m = problemSources([{ source: "person", task_id: "t1", user_id: "u1" }, { source: "person", task_id: "t1", user_id: "u2" }, { source: "person", task_id: "t1", user_id: "u1" }], new Map([["u1", "Ashot Petrosian"], ["u2", "dana@x.org"]]));
  expect(m.get("t1")?.by).toBe("Ashot");
  expect(sourceChipWords(m.get("t1")!)).toBe("Person · Ashot");
});

test("where the run went next, or null when it ended at the step", () => {
  expect(runNext(d(null, "Done", null, "Dissolve"))).toBe("Dissolve");
  expect(runNext(d(null, "Done"))).toBeNull();
});
