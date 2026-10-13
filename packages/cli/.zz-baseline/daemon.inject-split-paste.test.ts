import { expect, test } from "bun:test";
import { awaitTmuxComposerPayload, composerHoldsSplitPaste } from "./daemon.js";

// The shapes below are transcribed from live wedged panes on 2026-09-19: a
// bracketed paste over a kilobyte reaches a pane that is mid-turn as several
// pastes, so the composer holds chips plus the tail as literal text.
const pane = (composer: string) =>
  `${"─".repeat(80)}\n❯ ${composer}\n${"─".repeat(80)}\n  bypass permissions on`;

const message = (body: string) => `<session-message from="jx7test">\n${body}\n</session-message>`;

test("a chip plus the payload's own tail is the payload, split by a stalled read", () => {
  const payload = message("one\ntwo\nthree\nfour\nfive awaiting your confirmation.");
  // The first five breaks collapsed into a chip; the rest stayed literal.
  const composer = "[Pasted text #63 +5 lines]ing your confirmation.\n  </session-message>\n";
  expect(composerHoldsSplitPaste(composer, payload)).toBe(true);
});

test("several chips in a row account for the whole payload", () => {
  const payload = message(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
  expect(composerHoldsSplitPaste("[Pasted text #282 +8 lines][Pasted text #283 +5 lines]", payload)).toBe(true);
});

test("a chip with no count is one line, not an unknown", () => {
  const payload = "one line, then the tail";
  expect(composerHoldsSplitPaste("[Pasted text #21], then the tail", payload)).toBe(true);
});

test("a second round of pastes on top of the first overshoots the payload", () => {
  const payload = message("one\ntwo\nthree");
  // The drain missed the earlier attempt, so the composer holds it twice.
  const composer = "[Pasted text #12 +4 lines][Pasted text #13 +4 lines]";
  expect(composerHoldsSplitPaste(composer, payload)).toBe(false);
});

test("a stranger's draft ahead of the chip is refused", () => {
  const payload = message("one\ntwo");
  expect(composerHoldsSplitPaste("what about this [Pasted text #4 +3 lines]", payload)).toBe(false);
});

test("visible text that is not in the payload is refused", () => {
  const payload = message("one\ntwo\nthree");
  expect(composerHoldsSplitPaste("[Pasted text #7 +3 lines] and something nobody sent\n", payload)).toBe(false);
});

test("the runs must appear in the payload in order", () => {
  const payload = "alpha\nomega";
  // "omega" then "alpha" is the payload's text, out of order.
  expect(composerHoldsSplitPaste("[Pasted text #1]omega\nalpha", payload)).toBe(false);
});

test("the enter gate submits a split paste instead of stranding it", async () => {
  const payload = message("one\ntwo\nthree\nfour awaiting your confirmation.");
  const composer = "[Pasted text #9 +4 lines]ing your confirmation.\n  </session-message>";
  let rePastes = 0;
  const result = await awaitTmuxComposerPayload("split:0.0", payload, {
    bracketedPaste: true,
    rePaste: async () => { rePastes++; },
    allowRePaste: false,
    exec: async (args) => {
      if (args[0] === "capture-pane") return { stdout: pane(composer), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });
  expect(result).toBe("matched");
  expect(rePastes).toBe(0);
}, 30_000);

test("the enter gate still refuses a composer it cannot account for", async () => {
  const payload = message("one\ntwo\nthree");
  let rePastes = 0;
  await expect(awaitTmuxComposerPayload("split:0.0", payload, {
    bracketedPaste: true,
    rePaste: async () => { rePastes++; },
    allowRePaste: false,
    exec: async (args) => {
      if (args[0] === "capture-pane") return { stdout: pane("[Pasted text #12 +4 lines][Pasted text #13 +4 lines]"), stderr: "" };
      return { stdout: "", stderr: "" };
    },
  })).rejects.toThrow(/has not appeared intact/);
  expect(rePastes).toBe(0);
}, 30_000);
