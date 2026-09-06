import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import {
  clientAcceptsBracketedPaste,
  composerNewlineKey,
  deliverTextIntoPane,
  pasteAndSubmitText,
  pasteTextIntoPane,
  prepareInjectedContent,
  typeTextIntoPane,
} from "./tmuxPaste.js";

describe("clientAcceptsBracketedPaste", () => {
  test("enables only the clients verified with multiline tmux paste", () => {
    for (const id of ["claude", "codex", "opencode", "pi"] as const) {
      expect(clientAcceptsBracketedPaste(id)).toBe(true);
    }
    expect(clientAcceptsBracketedPaste("cursor")).toBe(false);
    expect(clientAcceptsBracketedPaste("gemini")).toBe(false);
  });

  test("uses the daemon's Claude default for an absent client type", () => {
    expect(clientAcceptsBracketedPaste(undefined)).toBe(true);
  });
});

describe("prepareInjectedContent", () => {
  test("preserves multiline formatting for bracketed paste", () => {
    expect(prepareInjectedContent("one\r\ntwo\r\n\nfour", { bracketed: true }))
      .toBe("one\ntwo\n\nfour");
  });

  test("flattens multiline text for an unverified client", () => {
    expect(prepareInjectedContent("one\ntwo\n\nfour", { bracketed: false }))
      .toBe("one two  four");
  });

  test("drops trailing newlines and never produces an empty paste", () => {
    expect(prepareInjectedContent("body\n\n", { bracketed: true })).toBe("body");
    expect(prepareInjectedContent("\r\n\n", { bracketed: true })).toBe(" ");
  });
});

describe("pasteTextIntoPane", () => {
  test("uses a bracketed tmux buffer for verified clients", async () => {
    const calls: string[][] = [];
    let loadedPayload = "";
    let payloadMode = 0;
    let payloadPath = "";
    await pasteTextIntoPane(async (args) => {
      calls.push(args);
      if (args[0] === "load-buffer") {
        payloadPath = args[3];
        loadedPayload = readFileSync(payloadPath, "utf8");
        payloadMode = statSync(payloadPath).mode & 0o777;
      }
    }, "%4", "one\ntwo", true);

    expect(loadedPayload).toBe("one\ntwo");
    expect(payloadMode).toBe(0o600);
    expect(payloadPath).toMatch(/codecast-paste-[^/]+\/payload$/);
    expect(calls[0]?.slice(0, 2)).toEqual(["load-buffer", "-b"]);
    expect(calls[0]?.[2]).toMatch(/^cc-\d+-[0-9a-f-]{36}$/);
    expect(calls[1]).toEqual([
      "paste-buffer",
      "-p",
      "-t",
      "%4",
      "-b",
      calls[0]?.[2],
      "-d",
    ]);
    expect(calls[2]).toEqual(["delete-buffer", "-b", calls[0]?.[2]]);
  });

  test("flattens an unverified client's payload before loading the buffer", async () => {
    let loadedPayload = "";
    await pasteTextIntoPane(async (args) => {
      if (args[0] === "load-buffer") loadedPayload = readFileSync(args[3], "utf8");
    }, "%6", "one\ntwo\nthree", false);

    expect(loadedPayload).toBe("one two three");
  });

  test("flattens before raw send-keys fallback", async () => {
    const calls: string[][] = [];
    await pasteTextIntoPane(async (args) => {
      calls.push(args);
      if (args[0] === "load-buffer") throw new Error("tmux buffer unavailable");
    }, "%7", "one\ntwo\nthree", true);

    expect(calls.at(-1)).toEqual([
      "send-keys",
      "-t",
      "%7",
      "-l",
      "one two three",
    ]);
  });

  test("deletes a loaded tmux buffer when paste fails", async () => {
    const calls: string[][] = [];
    await pasteTextIntoPane(async (args) => {
      calls.push(args);
      if (args[0] === "paste-buffer") throw new Error("target pane disappeared");
    }, "%9", "sensitive\nprompt", true);

    const bufferId = calls[0]?.[2];
    expect(calls.map((args) => args[0])).toEqual([
      "load-buffer",
      "paste-buffer",
      "send-keys",
      "delete-buffer",
    ]);
    expect(calls[2]).toEqual(["send-keys", "-t", "%9", "-l", "sensitive prompt"]);
    expect(calls[3]).toEqual(["delete-buffer", "-b", bufferId]);
  });
});

describe("pasteAndSubmitText", () => {
  test("pastes, pauses, and sends exactly one discrete submit", async () => {
    for (const bracketed of [true, false]) {
      const events: string[] = [];
      await pasteAndSubmitText({
        paste: async () => {
          events.push(`paste:${bracketed}`);
        },
        sleep: async (ms) => {
          events.push(`sleep:${ms}`);
        },
        submit: async () => {
          events.push("enter");
        },
      });

      expect(events).toEqual([`paste:${bracketed}`, "sleep:150", "enter"]);
      expect(events.filter((event) => event === "enter")).toHaveLength(1);
    }
  });

  test("does not submit when the paste itself fails", async () => {
    let submits = 0;
    await expect(pasteAndSubmitText({
      paste: async () => {
        throw new Error("paste failed");
      },
      sleep: async () => {},
      submit: async () => {
        submits++;
      },
    })).rejects.toThrow("paste failed");
    expect(submits).toBe(0);
  });
});

// ct-49607: pasting into a grok pane made grok read the machine's clipboard and
// attach any image on it, so every delivery on a machine with a screenshot
// copied carried that image to xAI under a message that never mentioned it. A
// bracketed paste is a paste GESTURE, not just text; typed keys are not, so
// grok is delivered by typing with Ctrl+J for its newlines.
describe("typed composer delivery", () => {
  test("grok is the client that must be typed; the rest still paste", () => {
    expect(composerNewlineKey("grok")).toBe("C-j");
    for (const id of ["claude", "codex", "opencode", "pi", "cursor", "gemini"] as const) {
      expect(composerNewlineKey(id)).toBeNull();
    }
    expect(composerNewlineKey(undefined)).toBeNull();
  });

  test("types line by line, with the newline key between lines", async () => {
    const calls: string[][] = [];
    await typeTextIntoPane(async (args) => { calls.push(args); }, "%3", "one\ntwo\n\nfour\n", "C-j");

    expect(calls).toEqual([
      ["send-keys", "-t", "%3", "-l", "one"],
      ["send-keys", "-t", "%3", "C-j"],
      ["send-keys", "-t", "%3", "-l", "two"],
      ["send-keys", "-t", "%3", "C-j"],
      // The blank line is the key alone: typing "" would be a no-op tmux call.
      ["send-keys", "-t", "%3", "C-j"],
      ["send-keys", "-t", "%3", "-l", "four"],
    ]);
  });

  test("a long line goes in as chunks, in order and whole", async () => {
    const line = "x".repeat(2500);
    const typed: string[] = [];
    await typeTextIntoPane(async (args) => {
      if (args[4] !== undefined) typed.push(args[4]);
    }, "%3", line, "C-j");

    expect(typed.length).toBe(3);
    expect(typed.join("")).toBe(line);
  });

  test("deliverTextIntoPane routes grok to keys and everyone else to the buffer", async () => {
    const grokCalls: string[][] = [];
    await deliverTextIntoPane(async (args) => { grokCalls.push(args); }, "%1", "one\ntwo", { agentType: "grok" });
    expect(grokCalls.map((args) => args[0])).toEqual(["send-keys", "send-keys", "send-keys"]);
    // Never a tmux buffer: that is the paste grok answers by reading the clipboard.
    expect(grokCalls.some((args) => args[0] === "paste-buffer")).toBe(false);

    const claudeCalls: string[][] = [];
    await deliverTextIntoPane(async (args) => { claudeCalls.push(args); }, "%2", "one\ntwo", { agentType: "claude" });
    expect(claudeCalls.map((args) => args[0])).toEqual(["load-buffer", "paste-buffer", "delete-buffer"]);
  });
});
