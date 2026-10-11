import { expect, test } from "bun:test";
import { problemSources, runNext, runOutput, sourceChipWords } from "../stepRuns";

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
  expect(m.get("t1")).toEqual({ source: "agentwatch", judge: "comms_judge", findings: 4, others: 1 });
  expect(sourceChipWords(m.get("t1")!)).toBe("AgentWatch · comms judge");
  expect(sourceChipWords(m.get("t2")!)).toBe("Sentry");
});

test("what a run put out is its own words, never a bare finished word or the problem's title", () => {
  expect(runOutput(d(null, "Done"))).toBeNull();
  expect(runOutput(d(null, "handed on"))).toBeNull();
  expect(runOutput(d(null, "Fee answer invents structure"))).toBeNull();
  expect(runOutput({ ...d(null, "Sent back"), decided: { ...d(null, "Sent back").decided, outcome: "sent back" } })).toBeNull();
  expect(runOutput(d(null, "claimed ct-57382 for run a1"))).toBe("claimed ct-57382 for run a1");
  expect(runOutput(d("## Finding\nThe rep asked for a percentage instead of the value track.", "Done"))).toBe("The rep asked for a percentage instead of the value track.");
});

test("where the run went next, or null when it ended at the step", () => {
  expect(runNext(d(null, "Done", null, "Dissolve"))).toBe("Dissolve");
  expect(runNext(d(null, "Done"))).toBeNull();
});
