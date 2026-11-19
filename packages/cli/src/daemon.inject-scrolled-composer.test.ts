import { describe, expect, test } from "bun:test";
import { awaitTmuxComposerPayload, composerReadHeight, tmuxComposerHoldsPayload, tmuxComposerText, tmuxPromptStillHasInput } from "./daemon.js";

// The Enter gate (see daemon.inject-enter-gate.test.ts) on a composer that
// shows only part of its draft: a short window, a box taller than the window,
// and Claude's fullscreen box scrolled under "─── ↑ N more ───". These tests
// drive the gate with a scripted `exec`, a fake pane per test.

type Args = string[];
const BOX = (composer: string) => `
 ▐▛███▜▌   Claude Code v2.1.228
▝▜█████▛▘  Fable 5

────────────────────────────────────────
❯ ${composer}
────────────────────────────────────────
  ⏵⏵ bypass permissions on
`;



// A short window (the web terminal split sized to its panel) makes Claude Code
// scroll a wrapped composer to the cursor, so only the payload's last lines are
// on screen and its start, which the gate reads, is not. The gate held Enter
// for as long as the viewer stayed open (2026-09-24). A visible tail cannot be
// told apart from a paste that lost its start, so the gate shows itself the
// whole composer at full size and hands the size back.
describe("awaitTmuxComposerPayload in a short window", () => {
  const LONG = "we want to make changing the sharing and syncing settings of sessions agentic - so add this to cast cli as something that sessions can do";
  const TAIL = "to cast cli as something that sessions can do";

  const shortPane = (full: string, tail: string, fullHeight: boolean) => {
    const calls: Args[] = [];
    let manual = false;
    const exec = async (args: Args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: manual || fullHeight ? "220|50\n" : "100|16\n" };
      if (args[0] === "resize-window") manual = true;
      if (args[0] === "set-option") manual = false;
      return { stdout: args[0] === "capture-pane" ? BOX(manual || fullHeight ? full : tail) : "" };
    };
    return { calls, exec: exec as any, isManual: () => manual };
  };

  test("a scrolled composer is read at full size, then the size goes back", async () => {
    const pane = shortPane(LONG, TAIL, false);
    expect(await awaitTmuxComposerPayload("t:0.0", LONG, {
      allowRePaste: false, budgetMs: 2_000,
      rePaste: async () => { throw new Error("must not repeat the paste"); },
      exec: pane.exec,
    })).toBe("matched");
    expect(pane.calls.some(c => c[0] === "resize-window")).toBe(true);
    expect(pane.isManual()).toBe(false);
  });

  test("a tail at full size is a paste that lost its start, and is refused", async () => {
    const pane = shortPane(TAIL, TAIL, true);
    await expect(awaitTmuxComposerPayload("t:0.0", LONG, {
      allowRePaste: false, budgetMs: 1_000,
      rePaste: async () => { throw new Error("must not repeat the paste"); },
      exec: pane.exec,
    })).rejects.toThrow("INJECT_UNVERIFIED");
    expect(pane.calls.some(c => c[0] === "resize-window")).toBe(false);
  });

  // Grok's composer grows with the window to about half its height and draws a
  // scrollbar in its box once a draft outgrows it. A 3 KB scheduled task sat
  // whole in an idle 220x50 composer showing only its last 23 rows, was written
  // three times and then dropped (jx75w1x, 2026-11-14): the window was already
  // "full size", so the whole composer was never read.
  test("a grok composer taller than a full-size window is read at the payload's height", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => `${i + 1}. step number ${i + 1} of the scheduled task, long enough to read as a real line`);
    const payload = lines.join("\n");
    const grokBox = (rows: string[], scrollbar: boolean) => [
      " ╭" + "─".repeat(60) + "╮",
      ...rows.map((row, i) => ` │ ${i === 0 ? "❯" : " "} ${row.padEnd(150)}${scrollbar ? (i === 0 ? "▴" : i === rows.length - 1 ? "▾" : i < 3 ? "█" : "─") : " "} │`),
      " ╰" + "─".repeat(60) + "╯",
      " Ctrl+x:shortcuts",
    ].join("\n");
    const calls: Args[] = [];
    let height = 50;
    const exec = (async (args: Args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: `220|${height}\n` };
      if (args[0] === "resize-window") height = Number(args[args.indexOf("-y") + 1]);
      if (args[0] === "set-option") height = 50;
      const fits = Math.floor(height / 2) - 2;
      return { stdout: args[0] === "capture-pane" ? grokBox(lines.slice(-fits), fits < lines.length) : "" };
    }) as any;
    expect(composerReadHeight(payload)).toBeGreaterThanOrEqual(2 * lines.length + 4);
    expect(await awaitTmuxComposerPayload("t:0.0", payload, {
      allowRePaste: false, budgetMs: 2_000,
      rePaste: async () => { throw new Error("must not repeat the paste"); },
      exec,
    })).toBe("matched");
    expect(calls.some(c => c[0] === "resize-window")).toBe(true);
    expect(height).toBe(50);
  });

  // Claude draws the "↑ N more" of a scrolled composer in faint text, which the
  // composer capture strips, and its box is about half the window. A 250-line
  // paste sat whole in a resumed pane while every retry read it as glyphless
  // and held it as unverified for over an hour (jx7bj74, 2026-11-19).
  test("a claude composer scrolled past its caret, with a faint rule, is read at the payload's height", async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `${i + 1}. finding number ${i + 1} from the review lens, long enough to read as a real line`);
    const payload = lines.join("\n");
    const rule = (glyph: string, hidden: number) =>
      `\x1b[38;5;245m───\x1b[39m \x1b[2m${glyph} ${hidden} more\x1b[0m \x1b[38;5;245m${"─".repeat(150)}\x1b[39m`;
    const claudeBox = (shown: string[], hiddenAbove: number) => [
      "⏺ Earlier turn in the transcript.",
      hiddenAbove > 0 ? rule("↑", hiddenAbove) : "─".repeat(160),
      ...shown.map((row, i) => (i === 0 && hiddenAbove === 0 ? `❯ ${row}` : `  ${row}`)),
      "─".repeat(160),
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    const calls: Args[] = [];
    let height = 50;
    const exec = (async (args: Args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: `220|${height}\n` };
      if (args[0] === "resize-window") height = Number(args[args.indexOf("-y") + 1]);
      if (args[0] === "set-option") height = 50;
      const fits = Math.min(lines.length, Math.floor(height / 2) - 5);
      return { stdout: args[0] === "capture-pane" ? claudeBox(lines.slice(-fits), lines.length - fits) : "" };
    }) as any;
    expect(await awaitTmuxComposerPayload("t:0.0", payload, {
      allowRePaste: false, budgetMs: 2_000,
      rePaste: async () => { throw new Error("must not repeat the paste"); },
      exec,
    })).toBe("matched");
    expect(calls.some(c => c[0] === "resize-window")).toBe(true);
    expect(height).toBe(50);
  });

  test("a scrolled composer whose full view is not the payload is refused", async () => {
    const pane = shortPane(`draft ${LONG}`, TAIL, false);
    await expect(awaitTmuxComposerPayload("t:0.0", LONG, {
      allowRePaste: false, budgetMs: 1_000,
      rePaste: async () => { throw new Error("must not repeat the paste"); },
      exec: pane.exec,
    })).rejects.toThrow(/INJECT_UNVERIFIED|AGENT_STDIN_NOT_READY/);
    expect(pane.isManual()).toBe(false);
  });
});

// Claude Code 2.1.326, fullscreen: a draft taller than the composer box shows
// only its last rows under "─── ↑ N more ───", with no ❯ on screen. The last
// glyph on the pane is then a transcript row, and the gate read everything
// from there down as the composer: a typed 68-row report never got its Enter
// and held its session's queue for 11 hours (jx783qs, 2026-11-17).
describe("an overflowed fullscreen composer", () => {
  const rule = "─".repeat(120);
  const lines = Array.from({ length: 71 }, (_, i) => `line ${i + 1} of the long typed message, with enough words to look like real text`);
  const payload = `<session-message from="jx704ck">\n${lines.join("\n")}\n</session-message>`;
  const rows = payload.split("\n");
  // The box shows half the window less five rows, as measured on the real client.
  const screen = (height: number, draft = rows) => {
    const fits = Math.floor(height / 2) - 5;
    const box = draft.length > fits
      ? [`─── ↑ ${draft.length - fits} more ${"─".repeat(100)}`, ...draft.slice(-fits).map(row => `  ${row}`)]
      : [rule, `❯ ${draft[0]}`, ...draft.slice(1).map(row => `  ${row}`)];
    return ["❯ <scheduled-task title=\"Worker ended its turn\">", "⏺ This notice is from the worker's restart turn.", "✻ Cogitated for 15s · done 11:30 PM", ...box, rule, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
  };

  test("a typed payload whose end fills the box is matched without a second write", async () => {
    expect(await awaitTmuxComposerPayload("t:0.0", payload, {
      typed: true, allowRePaste: false, budgetMs: 1_000,
      rePaste: async () => { throw new Error("must not type the message again"); },
      exec: async () => ({ stdout: screen(50), stderr: "" }),
    })).toBe("matched");
  });

  test("an earlier attempt's draft is read at full window size and matched", async () => {
    let height = 50;
    const calls: Args[] = [];
    const exec = (async (args: Args) => {
      calls.push(args);
      if (args[0] === "display-message") return { stdout: `220|${height}\n` };
      if (args[0] === "resize-window") height = Number(args[args.indexOf("-y") + 1]);
      if (args[0] === "set-option") height = 50;
      return { stdout: args[0] === "capture-pane" ? screen(height) : "" };
    }) as any;
    expect(await awaitTmuxComposerPayload("t:0.0", payload, {
      allowRePaste: false, budgetMs: 2_000,
      rePaste: async () => { throw new Error("must not type the message again"); },
      exec,
    })).toBe("matched");
    expect(calls.some(c => c[0] === "resize-window")).toBe(true);
    expect(height).toBe(50);
  });

  test("someone else's long draft is not taken for the payload", async () => {
    const other = rows.map(row => row.replace("typed message", "private note"));
    await expect(awaitTmuxComposerPayload("t:0.0", payload, {
      typed: true, allowRePaste: false, budgetMs: 1_000,
      rePaste: async () => { throw new Error("must not type over a draft"); },
      exec: async () => ({ stdout: screen(50, other), stderr: "" }),
    })).rejects.toThrow(/INJECT_UNVERIFIED|AGENT_STDIN_NOT_READY|not appeared intact/);
  });

  test("the draft reads as text at the prompt, before and after an Enter", () => {
    expect(tmuxComposerText(screen(50))).toContain("line 71 of the long typed message");
    expect(tmuxComposerText(screen(50))).not.toContain("Cogitated");
    expect(tmuxComposerHoldsPayload(screen(50), payload)).toBe(false);
    expect(tmuxComposerHoldsPayload(screen(200), payload)).toBe(true);
    // The submit check knows only the payload's first line, which is off the screen.
    expect(tmuxPromptStillHasInput(screen(50), rows[0].slice(0, 40))).toBe(true);
    expect(tmuxPromptStillHasInput(screen(50, ["short"]), rows[0].slice(0, 40))).toBe(false);
  });
});
