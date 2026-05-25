import { describe, expect, test } from "bun:test";
import { parseInteractivePrompt, jsonlHasPendingAskUserQuestion } from "./daemon.js";

// Regression coverage for dropped Q&A descriptions: Claude Code's AskUserQuestion
// menu renders each option's description on indented continuation lines BELOW the
// numbered label. The parser used to capture only same-line (2-space) descriptions
// and treated the indented continuation lines as "gaps", so every multi-line
// description was discarded — the web/mobile UIs rendered bare option pills.
describe("parseInteractivePrompt option descriptions", () => {
  test("captures multi-line indented descriptions from a real AskUserQuestion menu", () => {
    const menu = [
      "How do you want to proceed?",
      "─────",
      "□ Rollout",
      "",
      "How should I roll out and verify the new Sessions page?",
      "",
      "❯ 1. Deploy + restart now",
      "     Deploy convex functions, restart the daemon, and deploy web — then I screenshot the live page to confirm buckets render.",
      "     Note: daemon restart resets idle counters, so 'Idle 2h+' is empty for ~2h.",
      "  2. Convex + web only, no restart",
      "     Deploy the additive schema/functions and web now (safe, no disruption), but leave the daemon for you to restart later at",
      "     a quiet moment. Page shows correct buckets once the daemon emits the new fields.",
      "  3. Hold — commit only",
      "     Don't deploy or restart anything. I commit the change to a branch and you deploy on your own schedule.",
      "  4. Just leave it uncommitted",
      "     Stop here. Changes stay in the working tree for you to review the diff first.",
      "  5. Type something.",
      "─────────────",
      "  6. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ].join("\n");

    const prompt = parseInteractivePrompt(menu);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe("How should I roll out and verify the new Sessions page?");
    expect(prompt!.options).toEqual([
      {
        label: "Deploy + restart now",
        description:
          "Deploy convex functions, restart the daemon, and deploy web — then I screenshot the live page to confirm buckets render. Note: daemon restart resets idle counters, so 'Idle 2h+' is empty for ~2h.",
      },
      {
        label: "Convex + web only, no restart",
        description:
          "Deploy the additive schema/functions and web now (safe, no disruption), but leave the daemon for you to restart later at a quiet moment. Page shows correct buckets once the daemon emits the new fields.",
      },
      {
        label: "Hold — commit only",
        description:
          "Don't deploy or restart anything. I commit the change to a branch and you deploy on your own schedule.",
      },
      {
        label: "Just leave it uncommitted",
        description: "Stop here. Changes stay in the working tree for you to review the diff first.",
      },
      { label: "Type something.", description: undefined },
      { label: "Chat about this", description: undefined },
    ]);
  });

  test("still parses same-line descriptions (legacy 2-space format)", () => {
    const menu = [
      "Pick an instance type",
      "❯ 1. mac2-m2pro.metal    fastest, most expensive",
      "  2. mac2.metal          cheapest",
      "Enter to select · Esc to cancel",
    ].join("\n");

    const prompt = parseInteractivePrompt(menu);
    expect(prompt!.options).toEqual([
      { label: "mac2-m2pro.metal", description: "fastest, most expensive" },
      { label: "mac2.metal", description: "cheapest" },
    ]);
  });

  test("options without descriptions stay description-free", () => {
    const menu = [
      "instance type?",
      "❯ 1. mac2-m2pro.metal",
      "  2. mac2-m2.metal",
      "  3. mac2.metal (cheapest)",
      "Enter to select · Esc to cancel",
    ].join("\n");

    const prompt = parseInteractivePrompt(menu);
    expect(prompt!.options).toEqual([
      { label: "mac2-m2pro.metal", description: undefined },
      { label: "mac2-m2.metal", description: undefined },
      { label: "mac2.metal (cheapest)", description: undefined },
    ]);
  });
});

// The real AskUserQuestion tool_use lands in the JSONL (full fidelity) while the
// prompt blocks, so the daemon must NOT also emit a degraded scraped card. This
// drives that decision: a scrape defers iff the latest AskUserQuestion is unanswered.
describe("jsonlHasPendingAskUserQuestion", () => {
  const ask = (id: string) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "AskUserQuestion", id, input: { questions: [{ header: "Rollout", question: "q?", options: [{ label: "A", description: "desc" }] }] } }] },
    });
  const answer = (id: string) =>
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: 'Your questions have been answered: "q?"="A"' }] } });
  const text = (t: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

  test("pending tool_use with no result → true", () => {
    expect(jsonlHasPendingAskUserQuestion([text("working"), ask("toolu_1")].join("\n"))).toBe(true);
  });

  test("answered tool_use → false", () => {
    expect(jsonlHasPendingAskUserQuestion([ask("toolu_1"), answer("toolu_1"), text("moving on")].join("\n"))).toBe(false);
  });

  test("no AskUserQuestion at all → false", () => {
    expect(jsonlHasPendingAskUserQuestion([text("hello"), text("world")].join("\n"))).toBe(false);
  });

  test("latest is pending even if an earlier one was answered → true", () => {
    expect(jsonlHasPendingAskUserQuestion([ask("toolu_1"), answer("toolu_1"), ask("toolu_2")].join("\n"))).toBe(true);
  });

  test("tolerates a truncated/garbage leading line (tail cut mid-line)", () => {
    const garbage = '{"type":"assistant","message":{"content":[{"type":"tool_us';
    expect(jsonlHasPendingAskUserQuestion([garbage, ask("toolu_9")].join("\n"))).toBe(true);
  });

  test("empty input → false", () => {
    expect(jsonlHasPendingAskUserQuestion("")).toBe(false);
  });
});
