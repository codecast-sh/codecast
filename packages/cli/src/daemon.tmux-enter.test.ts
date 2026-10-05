import { describe, expect, test } from "bun:test";
import {
  tmuxPromptShowsPastePlaceholder,
  tmuxPromptStillHasInput,
} from "./daemon.js";

describe("tmuxPromptStillHasInput", () => {
  test("hi in the footer does not keep a submitted message stuck", () => {
    const pane = (draft: string) => `❯ ${draft}\n────────────────────\n  ashot\n  bypass permissions on (shift+tab to cycle)`;
    expect(tmuxPromptStillHasInput(pane("hi"), "hi")).toBe(true);
    expect(tmuxPromptStillHasInput(pane(""), "hi")).toBe(false);
  });

  test("a draft taller than 80 lines is still unsent input, not a submitted message", () => {
    // jx76c85 (2026-10-05): an 81-line huddle chunk sat in the composer and the
    // prompt line had scrolled past a fixed 80-line window, so the verifier
    // read the message as gone and acked it while it was never sent.
    const draft = Array.from({ length: 100 }, (_, i) => `  **Cam**: line ${i} of the room`).join("\n");
    const pane = `⏺ [pass]\n\n❯ <session-message from="unknown">\n${draft}\n  </session-message>\n────────────────────\n  bypass permissions on (shift+tab to cycle)`;
    expect(tmuxPromptStillHasInput(pane, '<session-message from="unknown">')).toBe(true);
  });

  test("detects unsent input still sitting at the prompt", () => {
    const pane = `
* Crunched for 14m 27s

❯ is the debug loading buffer bar supposed to work still or no?
▋
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to")
    ).toBe(true);
  });

  test("does not match when the prompt is empty", () => {
    const pane = `
  user: is the debug loading buffer bar supposed to work still or no?
  assistant: ...
❯
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to")
    ).toBe(false);
  });

  test("matches wrapped prompt input", () => {
    const pane = `
❯ is the debug loading buffer bar supposed
  to work still or no?
▋
`;
    expect(
      tmuxPromptStillHasInput(pane, "is the debug loading buffer bar supposed to work still")
    ).toBe(true);
  });
});

describe("tmuxPromptShowsPastePlaceholder", () => {
  test("ignores a paste placeholder below the composer", () => {
    expect(tmuxPromptShowsPastePlaceholder("❯ \n────────────────────\n[Pasted text #1 +13 lines]")).toBe(false);
  });

  test("detects a collapsed multiline paste at the active prompt", () => {
    const pane = `
  ctrl+g to edit in VS Code
────────────────────────────────────
❯ [Pasted text #1 +13 lines]
────────────────────────────────────
  paste again to expand
`;
    expect(tmuxPromptShowsPastePlaceholder(pane)).toBe(true);
  });

  test("ignores a paste placeholder already in the transcript", () => {
    const pane = `
  user: [Pasted text #1 +13 lines]
  assistant: done
❯
`;
    expect(tmuxPromptShowsPastePlaceholder(pane)).toBe(false);
  });

  test("ignores ordinary prompt text", () => {
    expect(tmuxPromptShowsPastePlaceholder("❯ deploy the thing\n▋\n")).toBe(false);
  });
});
