import { describe, expect, it } from "bun:test";
import { budgetMonth, budgetWords, modelCallProblem, parseJsonBlock, type BudgetSummary } from "./modelCall";

describe("the model call contract (LL1)", () => {
  it("accepts a well formed call and names what is wrong with one", () => {
    expect(modelCallProblem({ model: "claude-haiku-5-5", max_tokens: 500, prompt: "Grade this.", output: "json" })).toBeNull();
    expect(modelCallProblem({ model: "claude-haiku-5-5", max_tokens: 0, prompt: "x", output: "json" })).toContain("max_tokens");
    expect(modelCallProblem({ model: "claude-haiku-5-5", max_tokens: 10, prompt: " ", output: "json" })).toContain("prompt");
    expect(modelCallProblem({ model: "claude-haiku-5-5", max_tokens: 10, prompt: "x", output: "yaml" as any })).toContain("output");
  });

  it("reads the JSON value an answer starts with, fenced or followed by words", () => {
    expect(parseJsonBlock('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(parseJsonBlock('[] because nothing broke "an expectation" here.')).toEqual([]);
    expect(parseJsonBlock('{"a": "}"} trailing')).toEqual({ a: "}" });
    expect(parseJsonBlock("no json")).toBeNull();
  });
});

describe("the team's model budget (LL10)", () => {
  const base: BudgetSummary = { cap_usd: 20, month: "2026-10", spent_usd: 3.2, held_usd: 0, by_purpose: { judge: 3, grouping: 0.2, call: 0 }, refused: 0, history: [] };

  it("says the month in UTC", () => {
    expect(budgetMonth(Date.parse("2026-10-31T23:59:00Z"))).toBe("2026-10");
  });

  it("says spend against the cap, by purpose, and what it skipped", () => {
    expect(budgetWords(base)).toBe("$3.20 of $20 spent this month (judging $3.00, grouping 20¢).");
    expect(budgetWords({ ...base, refused: 2 })).toBe("$3.20 of $20 spent this month (judging $3.00, grouping 20¢); 2 calls were skipped because it was spent.");
    expect(budgetWords({ ...base, cap_usd: 0, spent_usd: 0, by_purpose: { judge: 0, grouping: 0, call: 0 } })).toBe("Off. Judging and grouping wait until a monthly budget is set.");
  });
});
