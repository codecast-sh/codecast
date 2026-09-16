import { describe, expect, test } from "bun:test";
import { stripTmuxFaintText, tmuxComposerHoldsPayload, tmuxPromptStillHasInput, verifyTmuxSubmitAfterPaste } from "./daemon.js";

// ct-51376 (2026-09-14). Claude Code draws a prompt suggestion in an idle
// composer as faint text (SGR 2): "❯ continue" when the model expects the user
// to say continue. `capture-pane -p` drops the attribute, so the scraper read
// the suggestion as typed text. Delivering a queued "continue" then logged
// "already holds this payload", skipped the paste, and the submit verifier
// pressed Enter every 400 ms for 15 s (38 presses on cc-resume-8b86a4df every
// two to three minutes, 14:22 to 14:57 UTC) while the transcript gained no
// turn. The message settled agent_prompt_stalled, was held INJECT_UNVERIFIED,
// and was retried into the same suggestion forever.
//
// The composer checks must read a capture taken with -e and ignore faint runs.

// Byte for byte from `tmux capture-pane -p -e -J` on cc-resume-34b61ff6, idle.
const RULE = "\x1b[38;5;246m" + "─".repeat(60) + "\n";
const FOOTER =
  "\x1b[39m  \x1b[38;5;241maccount\x1b[39m \x1b[38;5;241m·\x1b[39m \x1b[38;5;241msession\x1b[39m\n" +
  "\x1b[39m  \x1b[38;5;160m⏵⏵\x1b[39m \x1b[38;5;160mbypass\x1b[39m \x1b[38;5;160mpermissions\x1b[39m\n";
const GHOST_ANSI = `\x1b[38;5;241m✻\x1b[39m \x1b[38;5;241mBaked for 50s · done\x1b[39m\n\n${RULE}\x1b[39m❯ \x1b[2mcontinue\n\x1b[0m${RULE}${FOOTER}`;
const TYPED_ANSI = `\x1b[38;5;241m✻\x1b[39m \x1b[38;5;241mBaked for 50s · done\x1b[39m\n\n${RULE}\x1b[39m❯ continue\n\x1b[0m${RULE}${FOOTER}`;

describe("prompt suggestion ghost text is not composer input", () => {
  test("colour arguments are not attributes: truecolor and 256 colour text survives", () => {
    expect(stripTmuxFaintText("\x1b[38;2;200;2;2mtyped\x1b[0m")).toBe("typed");
    expect(stripTmuxFaintText("\x1b[48;5;2mtyped\x1b[0m")).toBe("typed");
    expect(stripTmuxFaintText("\x1b[2mghost\x1b[22m typed")).toBe(" typed");
  });

  test("a faint suggestion does not read as the payload already at the prompt", () => {
    const pane = stripTmuxFaintText(GHOST_ANSI);
    expect(tmuxComposerHoldsPayload(pane, "continue")).toBe(false);
    expect(tmuxPromptStillHasInput(pane, "continue")).toBe(false);
  });

  test("the same words typed into the composer still read as held", () => {
    const pane = stripTmuxFaintText(TYPED_ANSI);
    expect(tmuxComposerHoldsPayload(pane, "continue")).toBe(true);
    expect(tmuxPromptStillHasInput(pane, "continue")).toBe(true);
  });

  test("the submit verifier does not press Enter at a suggestion", async () => {
    const actions: string[] = [];
    const frame = stripTmuxFaintText(GHOST_ANSI);
    const res = await verifyTmuxSubmitAfterPaste(
      {
        capture: async () => frame,
        sendEnter: async () => { actions.push("enter"); },
        rePaste: async () => { actions.push("repaste"); },
        sleep: async () => {},
        log: () => {},
      },
      { prePaste: "", pasteConfirmed: true, contentPrefix: "continue", deadlineMs: 15_000 },
    );
    expect(actions.filter((a) => a === "enter").length).toBeLessThanOrEqual(5);
    expect(res.outcome).not.toBe("delivered");
  });
});
