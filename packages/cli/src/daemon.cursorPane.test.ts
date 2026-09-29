import { describe, expect, test } from "bun:test";
import { classifyLivePaneFor } from "./daemon.js";

// Live cursor-agent v2026.09.28 panes, captured 2026-09-29.
const FRESH = `  Cursor Agent
  v2026.09.28-64d2043
  Tip: Hit shift+tab to enable Plan Mode for large or complex changes.
  → Plan, search, build anything
  Auto
  /private/tmp/cursor-scratch · main`;
const AFTER_TURN = `  done
  → Add a follow-up
  Auto · 9% · 1 file edited
  /private/tmp/cursor-scratch · main`;
const WORKING = ` ⠰⠳ Working  41 tokens
    Tip: Use /mcp to connect Cursor to your tools and data sources.
  → write a 40 line poem about tmux into poem.md
  Auto
  /private/tmp/cursor-scratch · main`;
const WORKING_AFTER_FOLLOWUP = ` ⠀⠞ Editing  492 tokens
  → Add a follow-up
  Auto · 1 file edited`;
const TRUST = `  │  ⚠ Workspace Trust Required
  │  Do you trust the contents of this directory?
  │  ▶ [a] Trust this workspace
  │    [q] Quit`;
// After `a`: the box stays in history above the booted composer.
const TRUST_ANSWERED = `${TRUST}
  │  ⏳ Trusting workspace...
  ╰──────────────
  Cursor Agent
  v2026.09.28-64d2043
  → Plan, search, build anything
  Auto`;
const SIGNED_OUT = `  Cursor Agent
  v2026.03.18-f6873f7
  Press any key to log in...`;
const APPROVAL = ` $  wc -l poem.md in .
 Run this command?
 Not in allowlist: wc
  → Run (once) (y)
    Add Shell(wc) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)`;

describe("cursor-agent pane classification", () => {
  test.each([
    ["fresh composer", FRESH, "idle"],
    ["composer after a turn", AFTER_TURN, "idle"],
    ["working", WORKING, "busy"],
    ["working with the follow-up composer painted", WORKING_AFTER_FOLLOWUP, "busy"],
    ["workspace trust dialog", TRUST, "trust"],
    ["answered trust dialog left in history", TRUST_ANSWERED, "idle"],
    ["signed-out splash", SIGNED_OUT, "signed_out"],
    ["tool approval menu", APPROVAL, "menu"],
  ])("%s", (_name, pane, state) => {
    expect(classifyLivePaneFor("cursor", pane)).toBe(state as any);
  });
});
