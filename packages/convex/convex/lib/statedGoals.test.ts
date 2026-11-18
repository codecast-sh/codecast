import { describe, expect, test } from "bun:test";
import { pickStatedGoals, picksOf, statedGoalsRequests, STATED_GOAL_CAPS, type GoalCandidate } from "./statedGoals";

const c = (i: number, text: string): GoalCandidate => ({ kind: "plan", at: i, by: "Ashot", where: `pl-${i}`, text });

describe("stated goals", () => {
  test("a pick keeps the person's own words: the span its quote copies, and nothing for a quote they never said", () => {
    const cands = [c(0, "Breadth gets about 20% of the buy budget, the rest ranks by expected fee. Also merged ct-1."), c(1, "Status: green")];
    const reply = JSON.stringify({ goals: [{ i: 0, quote: "Breadth gets about 20% of the buy budget, the rest ranks by expected fee." }, { i: 1, quote: "made up" }, { i: 0, quote: "dup" }, { i: 7, quote: "out of range" }] });
    expect(picksOf(reply, cands, 0, 2)).toEqual([
      { at: 0, by: "Ashot", line: "Breadth gets about 20% of the buy budget, the rest ranks by expected fee.", where: "pl-0", kind: "plan" },
    ]);
    // No answer, or one cut off before its list closed, is no reading at all.
    expect(picksOf(null, cands, 0, 2)).toBeNull();
    expect(picksOf('{"goals": [{"i": 0, "sets": "budget", "quote": "Breadth', cands, 0, 2)).toBeNull();
    // A quote that misses does not use up its line: a later pick of the same line still lands.
    expect(picksOf(JSON.stringify({ goals: [{ i: 1, quote: "made up" }, { i: 1, quote: "Status: green" }] }), cands, 0, 2)).toEqual([{ at: 1, by: "Ashot", line: "Status: green", where: "pl-1", kind: "plan" }]);
    // A list the model re-flowed onto one line is still the person's words.
    expect(picksOf(JSON.stringify({ goals: [{ i: 0, quote: "Goals:  - Win the Bay" }] }), [c(0, "Goals:\n- Win the Bay\n- Hire")], 0, 1)[0].line).toBe("Goals:\n- Win the Bay");
  });

  test("candidates split into chunks numbered globally, each under structured output", () => {
    const big = "x".repeat(STATED_GOAL_CAPS.candidate_chars);
    const cands = Array.from({ length: Math.ceil((STATED_GOAL_CAPS.chunk_chars * 2) / big.length) + 1 }, (_, i) => c(i, big));
    const chunks = statedGoalsRequests(cands, "Union");
    expect(chunks.length).toBe(3);
    expect(chunks[1].req.prompt).toContain(`[${chunks[1].from}] plan decision · pl-${chunks[1].from}`);
    expect(chunks.every((ch) => ch.req.output_schema && ch.req.model === "claude-sonnet-5-5")).toBe(true);
    expect(chunks.at(-1)!.to).toBe(cands.length);
  });

  test("a chunk whose read fails costs its picks and marks the read truncated; nothing to read asks nothing", async () => {
    let asked = 0;
    expect(await pickStatedGoals([], false, "Union", async () => { asked++; return null; })).toEqual({ lines: [], truncated: false });
    expect(asked).toBe(0);
    const out = await pickStatedGoals([c(0, "Win the Bay Area")], false, "Union", async () => { throw new Error("down"); });
    expect(out).toEqual({ lines: [], truncated: true });
    const fine = await pickStatedGoals([c(0, "Win the Bay Area")], false, "Union", async () => JSON.stringify({ goals: [{ i: 0, sets: "region", quote: "Win the Bay Area" }] }));
    expect(fine).toEqual({ lines: [{ at: 0, by: "Ashot", line: "Win the Bay Area", where: "pl-0", kind: "plan" }], truncated: false });
  });
});
