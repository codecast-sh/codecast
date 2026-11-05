// Ghostty (1.3 and later on macOS) exposes its terminals to AppleScript: each
// one has a tty, takes text "as if pasted" (`input text`, which brackets the
// paste when the program inside turned bracketed paste on) and takes named
// key presses (`send key`). The daemon delivers to an agent a person started
// in Ghostty through these, addressing the terminal by its tty so a
// background tab is reached without being focused.
//
// The dictionary has no screen read. The one way to read a terminal's screen
// without focusing it is the `write_screen_file:copy` action, which writes the
// visible screen to a temp file and puts that file's path on the clipboard.
// readGhosttyScreen saves every item on the clipboard first and puts them back
// in the same script, so the person's clipboard is unchanged afterwards.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "./proc.js";
import type { PaneTransport } from "./paneTransport.js";
import { TerminalHoldError } from "./terminalHold.js";
import { prepareInjectedContent } from "./tmuxPaste.js";

const OSASCRIPT_TIMEOUT_MS = 15_000;

/** Ghostty's name for a key: W3C key codes in lower camel case. */
const GHOSTTY_KEY_NAMES: Record<string, string> = {
  Return: "enter", Enter: "enter", "\r": "enter", "\n": "enter",
  Escape: "escape", "\x1b": "escape",
  Up: "arrowUp", Down: "arrowDown", Left: "arrowLeft", Right: "arrowRight",
  Tab: "tab", "\t": "tab", Space: "space", " ": "space",
  Backspace: "backspace", "\x7f": "backspace", Delete: "delete",
};

/** The `send key` name for a poll step's key or one keystroke character. */
export function ghosttyKeyName(key: string): string {
  if (GHOSTTY_KEY_NAMES[key]) return GHOSTTY_KEY_NAMES[key];
  if (/^[0-9]$/.test(key)) return `digit${key}`;
  return key.toLowerCase();
}

const TERMINAL_BY_TTY = `set targetTty to item 1 of argv
  tell application "Ghostty"
    set matches to (terminals whose tty is targetTty)
    if (count of matches) is 0 then error "Ghostty terminal not found for TTY " & targetTty
    set t to item 1 of matches`;

const INPUT_TEXT_SCRIPT = `on run argv
  ${TERMINAL_BY_TTY}
    input text (item 2 of argv) to t
  end tell
end run`;

const SEND_KEYS_SCRIPT = `on run argv
  ${TERMINAL_BY_TTY}
    repeat with i from 2 to count of argv
      send key (item i of argv) to t
    end repeat
  end tell
end run`;

// JXA, for the pasteboard bridge. Fails without touching the clipboard when
// the terminal is missing, and restores it whatever the action did.
const READ_SCREEN_SCRIPT = `ObjC.import("AppKit");
function run(argv) {
  const app = Application("Ghostty");
  const matches = app.terminals.whose({ tty: argv[0] });
  if (matches.length === 0) throw new Error("Ghostty terminal not found for TTY " + argv[0]);
  const pb = $.NSPasteboard.generalPasteboard;
  const saved = [];
  const items = pb.pasteboardItems;
  for (let i = 0; i < items.count; i++) {
    const item = items.objectAtIndex(i);
    const types = item.types;
    const copy = $.NSPasteboardItem.alloc.init;
    for (let j = 0; j < types.count; j++) {
      const type = types.objectAtIndex(j);
      const data = item.dataForType(type);
      if (data) copy.setDataForType(data, type);
    }
    saved.push(copy);
  }
  const before = pb.changeCount;
  let file = "";
  try {
    app.performAction("write_screen_file:copy", { on: matches[0] });
    if (pb.changeCount !== before) file = ObjC.unwrap(pb.stringForType($.NSPasteboardTypeString)) || "";
  } finally {
    pb.clearContents;
    if (saved.length) pb.writeObjects($(saved));
  }
  return file;
}`;

async function osascript(args: string[]): Promise<string> {
  return (await execFileAsync("osascript", args, { timeout: OSASCRIPT_TIMEOUT_MS })).stdout;
}

const PROBE_SCRIPT = `on run argv
  tell application "Ghostty" to return count of (terminals whose tty is (item 1 of argv))
end run`;

/**
 * Whether the daemon can drive the Ghostty terminal on `tty`. "unscriptable"
 * covers every way the dictionary is out of reach: a Ghostty older than 1.3,
 * `macos-applescript = false`, or no Automation grant for the daemon (-1743).
 * None of those is fixed by retrying, so the caller holds the message instead.
 */
export async function probeGhostty(tty: string): Promise<{ state: "ok" | "not_found" } | { state: "unscriptable"; detail: string }> {
  try {
    const count = Number((await osascript(["-e", PROBE_SCRIPT, tty])).trim());
    return { state: count > 0 ? "ok" : "not_found" };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { state: "unscriptable", detail: (e.stderr || e.message || String(err)).trim() };
  }
}

/** Paste text into the Ghostty terminal on `tty`. */
export async function ghosttyInputText(tty: string, text: string): Promise<void> {
  await osascript(["-e", INPUT_TEXT_SCRIPT, tty, text]);
}

/** Press each named key, in order, in the Ghostty terminal on `tty`. */
export async function ghosttySendKeys(tty: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await osascript(["-e", SEND_KEYS_SCRIPT, tty, ...keys.map(ghosttyKeyName)]);
}

/** A path Ghostty's screen dump writes: `<tmpdir>/<random>/screen.txt`. The
 *  path arrives through the clipboard, so anything else (a copy the person
 *  made in the same instant) is refused rather than read or deleted. */
export function isGhosttyScreenFile(file: string, tmpDir = os.tmpdir()): boolean {
  if (!file || path.basename(file) !== "screen.txt") return false;
  const real = (p: string) => p.replace(/^\/private(?=\/)/, "").replace(/\/+$/, "");
  const root = path.dirname(path.dirname(real(file)));
  // Ghostty's TMPDIR is the per-user /var/folders/…/T even when the daemon's is not.
  return root === real(tmpDir) || /^\/var\/folders\/[^/]+\/[^/]+\/T$/.test(root);
}

/** The visible screen of the Ghostty terminal on `tty`. */
export async function readGhosttyScreen(tty: string): Promise<string> {
  const file = (await osascript(["-l", "JavaScript", "-e", READ_SCREEN_SCRIPT, tty])).trim();
  if (!isGhosttyScreenFile(file)) throw new Error(`Ghostty did not write a screen file for TTY ${tty}`);
  try {
    return await fs.promises.readFile(file, "utf-8");
  } finally {
    // Ghostty leaves one temp dir per dump until it quits.
    await fs.promises.rm(path.dirname(file), { recursive: true, force: true }).catch(() => {});
  }
}

export type GhosttyIo = {
  probe: typeof probeGhostty;
  inputText: typeof ghosttyInputText;
  sendKeys: typeof ghosttySendKeys;
  readScreen: typeof readGhosttyScreen;
};
const GHOSTTY_IO: GhosttyIo = { probe: probeGhostty, inputText: ghosttyInputText, sendKeys: ghosttySendKeys, readScreen: readGhosttyScreen };

/**
 * The pane transport for the Ghostty terminal on `tty`. A Ghostty the daemon
 * cannot script holds the message with the terminal named (terminalHold.ts)
 * rather than failing: retrying never helps, and a failure streak would stop
 * the person's own agent to resume it elsewhere.
 */
export async function ghosttyPane(tty: string, bracketed: boolean, log: (line: string) => void, io: GhosttyIo = GHOSTTY_IO): Promise<PaneTransport> {
  const probe = await io.probe(tty);
  if (probe.state === "unscriptable") {
    log(`Ghostty scripting unavailable for TTY ${tty}: ${probe.detail}`);
    throw new TerminalHoldError("Ghostty");
  }
  if (probe.state === "not_found") throw new Error(`Ghostty terminal not found for TTY ${tty}`);
  return {
    name: `Ghostty for TTY ${tty}`,
    // `input text` is a paste: Ghostty brackets it when the program asked for
    // bracketed paste, and an unverified client gets flattened text.
    sendText: async (text, beforeInput) => {
      await beforeInput?.();
      await io.inputText(tty, prepareInjectedContent(text, { bracketed }));
    },
    sendKey: (key) => io.sendKeys(tty, [key]),
    sendKeystrokes: (keys) => io.sendKeys(tty, [...keys]),
    readScreen: () => io.readScreen(tty),
  };
}
