// The one door codecast uses to change an agent's harness on this machine:
// instruction files (CLAUDE.md, AGENTS.md), hook scripts, and the agent
// settings files (~/.claude/settings.json). Every write lands here so that
//
//   1. a write that changes nothing is skipped, so the file and its mtime stay
//      as the user left them (the old hook installer re-serialized
//      settings.json on every run and reformatted the user's file);
//   2. every real change is recorded with what changed and why, so a user who
//      finds their harness different can tell whether codecast did it and
//      which action caused it. That question is otherwise unanswerable
//      (David's report, 2026-09-24).
//
// The record is an append-only JSONL file beside config.json. Any cast process
// may append; the daemon tails it, logs each change, and reports it to the
// server for the device page's change history (see harnessReport.ts).

import * as fs from "fs";
import * as path from "path";
import { atomicWriteFile } from "./atomicWrite.js";
import { defaultConfigDir } from "./config/configDir.js";
import { getVersion } from "./update.js";

export type HarnessAction = "created" | "modified" | "removed";

export interface HarnessChange {
  at: number;
  /** Path with the home directory shown as ~. */
  file: string;
  action: HarnessAction;
  /** What part of the file this was: "hooks", "section:memory", "model", ... */
  what: string;
  /** The action that caused it, in words a user recognizes. */
  why: string;
  /** True when no person asked for this change at the moment it happened. */
  automatic: boolean;
  version: string;
  bytes_before: number;
  bytes_after: number;
}

export interface HarnessCause {
  why: string;
  automatic: boolean;
}

const LEDGER_FILE = "harness-changes.jsonl";
const LEDGER_KEEP = 500;

// CODECAST_HARNESS_LEDGER moves the file; the test preload points it at a
// temp file so no test run can write into a real user's change history.
export function harnessLedgerPath(): string {
  return process.env.CODECAST_HARNESS_LEDGER || path.join(defaultConfigDir(), LEDGER_FILE);
}

function homeRelative(file: string): string {
  const home = process.env.HOME || "";
  return home && file.startsWith(home + path.sep) ? "~" + file.slice(home.length) : file;
}

// The cause of every write in this process, unless a caller scopes its own.
// A child `cast` started by the daemon inherits it through the environment, so
// `cast install chat` run because a team turned chat on reads as that, not as
// a command someone typed.
let scoped: HarnessCause | null = null;

function processCause(): HarnessCause {
  const why = process.env.CODECAST_HARNESS_WHY;
  if (why) return { why, automatic: process.env.CODECAST_HARNESS_AUTOMATIC === "1" };
  const args = process.argv.slice(2).filter((a) => !a.startsWith("_"));
  return { why: args.length ? `cast ${args.join(" ")}` : "cast", automatic: false };
}

export function currentHarnessCause(): HarnessCause {
  return scoped ?? processCause();
}

/** Run `fn` with every harness write inside it attributed to `cause`. */
export function withHarnessCause<T>(cause: HarnessCause, fn: () => T): T {
  const prev = scoped;
  scoped = cause;
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.finally(() => { scoped = prev; }) as T;
    }
    scoped = prev;
    return out;
  } catch (err) {
    scoped = prev;
    throw err;
  }
}

/** Environment for a child `cast` whose writes belong to `cause`. */
export function harnessCauseEnv(cause: HarnessCause): Record<string, string> {
  return { CODECAST_HARNESS_WHY: cause.why, CODECAST_HARNESS_AUTOMATIC: cause.automatic ? "1" : "0" };
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** Record a change made without the writers below (a symlink, a directory). */
export function recordHarnessChange(file: string, action: HarnessAction, what: string, before: string | null = null, after: string | null = null): void {
  record(file, action, what, before, after);
}

function record(file: string, action: HarnessAction, what: string, before: string | null, after: string | null): void {
  const cause = currentHarnessCause();
  const entry: HarnessChange = {
    at: Date.now(),
    file: homeRelative(file),
    action,
    what,
    why: cause.why.slice(0, 200),
    automatic: cause.automatic,
    version: safeVersion(),
    bytes_before: before === null ? 0 : Buffer.byteLength(before),
    bytes_after: after === null ? 0 : Buffer.byteLength(after),
  };
  try {
    const ledger = harnessLedgerPath();
    fs.mkdirSync(path.dirname(ledger), { recursive: true, mode: 0o700 });
    fs.appendFileSync(ledger, JSON.stringify(entry) + "\n", { mode: 0o600 });
    trimLedger(ledger);
  } catch {
    // The record is how a user traces a change; failing to write it must never
    // fail the change itself.
  }
}

function safeVersion(): string {
  try {
    return getVersion();
  } catch {
    return "unknown";
  }
}

function trimLedger(ledger: string): void {
  const stat = fs.statSync(ledger);
  if (stat.size < 512 * 1024) return;
  const lines = fs.readFileSync(ledger, "utf-8").split("\n").filter(Boolean);
  atomicWriteFile(ledger, lines.slice(-LEDGER_KEEP).join("\n") + "\n", { mode: 0o600 });
}

/**
 * Write `next` to a harness file. Returns false, and touches nothing, when the
 * file already holds exactly these bytes. An existing file keeps its own mode;
 * `mode` applies only when this write creates the file. `executable` repairs a
 * hook script's exec bit even when the bytes already match, because a hook
 * without it fails silently inside the agent.
 */
export function writeHarnessFile(
  file: string,
  next: string,
  what: string,
  opts: { mode?: number; executable?: boolean } = {},
): boolean {
  const before = readOrNull(file);
  if (before !== next) {
    atomicWriteFile(file, next, before === null && opts.mode !== undefined ? { mode: opts.mode } : {});
    record(file, before === null ? "created" : "modified", what, before, next);
  }
  if (opts.executable) {
    try {
      const mode = fs.statSync(file).mode & 0o777;
      if ((mode & 0o111) !== 0o111) fs.chmodSync(file, mode | 0o755);
    } catch { /* raced a removal: nothing to repair */ }
  }
  return before !== next;
}

/** Remove a harness file codecast owns. Returns false when it was not there. */
export function removeHarnessFile(file: string, what: string): boolean {
  const before = readOrNull(file);
  if (before === null) return false;
  fs.unlinkSync(file);
  record(file, "removed", what, before, null);
  return true;
}

/**
 * Read a JSON settings file, let `edit` change the parsed object in place, and
 * write it back only when the result differs. A missing file starts as {}; an
 * unparseable one is left alone (we never overwrite a file we cannot read).
 * Returns whether the file changed.
 */
export function editHarnessJson(
  file: string,
  what: string,
  edit: (settings: Record<string, any>) => void,
  opts: { indent?: number; createIfMissing?: boolean } = {},
): boolean {
  const before = readOrNull(file);
  if (before === null && opts.createIfMissing === false) return false;
  let settings: Record<string, any>;
  try {
    settings = before === null ? {} : JSON.parse(before);
  } catch {
    return false;
  }
  const original = JSON.stringify(settings);
  edit(settings);
  if (JSON.stringify(settings) === original) return false;
  return writeHarnessFile(file, JSON.stringify(settings, null, opts.indent ?? jsonIndentOf(before) ?? 2) + "\n", what);
}

/** The indentation a JSON file already uses, so our rewrite keeps it. */
export function jsonIndentOf(text: string | null | undefined): number | undefined {
  const m = text?.match(/\n( +)["}\]]/);
  return m ? Math.min(m[1].length, 8) : undefined;
}

/** Newest first. */
export function readHarnessChanges(limit = 50): HarnessChange[] {
  const text = readOrNull(harnessLedgerPath());
  if (!text) return [];
  const out: HarnessChange[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    try {
      out.push(JSON.parse(lines[i]));
    } catch { /* torn line from a crashed writer */ }
  }
  return out;
}

/** One line for a log or `cast doctor`. */
export function formatHarnessChange(c: HarnessChange): string {
  const who = c.automatic ? "automatic" : "requested";
  return `${c.action} ${c.file} (${c.what}): ${c.why} [${who}, v${c.version}]`;
}

// ---------------------------------------------------------- the daemon's tail
//
// The daemon reports new changes on its heartbeat, so the device page can show
// the history of a machine that is not the one the browser runs on. The cursor
// is the `at` of the newest change the server accepted; it lives on disk so a
// restart neither resends the history nor skips what the dead daemon had not
// sent yet.

function cursorPath(): string {
  return harnessLedgerPath() + ".sent";
}

function readCursor(): number {
  const n = Number(readOrNull(cursorPath())?.trim());
  return Number.isFinite(n) ? n : 0;
}

/** Changes the server has not accepted yet, oldest first. */
export function unsentHarnessChanges(max = 50): HarnessChange[] {
  const cursor = readCursor();
  return readHarnessChanges(LEDGER_KEEP)
    .filter((c) => c.at > cursor)
    .reverse()
    .slice(0, max);
}

export function markHarnessChangesSent(changes: HarnessChange[]): void {
  if (changes.length === 0) return;
  const newest = Math.max(...changes.map((c) => c.at));
  try {
    atomicWriteFile(cursorPath(), String(newest), { mode: 0o600 });
  } catch { /* resent next beat; the server drops duplicates */ }
}
