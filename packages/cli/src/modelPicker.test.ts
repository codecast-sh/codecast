import { describe, expect, test } from "bun:test";
import { parseModelPicker, planModelNavigation, SESSION_ONLY_COMMIT_RE, isSwitchConfirmDialog } from "./modelPicker.js";
import { CLAUDE_MODEL_OPTIONS } from "@codecast/shared/contracts";

// Fixtures are verbatim tmux capture-pane output from CC 2.1.173 (2026-06-11).
// The menu is DYNAMIC: rows shift between opens (the current model gains a ✔
// and "Opus" appears as its own row only when it isn't the default), which is
// why selection navigates by parsed label and never by hardcoded number.

const SIX_ROW_MENU = `
   Select model
   Switch between Claude models. Your pick becomes the default for new
   sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,
                               complex tasks
     2. Fable                  Fable 5 · Most capable for your hardest and
                               longest-running tasks · Uses your limits ~2×
                               faster than Opus
     3. Sonnet                 Sonnet 4.6 · Efficient for routine tasks
     4. Sonnet (1M context)    Sonnet 4.6 with 1M context · Draws from usage
                               credits · $3/$15 per Mtok
     5. Haiku                  Haiku 4.5 · Fastest for quick answers
   ❯ 6. Opus ✔                 Opus 4.8 · Best for everyday, complex tasks

   ● High effort (default) ←/→ to adjust

   Use /fast to turn on Fast mode (Opus 4.8).

   Enter to set as default · s to use this session only · Esc to cancel
`;

const FIVE_ROW_MENU_AFTER_DOWN = `
   Select model
   Switch between Claude models. Your pick becomes the default for new
   sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,
                               complex tasks
     2. Fable ✔                Fable 5 · Most capable for your hardest and
                               longest-running tasks · Uses your limits ~2×
                               faster than Opus
   ❯ 3. Sonnet                 Sonnet 4.6 · Efficient for routine tasks
     4. Sonnet (1M context)    Sonnet 4.6 with 1M context · Draws from usage
                               credits · $3/$15 per Mtok
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   ◐ Medium effort ←/→ to adjust

   Enter to set as default · s to use this session only · Esc to cancel
`;

const menuMatch = (key: string): string => {
  const opt = CLAUDE_MODEL_OPTIONS.find((m) => m.key === key);
  if (!opt?.menuMatch) throw new Error(`no menuMatch for ${key}`);
  return opt.menuMatch;
};

describe("parseModelPicker", () => {
  test("parses the six-row menu with highlight and current marker", () => {
    const st = parseModelPicker(SIX_ROW_MENU);
    expect(st.visible).toBe(true);
    expect(st.rows.map((r) => r.label)).toEqual([
      "Default (recommended)",
      "Fable",
      "Sonnet",
      "Sonnet (1M context)",
      "Haiku",
      "Opus",
    ]);
    expect(st.rows.find((r) => r.highlighted)?.label).toBe("Opus");
    expect(st.rows.find((r) => r.current)?.label).toBe("Opus");
    expect(st.effort).toBe("high");
  });

  test("parses the shifted five-row menu (✔ row not highlighted)", () => {
    const st = parseModelPicker(FIVE_ROW_MENU_AFTER_DOWN);
    expect(st.visible).toBe(true);
    expect(st.rows).toHaveLength(5);
    expect(st.rows.find((r) => r.highlighted)?.label).toBe("Sonnet");
    expect(st.rows.find((r) => r.current)?.label).toBe("Fable");
    expect(st.effort).toBe("medium");
  });

  test("wrapped description lines are not rows", () => {
    const st = parseModelPicker(SIX_ROW_MENU);
    // "complex tasks" / "faster than Opus" continuation lines must not parse.
    expect(st.rows.every((r) => r.num >= 1 && r.num <= 6)).toBe(true);
  });

  test("a pane without the menu is not visible", () => {
    expect(parseModelPicker("❯ \n  ⏵⏵ don't ask on").visible).toBe(false);
    expect(parseModelPicker("").visible).toBe(false);
  });

  test("only rows after the LAST header count (stale scrollback above)", () => {
    const st = parseModelPicker(SIX_ROW_MENU + "\n" + FIVE_ROW_MENU_AFTER_DOWN);
    expect(st.rows).toHaveLength(5);
    expect(st.effort).toBe("medium");
  });
});

describe("planModelNavigation", () => {
  test("plans Down moves toward a later row", () => {
    // Highlight on Opus (idx 5) → Sonnet (idx 2) = 3 Ups.
    const st = parseModelPicker(SIX_ROW_MENU);
    expect(planModelNavigation(st, menuMatch("sonnet"))).toBe(-3);
    expect(planModelNavigation(st, menuMatch("fable"))).toBe(-4);
    expect(planModelNavigation(st, menuMatch("opus"))).toBe(0);
  });

  test("sonnet matcher does not hit the 1M row (and vice versa)", () => {
    const st = parseModelPicker(SIX_ROW_MENU);
    expect(planModelNavigation(st, menuMatch("sonnet"))).toBe(-3);
    expect(planModelNavigation(st, menuMatch("sonnet-1m"))).toBe(-2);
  });

  test("default matcher hits the Default row", () => {
    const st = parseModelPicker(SIX_ROW_MENU);
    expect(planModelNavigation(st, menuMatch("default"))).toBe(-5);
  });

  test("null when the requested model is missing from the menu", () => {
    const st = parseModelPicker(FIVE_ROW_MENU_AFTER_DOWN);
    expect(planModelNavigation(st, menuMatch("opus"))).toBeNull();
  });
});

describe("SESSION_ONLY_COMMIT_RE", () => {
  test("matches both commit echo shapes (verbatim captures)", () => {
    expect("  ⎿  Set model to Sonnet 4.6 for this session only with max effort").toMatch(SESSION_ONLY_COMMIT_RE);
    expect("  ⎿  Set model to Fable 5 for this session only").toMatch(SESSION_ONLY_COMMIT_RE);
  });

  test("does not match the default-save echo", () => {
    expect(SESSION_ONLY_COMMIT_RE.test("Set model to Opus 4.8 and saved as your default for new sessions")).toBe(false);
  });
});

describe("isSwitchConfirmDialog", () => {
  // Verbatim pane tail captured live when committing a model switch on a
  // conversation with history (2026-06-11).
  const DIALOG = `
   Your next response will be slower and use more tokens
   This conversation is cached for the current model. Switching to Opus 4.8
   (1M context) means the full history gets re-read on your next message.
   ❯ 1. Yes, switch to Opus 4.8 (1M context)
     2. No, go back
`;
  test("detects the cache-invalidation confirm dialog", () => {
    expect(isSwitchConfirmDialog(DIALOG)).toBe(true);
  });

  test("ignores the picker menu and idle prompt", () => {
    expect(isSwitchConfirmDialog(SIX_ROW_MENU)).toBe(false);
    expect(isSwitchConfirmDialog("❯ \n  ⏵⏵ bypass permissions on")).toBe(false);
  });
});
