import { expect, test } from "bun:test";
import { problemSources, runNext, sourceChipWords } from "../stepRuns";

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
  expect(m.get("t1")).toEqual({ source: "agentwatch", judge: "comms_judge", by: null, findings: 4, others: 1 });
  expect(sourceChipWords(m.get("t1")!)).toBe("AgentWatch · comms judge");
  expect(sourceChipWords(m.get("t2")!)).toBe("Sentry");
  expect(sourceChipWords({ source: "judge:comms", judge: "comms" })).toBe("Comms judge");
  expect(sourceChipWords({ source: "person", judge: null, findings: 1, others: 0 })).toBe("Person");
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
