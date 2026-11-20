// Orca (stablyai's agent workspace app) runs each terminal in its own pty and
// sets TERM_PROGRAM=Orca. It has no AppleScript dictionary, so the iTerm2
// fallback can never reach one (28k failed attempts on one machine, 2026-11).
// Its public CLI can: `orca terminal send` writes bytes to a terminal and
// `orca terminal read` returns its last rows, both addressed by a handle.
//
// Handles are runtime-scoped: the ORCA_TERMINAL_HANDLE an agent was started
// with goes stale when Orca restarts. Its ORCA_PANE_KEY ("<tabId>:<leafId>")
// does not, and `terminal list` reports both halves for every live terminal,
// so the current handle is looked up from the pane key on every delivery.
//
// `send --text` writes the bytes as given (checked against Orca 1.4.159): no
// bracketed paste even when the program inside asked for it, and no key names.
// Pastes are wrapped here, and keys are sent as their escape sequences.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileAsync } from "./proc.js";
import type { PaneTransport } from "./paneTransport.js";
import { TerminalHoldError } from "./terminalHold.js";
import { prepareInjectedContent } from "./tmuxPaste.js";

const ORCA_TIMEOUT_MS = 10_000;
const SCREEN_ROWS = 60;

const ORCA_KEY_SEQUENCES: Record<string, string> = {
  Return: "\r", Enter: "\r", Escape: "\x1b",
  Up: "\x1b[A", Down: "\x1b[B", Left: "\x1b[D", Right: "\x1b[C",
  Tab: "\t", Backspace: "\x7f", Delete: "\x1b[3~", Space: " ",
};

/** The bytes for a poll step's key; a digit or letter is itself. */
export function orcaKeyBytes(key: string): string {
  return ORCA_KEY_SEQUENCES[key] ?? key;
}

/** Message text as Orca must receive it: wrapped as a bracketed paste for a client that takes one. */
export function orcaPastePayload(text: string, bracketed: boolean): string {
  const shaped = prepareInjectedContent(text, { bracketed });
  return bracketed ? `\x1b[200~${shaped}\x1b[201~` : shaped;
}

/** The Orca CLI: on PATH when the person installed the shell command, else inside the app bundle. */
export function findOrcaCli(
  exists: (p: string) => boolean = fs.existsSync,
  pathEnv = process.env.PATH ?? "",
  home = os.homedir(),
): string | null {
  const candidates = [
    ...pathEnv.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "orca")),
    "/Applications/Orca.app/Contents/Resources/bin/orca",
    path.join(home, "Applications/Orca.app/Contents/Resources/bin/orca"),
  ];
  return candidates.find((c) => exists(c)) ?? null;
}

/** The `result` of a `--json` reply; a refused request (`"ok": false`) throws its error code. */
export function parseOrcaJson(stdout: string): any {
  const parsed = JSON.parse(stdout);
  if (parsed?.ok === false) throw new Error(`orca: ${parsed.error?.code ?? parsed.error?.message ?? "request failed"}`);
  return parsed?.result;
}

type OrcaTerminal = { handle: string; tabId: string; leafId: string; writable?: boolean };

/** The live terminal whose tab and leaf make up `paneKey`. */
export function terminalForPaneKey(terminals: OrcaTerminal[], paneKey: string): OrcaTerminal | null {
  return terminals.find((t) => `${t.tabId}:${t.leafId}` === paneKey) ?? null;
}

/**
 * The terminal's last SCREEN_ROWS rows. A plain `read --limit` returns only
 * what arrived since the runtime's own read position: one line (`❯ BBB`) for
 * an idle Claude Code, where the dialog guard needs the composer and anything
 * drawn above it. A cursor read from the latest cursor back returns the rows.
 */
export async function readOrcaScreen(call: (args: string[]) => Promise<any>, handle: string): Promise<string> {
  const latest = Number((await call(["terminal", "read", "--terminal", handle, "--limit", "1"]))?.terminal?.latestCursor);
  if (!Number.isFinite(latest)) throw new Error(`orca: no cursor for terminal ${handle}`);
  const from = Math.max(0, latest - SCREEN_ROWS);
  const tail = (await call(["terminal", "read", "--terminal", handle, "--cursor", String(from), "--limit", String(SCREEN_ROWS)]))?.terminal?.tail;
  return Array.isArray(tail) ? tail.join("\n") : "";
}

export type OrcaIo = {
  cli: () => string | null;
  run: (cli: string, args: string[]) => Promise<string>;
};

const ORCA_IO: OrcaIo = {
  cli: () => findOrcaCli(),
  run: async (cli, args) => (await execFileAsync(cli, args, { timeout: ORCA_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout,
};

/**
 * The pane transport for the Orca terminal an agent started with `paneKey`
 * runs in. An Orca the daemon cannot reach (no CLI, runtime not answering)
 * holds the message with the terminal named, as Ghostty does: retrying never
 * helps, and a failure streak would stop the person's own agent.
 */
export async function orcaPane(paneKey: string | undefined, bracketed: boolean, log: (line: string) => void, io: OrcaIo = ORCA_IO): Promise<PaneTransport> {
  if (!paneKey) throw new TerminalHoldError("Orca", "its pane could not be identified (no ORCA_PANE_KEY in the agent's environment)");
  const cli = io.cli();
  if (!cli) throw new TerminalHoldError("Orca", "the orca CLI was not found; install it from Orca's settings");
  const call = async (args: string[]) => parseOrcaJson(await io.run(cli, [...args, "--json"]));

  let terminals: OrcaTerminal[];
  try {
    terminals = (await call(["terminal", "list"]))?.terminals ?? [];
  } catch (err) {
    log(`Orca CLI unavailable: ${err instanceof Error ? err.message : String(err)}`);
    throw new TerminalHoldError("Orca", "Orca is not answering; open the Orca app");
  }
  const terminal = terminalForPaneKey(terminals, paneKey);
  if (!terminal) throw new Error(`Orca terminal not found for pane ${paneKey}`);
  if (terminal.writable === false) throw new TerminalHoldError("Orca", "the terminal is read-only");
  const handle = terminal.handle;
  const send = (text: string) => call(["terminal", "send", "--terminal", handle, "--text", text]);

  return {
    name: `Orca terminal ${handle}`,
    sendText: async (text, beforeInput) => {
      await beforeInput?.();
      await send(orcaPastePayload(text, bracketed));
    },
    sendKey: (key) => send(orcaKeyBytes(key)),
    sendKeystrokes: (keys) => send(keys),
    readScreen: () => readOrcaScreen(call, handle),
  };
}
