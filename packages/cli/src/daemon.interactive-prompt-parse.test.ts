import { describe, expect, test } from "bun:test";
import { parseInteractivePrompt } from "./daemon.js";

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
