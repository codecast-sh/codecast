import { describe, expect, test } from "bun:test";
import { DRAIN_MAX_CYCLES, awaitTmuxComposerPayload, drainTmuxComposer, tmuxComposerText, tmuxWatchablePrefix } from "./daemon.js";

// ct-40212 / ct-47277: a painted composer does not prove stdin is being read,
// and a foreign probe character typed to prove it can outrace any screen-based
// drain check (a probe still pty-buffered is invisible to capture-pane, renders
// after the drain verifies clean, and submits glued to the message —
// "q<message>"). The Enter gate replaces the probe: after the paste, Enter is
// withheld until the composer visibly holds the payload with nothing before
// it. The pty guarantees byte order, so a visible payload proves every earlier
// byte was consumed too.
//
// These tests drive the gate with a scripted `exec`: a fake pane whose
// composer and pty-buffer behavior is deterministic per test.

type Args = string[];
const BOX = (composer: string) => `
 ▐▛███▜▌   Claude Code v2.1.228
▝▜█████▛▘  Fable 5

────────────────────────────────────────
❯ ${composer}
────────────────────────────────────────
  ⏵⏵ bypass permissions on
`;

const PAYLOAD = "Hello world, this is the injected message body";

describe("tmuxWatchablePrefix", () => {
  test("strips whitespace and caps at 40 chars", () => {
    expect(tmuxWatchablePrefix("a b\nc")).toBe("abc");
    expect(tmuxWatchablePrefix("x".repeat(100))).toBe("x".repeat(40));
  });

  test("blank payloads and payloads containing prompt glyphs are unwatchable", () => {
    expect(tmuxWatchablePrefix(" ")).toBeNull();
    expect(tmuxWatchablePrefix("quote: ❯ something")).toBeNull();
    expect(tmuxWatchablePrefix("quote: › something")).toBeNull();
  });
});

describe("awaitTmuxComposerPayload", () => {
  test("matches when the composer shows the payload, without any keys sent", async () => {
    const sends: string[] = [];
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(PAYLOAD) };
      if (args[0] === "send-keys") sends.push(args[args.length - 1]);
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      rePaste: async () => { throw new Error("must not re-paste on a clean match"); },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(sends.length).toBe(0); // the gate observes; only the caller sends Enter
  });

  test("residue before the payload triggers drain + re-paste, then matches (the q leak, ct-47277)", async () => {
    // A late-flushing probe-era char (or stale draft byte) sits glued to the
    // front of the rendered payload. Before the gate, the blind Enter
    // submitted "q<message>". The gate must refuse, clear, re-paste, and only
    // match the clean composer.
    let composer = `q${PAYLOAD}`;
    const sends: string[] = [];
    let rePastes = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(composer) };
      if (args[0] === "send-keys") {
        const key = args[args.length - 1];
        sends.push(key);
        if (key === "C-k") composer = "";
      }
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      rePaste: async () => { rePastes++; composer = PAYLOAD; },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(rePastes).toBe(1);
    // The clearing bytes must precede the re-paste in the pty stream.
    expect(sends.filter((k) => k === "C-k").length).toBeGreaterThan(0);
  });

  test("frozen pane (deaf boot) waits for the buffered paste to flush — never re-pastes", async () => {
    // The pane is byte-identical to the pre-paste capture: the paste is still
    // pty-buffered. A re-paste here would double the message once the buffer
    // drains. The gate must wait, then match when the flush renders.
    const prePaste = BOX("");
    let polls = 0;
    let rePastes = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") {
        polls++;
        return { stdout: polls <= 5 ? prePaste : BOX(PAYLOAD) };
      }
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      prePaste,
      rePaste: async () => { rePastes++; },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(rePastes).toBe(0);
  });

  test("live empty prompt (dropped paste) re-pastes after a drain", async () => {
    // The pane changed since the paste (so it is not frozen) but the prompt
    // stays empty: the TUI woke and dropped the buffered paste wholesale.
    const prePaste = BOX("");
    let composer = ""; // pane differs from prePaste via a spinner line below
    const LIVE = (c: string) => BOX(c).replace("bypass permissions on", "bypass permissions on ⠋");
    const sends: string[] = [];
    let rePastes = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: LIVE(composer) };
      if (args[0] === "send-keys") sends.push(args[args.length - 1]);
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      prePaste,
      rePaste: async () => { rePastes++; composer = PAYLOAD; },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(rePastes).toBe(1);
    expect(sends.filter((k) => k === "C-k").length).toBeGreaterThan(0); // drained first
  });

  test("throws AGENT_STDIN_NOT_READY when the payload never renders", async () => {
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX("stuck foreign draft") };
      return { stdout: "" };
    };
    await expect(
      awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
        rePaste: async () => {},
        budgetMs: 1_500,
        exec: exec as any,
      }),
    ).rejects.toThrow(/AGENT_STDIN_NOT_READY/);
  });

  test("glyphless pane is unwatchable — nothing typed, legacy timing applies", async () => {
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "send-keys") throw new Error("must not type into a glyphless pane");
      return { stdout: "opencode ready\nno prompt glyph here\n" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      rePaste: async () => { throw new Error("must not re-paste"); },
      exec: exec as any,
    });
    expect(out).toBe("unwatchable");
  });

  test("payload containing a prompt glyph is unwatchable before any capture", async () => {
    // A quoted "❯" inside the message would break the last-glyph anchor and
    // loop the gate forever — bail to the legacy path instead.
    const exec = async (): Promise<{ stdout: string }> => {
      throw new Error("must not touch tmux at all");
    };
    const out = await awaitTmuxComposerPayload("t:0.0", "the prompt shows ❯ here", {
      rePaste: async () => {},
      exec: exec as any,
    });
    expect(out).toBe("unwatchable");
  });

  test("multi-line paste rendered as a collapsed chip counts as the payload", async () => {
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX("[Pasted text #1 +13 lines]") };
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", "line one\nline two", {
      multiline: true,
      rePaste: async () => { throw new Error("must not re-paste on a clean chip"); },
      exec: exec as any,
    });
    expect(out).toBe("matched");
  });

  test("residue before the chip fails the match and clears", async () => {
    let composer = "q[Pasted text #1 +13 lines]";
    let rePastes = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(composer) };
      if (args[0] === "send-keys" && args[args.length - 1] === "C-k") composer = "";
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", "line one\nline two", {
      multiline: true,
      rePaste: async () => { rePastes++; composer = "[Pasted text #1 +13 lines]"; },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(rePastes).toBe(1);
  });

  test("a soft-wrapped payload still matches (whitespace-insensitive prefix)", async () => {
    // The TUI wraps the box at arbitrary points, inserting newlines and
    // padding the continuation line — sometimes mid-word.
    const wrapped = `Hello world, this is the injec\n  ted message body`;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(wrapped) };
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", PAYLOAD, {
      rePaste: async () => { throw new Error("must not re-paste"); },
      exec: exec as any,
    });
    expect(out).toBe("matched");
  });
});

describe("drainTmuxComposer", () => {
  const CYCLE = ["C-a", "C-k", "BSpace"];
  // Pane whose composer shows `draft` (multi-line drafts render as
  // continuation lines under the glyph, then the box rule).
  const paneWith = (draft: string) =>
    `⏺ done\n${"─".repeat(20)}\n❯ ${draft.split("\n").join("\n  ")}\n${"─".repeat(20)}\n  ⏵⏵ bypass permissions on`;
  const fakeExec = (captures: string[]) => {
    const sends: string[] = [];
    let captureCount = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "send-keys") sends.push(args[args.length - 1]);
      if (args[0] === "capture-pane") return { stdout: captures[Math.min(captureCount++, captures.length - 1)] };
      return { stdout: "" };
    };
    return { exec, sends, captured: () => captureCount };
  };

  test("three cycles of C-a/C-k/BSpace, then stops once the prompt reads empty", async () => {
    const f = fakeExec([paneWith("")]);
    await drainTmuxComposer("t:0.0", f.exec as any);
    expect(f.sends).toEqual([...CYCLE, ...CYCLE, ...CYCLE]);
    expect(f.captured()).toBe(1);
  });

  test("keeps cycling while a multi-line draft is still visible", async () => {
    // A 7-line <session-message> draft: the first two checks still show text.
    const f = fakeExec([paneWith("<session-message>\nline\nline\nline"), paneWith("<session-message>"), paneWith("")]);
    await drainTmuxComposer("t:0.0", f.exec as any);
    expect(f.sends.length).toBe(9 * CYCLE.length);
    expect(f.sends.filter(k => k === "BSpace").length).toBe(9);
    expect(f.captured()).toBe(3);
  });

  test("gives up after DRAIN_MAX_CYCLES when the prompt never empties", async () => {
    const f = fakeExec([paneWith("stuck")]);
    await drainTmuxComposer("t:0.0", f.exec as any);
    expect(f.sends.length).toBe(DRAIN_MAX_CYCLES * CYCLE.length);
  });

  test("a glyphless pane ends the drain after the first check", async () => {
    const f = fakeExec(["no prompt here"]);
    await drainTmuxComposer("t:0.0", f.exec as any);
    expect(f.sends.length).toBe(3 * CYCLE.length);
  });
});

describe("tmuxComposerText", () => {
  test("returns the prompt line plus continuation lines up to the box rule", () => {
    const pane = `⏺ done\n${"─".repeat(20)}\n❯ first\n  second\n${"─".repeat(20)}\n  status`;
    expect(tmuxComposerText(pane)).toBe(" first\n  second");
  });
  test("empty composer reads blank; glyphless pane reads null", () => {
    expect(tmuxComposerText(`❯ \n${"─".repeat(20)}`)?.trim()).toBe("");
    expect(tmuxComposerText("nothing")).toBeNull();
  });
});
