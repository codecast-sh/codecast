import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { routeTmuxArgs, sessionSocketName, tmuxSocketDir } from "./tmuxRoute.js";
import {
  clientAcceptsBracketedPaste,
  deliverTextIntoPane,
  deliveryTimeoutMsFor,
  pasteAndSubmitText,
  pasteTextIntoPane,
  prepareInjectedContent,
  tmuxLiteralArg,
  TYPED_CHUNK_TIMEOUT_MS,
  typedNewlineKey,
} from "./tmuxPaste.js";

// What tmux types for one `send-keys -l` argument: its parser drops a final
// unescaped `;` (the command ends there) and turns a final `\;` into `;`
// (cmd-parse.y, cmd_parse_from_arguments; verified on tmux 3.6a).
const tmuxTypes = (arg: string) =>
  arg.endsWith("\\;") ? arg.slice(0, -2) + ";" : arg.endsWith(";") ? arg.slice(0, -1) : arg;

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

describe("tmuxLiteralArg", () => {
  test("escapes only a final semicolon, which tmux would otherwise drop", () => {
    expect(tmuxLiteralArg("abc;")).toBe("abc\\;");
    expect(tmuxLiteralArg(";")).toBe("\\;");
    expect(tmuxLiteralArg("a;b")).toBe("a;b");
    expect(tmuxLiteralArg("abc")).toBe("abc");
  });

  test("round-trips through tmux's parser, a literal backslash before the semicolon included", () => {
    for (const text of ["abc;", ";", "x\\;", "a;b", "abc", "x\\"]) {
      expect(tmuxTypes(tmuxLiteralArg(text))).toBe(text);
    }
    // Unescaped, tmux loses the character: the bug this helper closes.
    expect(tmuxTypes("abc;")).toBe("abc");
  });
});

describe("pasteTextIntoPane", () => {
  // load-buffer and delete-buffer name no target; they must reach the server
  // paste-buffer reads, or a session on its own server never gets a paste.
  test("every buffer verb reaches the target session's own server", async () => {
    const env = { TMUX_TMPDIR: mkdtempSync(path.join(os.tmpdir(), "tmux-paste-")), CODECAST_TMUX_PER_SESSION: "1" };
    try {
      mkdirSync(tmuxSocketDir(env), { recursive: true });
      writeFileSync(path.join(tmuxSocketDir(env), sessionSocketName("cc-resume-abc")), "");
      const routed: string[][] = [];
      await pasteTextIntoPane(async (args) => { routed.push(...routeTmuxArgs(args, env)); }, "cc-resume-abc:0.0", "hello", true);
      expect(routed.map((a) => a.slice(0, 3))).toEqual([
        ["-L", sessionSocketName("cc-resume-abc"), "load-buffer"],
        ["-L", sessionSocketName("cc-resume-abc"), "paste-buffer"],
        ["-L", sessionSocketName("cc-resume-abc"), "delete-buffer"],
      ]);
    } finally {
      rmSync(env.TMUX_TMPDIR, { recursive: true, force: true });
    }
  });

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

  test("escapes a final semicolon on the raw send-keys fallback", async () => {
    const calls: string[][] = [];
    await pasteTextIntoPane(async (args) => {
      calls.push(args);
      if (args[0] === "load-buffer") throw new Error("tmux buffer unavailable");
    }, "%7", "run it;", true);
    expect(calls.at(-1)).toEqual(["send-keys", "-t", "%7", "-l", "run it\\;"]);
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
    await expect(pasteTextIntoPane(async (args) => {
      calls.push(args);
      if (args[0] === "paste-buffer") throw new Error("target pane disappeared");
    }, "%9", "sensitive\nprompt", true)).rejects.toThrow("target pane disappeared");

    const bufferId = calls[0]?.[2];
    expect(calls.map((args) => args[0])).toEqual([
      "load-buffer",
      "paste-buffer",
      "delete-buffer",
    ]);
    expect(calls[2]).toEqual(["delete-buffer", "-b", bufferId]);
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

describe("typed delivery", () => {
  // A pane that shows what has been typed into it, as a client that reads its
  // input does.
  const recorder = () => {
    const calls: string[][] = [];
    let screen = "❯ ";
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "send-keys" && args.includes("-l")) screen += args.at(-1);
      return { stdout: args[0] === "capture-pane" ? screen : "", stderr: "" };
    };
    return { calls, exec, writes: () => calls.filter((c) => c[0] === "send-keys") };
  };

  test("types into an idle Claude composer, so a long message is not wrapped as a paste", () => {
    expect(typedNewlineKey("claude", "first line\nsecond line", true)).toBe("C-j");
    expect(typedNewlineKey(undefined, "go ahead and ship it", true)).toBe("C-j");
  });

  test("pastes into Claude mid-turn, where a dialog could take a typed key", () => {
    expect(typedNewlineKey("claude", "go ahead and ship it", false)).toBeNull();
  });

  test("pastes what Claude's typed composer cannot carry: a tab, a lone character", () => {
    expect(typedNewlineKey("claude", "col1\tcol2", true)).toBeNull();
    expect(typedNewlineKey("claude", "2", true)).toBeNull();
    expect(typedNewlineKey("claude", " y ", true)).toBeNull();
  });

  test("types grok always and pastes clients that accept a paste", () => {
    expect(typedNewlineKey("grok", "x\ty", false)).toBe("C-j");
    expect(typedNewlineKey("codex", "go ahead", true)).toBeNull();
  });

  test("an idle multi-line message rides in literal chunks with its newlines inside", async () => {
    const { calls, exec } = recorder();
    await deliverTextIntoPane(exec, "s:0.0", "- first\nsecond\n", { agentType: "claude", idle: true });
    expect(calls).toEqual([["send-keys", "-t", "s:0.0", "-l", "--", "- first\nsecond"]]);
  });

  test("each chunk waits until the pane shows the one before it", async () => {
    // A client starved of CPU reads everything queued in the pty at once, and
    // Claude takes a burst that size for a paste it may never close (jx76c85).
    // This pane renders a write one capture late, so a writer that does not
    // wait would send its next chunk while the last one is still unread.
    const writes: string[] = [];
    let rendered = "";
    let lastSeen = "";
    let early = 0;
    const exec = async (args: string[]) => {
      if (args[0] === "send-keys" && args.includes("-l")) {
        if (lastSeen !== writes.join("")) early++;
        writes.push(args.at(-1)!);
      }
      if (args[0] !== "capture-pane") return { stdout: "", stderr: "" };
      lastSeen = rendered;
      rendered = writes.join("");
      return { stdout: "❯ " + lastSeen, stderr: "" };
    };
    const text = "x".repeat(100) + "y".repeat(100) + "z".repeat(100);
    await deliverTextIntoPane(exec, "s:0.0", text, { agentType: "claude", idle: true });
    expect(writes.join("")).toBe(text);
    expect(writes.length).toBe(3);
    expect(early).toBe(0);
  });

  test("a pane that never shows the text slows typing but does not stop it", async () => {
    const calls: string[][] = [];
    const exec = async (args: string[]) => { calls.push(args); return { stdout: "", stderr: "" }; };
    await deliverTextIntoPane(exec, "s:0.0", "a".repeat(300), { agentType: "claude", idle: true, echoBudgetMs: 50 });
    expect(calls.filter((c) => c[0] === "send-keys").map((c) => c.at(-1)).join("")).toBe("a".repeat(300));
  });

  test("a chunk ending on a semicolon reaches the pane whole", async () => {
    // tr-444 into jx7b88a, 2026-10-05: a 157 KB prompt typed in 128-character
    // chunks lost the `;` at six chunk ends, so the transcript never matched
    // the payload and the daemon typed it again, five times in all.
    const calls: string[][] = [];
    let screen = "❯ ";
    const exec = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "send-keys" && args.includes("-l")) screen += tmuxTypes(args.at(-1)!);
      return { stdout: args[0] === "capture-pane" ? screen : "", stderr: "" };
    };
    const text = "a".repeat(127) + ";" + "b".repeat(127) + ";" + "c".repeat(20) + ";";
    await deliverTextIntoPane(exec, "s:0.0", text, { agentType: "claude", idle: true });
    const chunks = calls.filter((c) => c[0] === "send-keys").map((c) => c.at(-1)!);
    expect(chunks.length).toBe(3);
    expect(chunks.every((c) => c.endsWith("\\;"))).toBe(true);
    expect(chunks.map(tmuxTypes).join("")).toBe(text);
    expect(screen).toBe("❯ " + text);
  });

  test("never leaves a lone character for the last chunk", async () => {
    const { calls, exec } = recorder();
    await deliverTextIntoPane(exec, "s:0.0", "a".repeat(129), { agentType: "claude", idle: true });
    const chunks = calls.filter((c) => c[0] === "send-keys").map((c) => c.at(-1)!);
    expect(chunks.join("")).toBe("a".repeat(129));
    expect(Math.min(...chunks.map((c) => c.length))).toBeGreaterThan(1);
  });

  test("a busy Claude pane still gets the bracketed paste", async () => {
    const { calls, exec } = recorder();
    await deliverTextIntoPane(exec, "s:0.0", "go ahead", { agentType: "claude", idle: false });
    expect(calls.map((c) => c[0])).toEqual(["load-buffer", "paste-buffer", "delete-buffer"]);
  });
});

describe("deliveryTimeoutMsFor", () => {
  test("a payload Claude types gets one allowance per 128-char chunk on top of the base", () => {
    // 157 KB typed into jx7b88a took 409 s against a 180 s budget (2026-10-05).
    const text = "x".repeat(157_000);
    expect(deliveryTimeoutMsFor(text, "claude", 180_000)).toBe(180_000 + Math.ceil(157_000 / 128) * TYPED_CHUNK_TIMEOUT_MS);
    expect(deliveryTimeoutMsFor(text, "claude", 180_000)).toBeGreaterThan(409_000 * 2);
    expect(deliveryTimeoutMsFor("go ahead", undefined, 180_000)).toBe(181_000);
  });

  test("a pasted payload keeps the base budget", () => {
    expect(deliveryTimeoutMsFor("x".repeat(157_000), "codex", 180_000)).toBe(180_000);
    expect(deliveryTimeoutMsFor("col1\tcol2", "claude", 180_000)).toBe(180_000);
  });
});
