// A typed message that is a numbered list sits in Claude's composer as
// "❯ 1. …" over its "2. …" rows, which parses as a dialog with its cursor on
// option 1. The delivery guard must read that as the message itself, and a
// real dialog as a dialog.
import { describe, expect, test } from "bun:test";
import { extractTmuxLiveRegion, parseInteractivePrompt, promptIsOwnText } from "./daemon.js";
import { classifyTmuxLiveState } from "./tmuxPaneState.js";

const steps = Array.from({ length: 6 }, (_, i) => `${i + 1}. Check migration step ${i + 1} against the staging snapshot.`);
const payload = `notes from the release review, please work through them in order.\n${steps.join("\n")}`;
const rule = "─".repeat(120);
const framed = (rows: string[]) => [" ▐▛███▛█   Claude Code", "", rule, ...rows, rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");

describe("promptIsOwnText", () => {
  test("the composer scrolled onto a typed numbered list is the payload, not a dialog", () => {
    const rows = steps.map((line, i) => (i === 0 ? `❯ ${line}` : `  ${line}`));
    rows[rows.length - 1] = rows[rows.length - 1]!.slice(0, 30); // cut off at the frame
    // The cursor row sits right under the composer's top rule: the composer, never a dialog.
    expect(parseInteractivePrompt(framed(rows), true)).toBeNull();
  });

  // 2026-10-26: a long draft left in the composer (a write that settled
  // without submitting, or text someone else typed) scrolled to a numbered row,
  // "❯ 5) …" or "❯ 2. …", and held every message to the session for hours as
  // "waiting for a human answer". Numbered rows in the transcript above lent
  // the second one a dialog's worth of options.
  test("a composer draft scrolled to a numbered row holds nothing, whoever wrote it", () => {
    const transcript = ["⏺ Two things wait on you:", "", "  1. sd-1025: whether to retry dropped database reads once.", "  2. Cloud host key: remove the export?", ""];
    const draft = ["❯ 2. Need-pair, ready on branch sd973-need-pair-quality (rebased on main).", "  What is in, as you asked: the 0.40 floor on the combined score.", "  I recommend b: deploy on your word"];
    for (const pane of [
      [...transcript, rule, ...draft, rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n"),
      // A draft taller than the pane: only its top rule is in view.
      ["✻ Waiting for 1 dynamic workflow to finish", "", rule, "❯ 5) Production deals are simulation rows only (./xrun sql must be 0).", "  running. Stray worker sessions get killed.", "", "  Trigger lifecycle defaults:", "  Save this run's verified outcome."].join("\n"),
    ]) {
      expect(parseInteractivePrompt(pane, true)).toBeNull();
      expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("idle");
    }
  });

  test("a real permission dialog is never the payload", () => {
    const pane = framed([" Do you want to proceed?", " ❯ 1. Yes", "   2. Yes, and don't ask again", "   3. No"]);
    const prompt = parseInteractivePrompt(pane, true);
    expect(prompt).not.toBeNull();
    expect(promptIsOwnText(prompt!, payload)).toBe(false);
    expect(promptIsOwnText(prompt!, undefined)).toBe(false);
  });
});
