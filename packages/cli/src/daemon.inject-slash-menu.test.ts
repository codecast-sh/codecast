import { describe, expect, test } from "bun:test";
import { tmuxComposerHoldsPayload, tmuxPromptStillHasInput } from "./daemon.js";
import { composerTextStart } from "./tmuxPaneState.js";

// Claude Code's slash-command menu, as captured from v2.1.330 with "/drive"
// typed: the menu sits under the composer's bottom rule and marks its selected
// row with the same ❯ the composer uses. The skill's description names its own
// command, so a reader that took the menu row for the composer saw the payload
// twice and never pressed Enter (2026-11-22).
const RULE = "─".repeat(120);
const slashMenuPane = (typed: string) => [
  " ▐▛███▛█   Claude Code v2.1.330",
  "",
  "❯ an earlier message",
  "",
  "⏺ An earlier reply.",
  "",
  RULE,
  `❯ ${typed}`,
  RULE,
  "  ❯ /drive                    Take an ask from request to shipped. Use when the user types /drive <ask>. …",
  "    /run                      Launch this project's app to see your change working",
  "    /orchestrate              Drive a plan to completion. Use when the user says \"drive this\".",
].join("\n");

describe("Claude Code's slash-command menu is not the composer", () => {
  test("the composer starts at the prompt above the menu, not at the menu's selected row", () => {
    const pane = slashMenuPane("/drive");
    expect(composerTextStart(pane)).toBe(pane.indexOf(`❯ /drive\n${RULE}`) + 1);
  });

  test("a skill command whose description names itself is at the prompt once", () => {
    expect(tmuxComposerHoldsPayload(slashMenuPane("/drive"), "/drive")).toBe(true);
    expect(tmuxPromptStillHasInput(slashMenuPane("/drive"), "/drive")).toBe(true);
  });

  test("a menu row alone is not the payload sitting at the prompt", () => {
    expect(tmuxComposerHoldsPayload(slashMenuPane(""), "/drive")).toBe(false);
    expect(tmuxPromptStillHasInput(slashMenuPane(""), "/drive")).toBe(false);
  });

  // A permission dialog drawn under a lone rule, right after a delivered
  // message: its ❯ is the dialog's, and the transcript turn above the rule
  // must never read as a draft still waiting for Enter (an Enter here picks
  // "1. Yes").
  const dialogPane = (between: string[]) => [
    "❯ please run ls in the repo",
    "",
    "⏺ Bash(ls)",
    "",
    RULE,
    ...between,
    " ❯ 1. Yes",
    "   2. No",
    " Esc to cancel · Tab to amend",
  ].join("\n");

  test("a permission dialog under a lone rule keeps its own ❯", () => {
    for (const pane of [dialogPane([" Do you want to proceed?"]), dialogPane([])]) {
      expect(composerTextStart(pane)).toBe(pane.lastIndexOf("❯") + 1);
      expect(tmuxComposerHoldsPayload(pane, "please run ls in the repo")).toBe(false);
      expect(tmuxPromptStillHasInput(pane, "please run ls in the repo")).toBe(false);
    }
  });
});
