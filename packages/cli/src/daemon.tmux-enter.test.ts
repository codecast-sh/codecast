import { describe, expect, test } from "bun:test";
import {
  clientAcceptsBracketedPaste,
  prepareInjectedContent,
  tmuxPromptShowsPastePlaceholder,
  tmuxPromptStillHasInput,
} from "./daemon.js";

describe("tmuxPromptStillHasInput", () => {
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

describe("prepareInjectedContent", () => {
  test("keeps newlines for a bracketed paste", () => {
    expect(prepareInjectedContent("one\ntwo\n\nthree", { bracketed: true })).toBe("one\ntwo\n\nthree");
  });

  test("flattens newlines when the transport cannot bracket them", () => {
    // Each surviving newline would submit the fragment above it as its own
    // message, so the unbracketed transports trade formatting for wholeness.
    expect(prepareInjectedContent("one\ntwo\nthree", { bracketed: false })).toBe("one two three");
  });

  test("normalizes CRLF and lone CR to newlines", () => {
    expect(prepareInjectedContent("a\r\nb\rc", { bracketed: true })).toBe("a\nb\nc");
  });

  test("drops trailing newlines so the submitting Enter is not absorbed", () => {
    expect(prepareInjectedContent("body\n\n", { bracketed: true })).toBe("body");
  });

  test("never yields an empty paste", () => {
    // An empty paste leaves the composer untouched, so the trailing Enter would
    // submit whatever draft the user had typed there.
    expect(prepareInjectedContent("\n\n", { bracketed: true })).toBe(" ");
  });
});

describe("clientAcceptsBracketedPaste", () => {
  test("true for the clients verified to bracket a paste", () => {
    for (const id of ["claude", "codex", "opencode", "pi"] as const) {
      expect(clientAcceptsBracketedPaste(id)).toBe(true);
    }
  });

  test("false for clients whose TUI has not been verified", () => {
    // Unverified means flatten: a client that ignores the markers would submit
    // one message per line instead.
    expect(clientAcceptsBracketedPaste("cursor")).toBe(false);
    expect(clientAcceptsBracketedPaste("gemini")).toBe(false);
  });

  test("an absent client type is treated as claude", () => {
    expect(clientAcceptsBracketedPaste(undefined)).toBe(true);
  });
});

describe("tmuxPromptShowsPastePlaceholder", () => {
  test("detects a collapsed multi-line paste chip at the prompt", () => {
    const pane = `
  ctrl+g to edit in VS Code
────────────────────────────────────
❯ [Pasted text #1 +13 lines]
────────────────────────────────────
  paste again to expand
`;
    expect(tmuxPromptShowsPastePlaceholder(pane)).toBe(true);
  });

  test("ignores a paste chip that already scrolled into the transcript", () => {
    const pane = `
  user: [Pasted text #1 +13 lines]
  assistant: done
❯
`;
    expect(tmuxPromptShowsPastePlaceholder(pane)).toBe(false);
  });

  test("does not fire on ordinary prompt text", () => {
    expect(tmuxPromptShowsPastePlaceholder("❯ deploy the thing\n▋\n")).toBe(false);
  });
});
