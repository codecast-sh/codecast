import { describe, expect, test } from "bun:test";
import { parseModelPicker, planModelNavigation, SESSION_ONLY_COMMIT_RE, countSessionOnlyCommits, isSwitchConfirmDialog, isStrandedModelCommand } from "./modelPicker.js";
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

// Verbatim capture from CC 2.1.220 (2026-07-30): Sonnet 1M is gone, Opus is
// the 1M row, Fable is both current (✔) and highlighted.
const FIVE_ROW_MENU_2_1_220 = `
   Select model
   Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.

     1. Default (recommended)  Opus 5 with 1M context · Best for everyday, complex tasks
     2. Opus (1M context)      Opus 5 with 1M context · Best for everyday, complex tasks
   ❯ 3. Fable ✔                Fable 5 · Most capable for your hardest and longest-running tasks
     4. Sonnet                 Sonnet 5 · Efficient for routine tasks
     5. Haiku                  Haiku 4.5 · Fastest for quick answers

   ● High effort (default) ←/→ to adjust

   Use /fast to turn on Fast mode (Opus 5).

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

  test("parses the CC 2.1.220 picker-only effort stops (verbatim rows)", () => {
    const menu = (effortRow: string) =>
      FIVE_ROW_MENU_2_1_220.replace("   ● High effort (default) ←/→ to adjust", effortRow);
    expect(parseModelPicker(menu("   ◉ xHigh effort ←/→ to adjust")).effort).toBe("xhigh");
    expect(parseModelPicker(menu("   ✦ Ultracode effort ←/→ to adjust")).effort).toBe("ultracode");
    expect(parseModelPicker(menu("   ◈ Max effort ←/→ to adjust")).effort).toBe("max");
    expect(parseModelPicker(menu("   ○ Low effort ←/→ to adjust")).effort).toBe("low");
  });

  test("flags effort as unsupported for the highlighted model (Haiku, CC 2.1.220)", () => {
    const menu = FIVE_ROW_MENU_2_1_220.replace(
      "   ● High effort (default) ←/→ to adjust",
      "   ○ Effort not supported for Haiku",
    );
    const st = parseModelPicker(menu);
    expect(st.visible).toBe(true);
    expect(st.effortUnsupported).toBe(true);
    expect(st.effort).toBeNull();
    expect(parseModelPicker(FIVE_ROW_MENU_2_1_220).effortUnsupported).toBe(false);
  });

  test("a pane without the menu is not visible", () => {
    expect(parseModelPicker("❯ \n  ⏵⏵ don't ask on").visible).toBe(false);
    expect(parseModelPicker("").visible).toBe(false);
  });

  test("parses the CC 2.1.220 menu (Opus is the 1M row, no Sonnet 1M)", () => {
    const st = parseModelPicker(FIVE_ROW_MENU_2_1_220);
    expect(st.visible).toBe(true);
    expect(st.rows.map((r) => r.label)).toEqual([
      "Default (recommended)",
      "Opus (1M context)",
      "Fable",
      "Sonnet",
      "Haiku",
    ]);
    expect(st.rows.find((r) => r.highlighted)?.label).toBe("Fable");
    expect(st.rows.find((r) => r.current)?.label).toBe("Fable");
    expect(st.effort).toBe("high");
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

  test("navigates the CC 2.1.220 menu from the Fable highlight", () => {
    const st = parseModelPicker(FIVE_ROW_MENU_2_1_220);
    expect(planModelNavigation(st, menuMatch("fable"))).toBe(0);
    expect(planModelNavigation(st, menuMatch("opus"))).toBe(-1);
    expect(planModelNavigation(st, menuMatch("default"))).toBe(-2);
    expect(planModelNavigation(st, menuMatch("sonnet"))).toBe(1);
    expect(planModelNavigation(st, menuMatch("haiku"))).toBe(2);
    expect(planModelNavigation(st, menuMatch("sonnet-1m"))).toBeNull();
  });
});

describe("isStrandedModelCommand", () => {
  // Verbatim composer tail from CC 2.1.220 after the Enter was eaten by the
  // slash-command popup: the command text sits un-submitted in the composer.
  const STRANDED_TAIL = `
────────────────────────────────────────
❯ /model
────────────────────────────────────────
  ⏵⏵ don't ask on (shift+tab to cycle)
`;

  test("detects the un-submitted command in the composer", () => {
    expect(isStrandedModelCommand(STRANDED_TAIL)).toBe(true);
  });

  test("ignores an empty composer and the open menu", () => {
    expect(isStrandedModelCommand("❯ \n  ⏵⏵ don't ask on")).toBe(false);
    expect(isStrandedModelCommand(FIVE_ROW_MENU_2_1_220)).toBe(false);
  });

  test("the transcript echo of a submitted /model matches too — callers must pass only the pane's bottom lines", () => {
    expect(isStrandedModelCommand("❯ /model\n  ⎿  Set model to Fable 5 for this session only")).toBe(true);
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

describe("countSessionOnlyCommits", () => {
  test("counts every session-only echo, ignoring default-save echoes", () => {
    const pane = [
      "❯ /model",
      "  ⎿  Set model to Fable 5 and saved as your default for new sessions",
      "❯ /model",
      "  ⎿  Set model to Sonnet 5 for this session only",
      "❯ /model",
      "  ⎿  Set model to Haiku 4.5 for this session only with max effort",
    ].join("\n");
    expect(countSessionOnlyCommits(pane)).toBe(2);
    expect(countSessionOnlyCommits("")).toBe(0);
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
