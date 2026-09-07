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

  test("live empty prompt (dropped paste) re-pastes without typing into it (ct-49750)", async () => {
    // The pane changed since the paste (so it is not frozen) but the prompt
    // stays empty: either the TUI woke and dropped the buffered paste, or it is
    // repainting a spinner while its input handler is still blocked. The two
    // look identical on screen, so the clearing keys that used to precede this
    // re-paste were sent into a composer that could not act on them and stored
    // them as message text instead — six C-a/C-k pairs in front of the payload.
    // The re-paste still happens; a doubled result is caught by the count below
    // rather than pre-empted by keys.
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
    expect(sends).toEqual([]); // nothing typed into a composer that shows nothing
  });

  test("two copies at the prompt are refused, cleared and re-pasted (ct-49753)", async () => {
    // claude holding the composer in history-recall mode does not act on the
    // clearing keys, so a re-paste landed on top of a first copy the gate had
    // already read as foreign and the message was recorded twice. Two copies on
    // screen is the doubling signature: refuse, clear (the composer shows text,
    // so the keys land), re-paste, and match only the single copy.
    let composer = `${PAYLOAD}${PAYLOAD}`;
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
    expect(sends.filter((k) => k === "C-k").length).toBeGreaterThan(0);
  });

  test("a doubled paste chip is refused too", async () => {
    // A multi-line payload collapses to a chip, so the second copy shows up as
    // a second chip rather than as repeated text.
    let composer = "[Pasted text #1 +3 lines][Pasted text #2 +3 lines]";
    let rePastes = 0;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(composer) };
      if (args[0] === "send-keys" && args[args.length - 1] === "C-k") composer = "";
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", "one\ntwo\n\nthree", {
      multiline: true,
      rePaste: async () => { rePastes++; composer = "[Pasted text #1 +3 lines]"; },
      exec: exec as any,
    });
    expect(out).toBe("matched");
    expect(rePastes).toBe(1); // the doubled chip never matched
  });

  test("a payload that repeats its own opening still matches", async () => {
    // The count works by looking for the watched prefix a second time, which a
    // self-repeating payload satisfies on its own. Such a payload opts out and
    // keeps the plain prefix match rather than failing every delivery.
    const repeating = `${"z".repeat(60)}${"z".repeat(60)}`;
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: BOX(repeating) };
      if (args[0] === "send-keys") throw new Error("must not type over a clean composer");
      return { stdout: "" };
    };
    const out = await awaitTmuxComposerPayload("t:0.0", repeating, {
      rePaste: async () => { throw new Error("must not re-paste"); },
      exec: exec as any,
    });
    expect(out).toBe("matched");
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

// ---------------------------------------------------------------------------
// Per-client composer shapes (the D0 matrix's CI half, ct-49536)
//
// The real-client matrix in messaging.e2e.test.ts needs the binaries installed,
// so it skips on every CI runner. These frames were captured from live panes of
// each client (2026-09-06) with the same multi-line payload pasted and not yet
// submitted, so the gate's per-client behaviour is pinned everywhere — a
// renamed paste chip or a lost prompt glyph fails here without a binary.
// ---------------------------------------------------------------------------

const MULTILINE = "matrix payload first line\nsecond line\n\nfourth after a blank line";

const CLAUDE_PASTED = `
 ▐▛███▛█   Claude Code v2.1.263
▝▜██████▀  Fable 5.1 with high effort · API Usage Billing
  ▝▝ ▝▝    /private/tmp/matrix-claude
                                                       ● high · /effort
────────────────────────────────────────────────────────────────────────
❯ [Pasted text #1 +3 lines]
────────────────────────────────────────────────────────────────────────
  paste again to expand
`;

const CODEX_PASTED = `
╭─────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.153.4)              │
│                                         │
│ model:       matrix   /model to change  │
│ directory:   /private/tmp/matrix-codex  │
│ permissions: YOLO mode                  │
╰─────────────────────────────────────────╯
› matrix payload first line
  second line
  fourth after a blank line
  matrix default · /private/tmp/matrix-codex
`;

const GROK_PASTED = `
  /private/tmp/matrix-grok                                    1.5K / 200K
                          ╭──────────────────────────────────────────────╮
                          │matrix payload first line                     │
                          │second line                                   │
                          │                                              │
                          │fourth after a blank line                     │
                          ╰─ paste again or double-click to expand ──────╯
  ╭────────────────────────────────────────────────────────────────────╮
  │ ❯ [Pasted: 4 lines]                                                │
  ╰──────────────────────────────── matrix · always-approve ───────────╯
  Enter:send  │  Shift+Tab:mode  │  Ctrl+x:shortcuts
`;

const OPENCODE_PASTED = `
                    ┃
                    ┃  [Pasted ~4 lines]
                    ┃
                    ┃  Build · matrix-model matrix
                    ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                                   tab agents  ctrl+p commands
  /private/tmp/matrix-opencode                          1.18.29
`;

describe("awaitTmuxComposerPayload — real client composers", () => {
  const gate = async (pane: string, payload: string): Promise<string> => {
    const exec = async (args: Args): Promise<{ stdout: string }> => {
      if (args[0] === "capture-pane") return { stdout: pane };
      if (args[0] === "send-keys") throw new Error(`must not type into a settled composer: ${args.join(" ")}`);
      return { stdout: "" };
    };
    return awaitTmuxComposerPayload("t:0.0", payload, {
      multiline: payload.includes("\n"),
      rePaste: async () => { throw new Error("must not re-paste a composer that holds the payload"); },
      budgetMs: 2_000,
      exec: exec as any,
    });
  };

  test("claude collapses the paste to a chip and the gate accepts it", async () => {
    expect(await gate(CLAUDE_PASTED, MULTILINE)).toBe("matched");
  });

  test("codex renders the lines at its › prompt (the blank line is not drawn)", async () => {
    // The composer drops the empty line; the gate compares whitespace-free, so
    // the prefix still matches what was pasted.
    expect(await gate(CODEX_PASTED, MULTILINE)).toBe("matched");
  });

  test("grok's own chip wording is accepted too", async () => {
    // "[Pasted: 4 lines]" — a different string from claude's, matched by shape.
    expect(await gate(GROK_PASTED, MULTILINE)).toBe("matched");
  });

  test("opencode has no prompt glyph, so the gate hands back to legacy timing", async () => {
    // Nothing is typed and nothing is re-pasted: the post-submit verifier is
    // the safety net for glyphless clients.
    expect(await gate(OPENCODE_PASTED, MULTILINE)).toBe("unwatchable");
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

  // ct-49610: on a pane that has painted its composer but is not reading stdin
  // the clearing keys are recorded as message text — claude 2.1.263 draws them
  // as nothing, so the Enter gate reads a clean composer and submits
  // "\v\x01\v\x01\v<payload>". An empty composer has nothing to clear, so
  // `onlyWhenDrafted` withholds the keys there.
  test("onlyWhenDrafted: an empty composer gets no clearing keys", async () => {
    const f = fakeExec([paneWith("")]);
    expect(await drainTmuxComposer("t:0.0", f.exec as any, { onlyWhenDrafted: true })).toBe(false);
    expect(f.sends).toEqual([]);
  });

  test("onlyWhenDrafted: a draft at the prompt is still drained", async () => {
    const f = fakeExec([paneWith("half-typed thought"), paneWith("")]);
    expect(await drainTmuxComposer("t:0.0", f.exec as any, { onlyWhenDrafted: true })).toBe(true);
    expect(f.sends).toEqual([...CYCLE, ...CYCLE, ...CYCLE]);
  });

  test("onlyWhenDrafted: an unreadable composer is not proof of empty", async () => {
    // A glyphless client, or a redraw that hid the box: nothing was proven, so
    // the legacy blind drain stands.
    const f = fakeExec(["no composer here"]);
    expect(await drainTmuxComposer("t:0.0", f.exec as any, { onlyWhenDrafted: true })).toBe(true);
    expect(f.sends.length).toBe(3 * CYCLE.length);
  });

  test("without the flag the keys always go, whatever the pane shows", async () => {
    const f = fakeExec([paneWith("")]);
    expect(await drainTmuxComposer("t:0.0", f.exec as any)).toBe(true);
    expect(f.sends).toEqual([...CYCLE, ...CYCLE, ...CYCLE]);
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
