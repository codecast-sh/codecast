import { describe, expect, it } from "bun:test";
import { TmuxControlClient, buildSeed, parseSeedState, SEED_STATE_FIELDS } from "./controlClient.js";
import { hasTmux, tmuxExecSync } from "../tmux.js";

describe("TmuxControlClient.start", () => {
  // Regression: a failed attach (dead target, hung tmux server) used to
  // RESOLVE start() with fallback geometry and an empty seed — the server
  // then sent "ready" and the web client rendered a blank pane with a healthy
  // status dot. start() must reject so the client gets an error it can show.
  it.skipIf(!hasTmux())("rejects when the attach target does not exist", async () => {
    const client = new TmuxControlClient(
      { kind: "attach", target: "cast-term-does-not-exist-000", readOnly: true },
      { onOutput() {}, onExit() {} },
    );
    try {
      await expect(client.start(80, 24)).rejects.toThrow();
    } finally {
      client.close();
    }
  });
});

describe("TmuxControlClient interactive attach", () => {
  // Regression: an interactive viewer is usually the pane's ONLY client, so
  // with `window-size largest` the size it imposes stuck after it detached —
  // an agent pane was found at 6x11 this way, and Claude Code kept painting
  // itself into that. Detaching must hand the window back at the size it had,
  // and must not leave it in manual sizing (a later real client must still
  // be able to impose its own size).
  it.skipIf(!hasTmux())("restores the window size on detach", async () => {
    const name = `cast-term-test-restore-${process.pid}`;
    const size = () => tmuxExecSync(["display-message", "-p", "-t", name, "#{window_width}x#{window_height}"], { encoding: "utf-8" }).trim();
    tmuxExecSync(["new-session", "-d", "-s", name, "-x", "100", "-y", "30", "sleep 30"]);
    const client = new TmuxControlClient(
      { kind: "attach", target: name, readOnly: false },
      { onOutput() {}, onExit() {} },
    );
    try {
      // The hello size is a pre-layout guess: it must not touch the pane.
      await client.start(80, 24);
      expect(size()).toBe("100x30");
      client.resize(60, 10);
      await new Promise((r) => setTimeout(r, 300));
      expect(size()).toBe("60x10");
      client.close();
      await new Promise((r) => setTimeout(r, 700));
      expect(size()).toBe("100x30");
      expect(tmuxExecSync(["show-options", "-w", "-t", name, "window-size"], { encoding: "utf-8" }).trim()).toBe("");
    } finally {
      try { client.close(); } catch {}
      try { tmuxExecSync(["kill-session", "-t", name]); } catch {}
    }
  });

  // Regression: on daemon shutdown close()'s restore rides a stdin write the
  // process never lives to see drained, and verifyRestore (on child exit)
  // never runs — a pane stayed at 165x6 across a restart (2026-08-21).
  // closeSync must leave the window restored the moment it RETURNS.
  it.skipIf(!hasTmux())("closeSync restores the window synchronously", async () => {
    const name = `cast-term-test-closesync-${process.pid}`;
    const size = () => tmuxExecSync(["display-message", "-p", "-t", name, "#{window_width}x#{window_height}"], { encoding: "utf-8" }).trim();
    tmuxExecSync(["new-session", "-d", "-s", name, "-x", "100", "-y", "30", "sleep 30"]);
    const client = new TmuxControlClient(
      { kind: "attach", target: name, readOnly: false },
      { onOutput() {}, onExit() {} },
    );
    try {
      await client.start(80, 24);
      client.resize(60, 6);
      await new Promise((r) => setTimeout(r, 300));
      expect(size()).toBe("60x6");
      client.closeSync();
      expect(size()).toBe("100x30");
      expect(tmuxExecSync(["show-options", "-w", "-t", name, "window-size"], { encoding: "utf-8" }).trim()).toBe("");
    } finally {
      try { client.closeSync(); } catch {}
      try { tmuxExecSync(["kill-session", "-t", name]); } catch {}
    }
  });
});

describe("seed state", () => {
  const fields = (over: Partial<Record<(typeof SEED_STATE_FIELDS)[number], number>>) =>
    SEED_STATE_FIELDS.map((f) => String(over[f] ?? 0)).join("|");

  it("parses tmux's pane flags into one state", () => {
    const st = parseSeedState(fields({ cursor_x: 2, cursor_y: 8, cursor_flag: 1, alternate_on: 1, mouse_any_flag: 1, mouse_sgr_flag: 1 }));
    expect(st).toEqual({
      cursorX: 2, cursorY: 8, cursorVisible: true, alternate: true,
      mouse: "any", mouseSgr: true, keypadCursor: false, keypad: false,
    });
    // An empty reply (old tmux, timeout) must not hide the cursor.
    expect(parseSeedState("").cursorVisible).toBe(true);
    expect(parseSeedState(fields({ cursor_flag: 0 })).cursorVisible).toBe(false);
  });

  it("replays the modes a capture cannot carry, cursor visibility last", () => {
    // A Claude Code fullscreen pane: alt screen, any-motion SGR mouse, cursor shown at (2,8).
    const seed = buildSeed(["a", "b", "", ""], 4, parseSeedState(fields({ cursor_x: 2, cursor_y: 1, cursor_flag: 1, alternate_on: 1, mouse_any_flag: 1, mouse_sgr_flag: 1 })));
    expect(seed.startsWith("\x1b[?1049h")).toBe(true);
    expect(seed).toContain("a\r\nb\r\n\r\n\x1b[0m"); // 2 rows + 2 pad rows = 4
    expect(seed).toContain("\x1b[0m\r\x1b[2A\x1b[2C"); // walk from the last row to (2,1)
    expect(seed).toContain("\x1b[?1003h\x1b[?1006h");
    expect(seed.endsWith("\x1b[?25h")).toBe(true);
    // A plain shell pane: normal screen, no mouse, cursor hidden by a spinner.
    const plain = buildSeed(["$ "], 3, parseSeedState(fields({ cursor_x: 2, cursor_flag: 0 })));
    expect(plain.startsWith("$ ")).toBe(true);
    expect(plain).not.toContain("1049");
    expect(plain).not.toContain("?100");
    expect(plain.endsWith("\x1b[?25l")).toBe(true);
  });
});
