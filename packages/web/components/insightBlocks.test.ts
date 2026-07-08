import { test, expect, describe } from "bun:test";
import { parseInsightBlocks, cleanInsightLabel } from "./insightBlocks";

const insightsOf = (s: string) =>
  parseInsightBlocks(s).filter((p): p is { type: "insight"; label: string; content: string } => p.type === "insight");

describe("parseInsightBlocks — surface forms the model actually emits", () => {
  test("canonical backtick-wrapped rule lines", () => {
    const r = insightsOf("intro\n\n`★ Insight ─────────────`\n- a\n- b\n`─────────────`\nafter");
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("Insight");
    expect(r[0].content).toBe("- a\n- b");
  });

  test("bare header with no backticks (most common miss)", () => {
    const r = insightsOf("\n★ Insight ─────────────\nThe current design tries X.\n─────────────");
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("The current design tries X.");
  });

  test("**bold**-wrapped rule lines", () => {
    const r = insightsOf("**★ Insight ─────────────**\n- a\n- b\n**─────────────**");
    expect(r).toHaveLength(1);
  });

  test("lone \\r line breaks (the screenshot case) — normalized, bullets become list items", () => {
    const cr = "pre\n\n★ Insight ─────────────\r• static checks\r  wrap line\r─────────────";
    const r = insightsOf(cr);
    expect(r).toHaveLength(1);
    expect(r[0].content).toBe("- static checks\n  wrap line");
  });

  test("custom title after the star surfaces as the label", () => {
    const r = insightsOf("`★ Insight ─ Why it broke ─────────────`\n- reason one\n`─────────────`");
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe("Why it broke");
  });
});

describe("parseInsightBlocks — does not over-match", () => {
  test.each([
    ["markdown table", "| col | col |\n| --- | --- |\n| a | b |"],
    ["thematic break", "text\n\n---\n\nmore text"],
    ["prose mention of the format", "the `★ Insight ─────` block sometimes renders as plain text"],
    ["open-ended titled header with no closing rule", "`★ Insight ─ The path-key mismatch ───────────`\nbody flows on with no closing rule line"],
  ])("%s yields no insight card", (_label: string, input: string) => {
    expect(insightsOf(input)).toHaveLength(0);
  });
});

describe("cleanInsightLabel", () => {
  test("strips surrounding rule chars and defaults empty to 'Insight'", () => {
    expect(cleanInsightLabel("Insight")).toBe("Insight");
    expect(cleanInsightLabel("─── ───")).toBe("Insight");
    expect(cleanInsightLabel("Insight ─ The fork-resume bug")).toBe("The fork-resume bug");
  });
});
