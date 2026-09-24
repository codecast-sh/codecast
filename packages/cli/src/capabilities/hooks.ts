// One way to put a codecast hook into `~/.claude/settings.json`.
//
// Three independent algorithms used to do this, and they disagreed on the bytes:
//
//   installHookScript      (index.ts)         indent 4, timeout 5, matched by filename
//   installStableHook      (stableContext.ts) indent 4, timeout 30, plus a chmod repair
//   installOrchestration   (index.ts)         indent 2, mode 0600, matched by a path marker
//
// Because each rewrote the WHOLE file in its own style, enabling stable and then
// orchestration reformatted every line, and enabling them the other way round
// reformatted them back. A user watching `settings.json` in git saw the file
// churn on its own. Worse, each merge was hand-rolled, so "is my hook already
// here" was answered three slightly different ways and none of them could
// remove a hook cleanly.
//
// This module answers all of it once, on top of `applyOwnedJson`: the ownership
// ledger records the exact hook entry we wrote, so an update replaces what we
// put there, a removal takes only what we own, and a hook a user edited by hand
// is left alone and reported rather than silently reverted.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { applyOwnedJson, decodeKeyPath, readLedger, type ApplyResult, type OwnedKey } from "./ownedJson.js";

/** One entry inside a `settings.json` hook matcher. Claude Code's shape. */
export interface HookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

export interface InstallOwnedHookOptions {
  /** Seconds Claude Code waits for the hook. The three old writers used 5 and
   *  30; it stays per-hook because a status ping and a context fetch genuinely
   *  differ, and homogenising them would change behaviour. */
  timeout?: number;
  /** Mode for the settings file itself. Defaults to 0600 — it can carry env
   *  values and tool grants, so it is not world readable. */
  mode?: number;
  /** Where settings.json lives. Injectable so tests never touch a real HOME. */
  settingsPath?: string;
  /** Plan the change without writing, for a preview. */
  dryRun?: boolean;
}

export function defaultSettingsPath(home = os.homedir()): string {
  return path.join(home, ".claude", "settings.json");
}

/**
 * The key path a hook for `event` occupies.
 *
 * We own ONE matcher per event — the empty matcher, which Claude Code reads as
 * "every tool" — and never the array around it, so a user's own matchers under
 * the same event are untouched by anything here.
 */
function matcherKeyPath(event: string): string[] {
  return ["hooks", event];
}

/**
 * Merge our hook into whatever matchers already exist under `event`.
 *
 * What we own is the ENTRY, not the array around it — the array is shared with
 * the user and with any other tool that writes hooks. `applyOwnedJson`'s rule is
 * per key, and it protects a key whose value we would overwrite; here we are not
 * overwriting the array, we are producing a new one that CONTAINS the user's
 * entries unchanged. So the array is rebuilt from theirs plus ours, and removal
 * takes out exactly the one command string we put in.
 *
 * The first cut of this used the ownership ledger on the array itself, and it
 * could not add a hook at all once the user had one of their own: the ledger
 * correctly reported a key it did not own and declined to write. Correct rule,
 * wrong granularity.
 */
function mergeMatchers(
  existing: unknown,
  command: string,
  timeout: number | undefined,
): HookMatcher[] {
  const entry: HookEntry = timeout === undefined
    ? { type: "command", command }
    : { type: "command", command, timeout };

  const matchers: HookMatcher[] = Array.isArray(existing)
    ? (existing as HookMatcher[]).map((m) => ({
        matcher: typeof m?.matcher === "string" ? m.matcher : "",
        hooks: Array.isArray(m?.hooks) ? [...m.hooks] : [],
      }))
    : [];

  // An entry already in the blanket matcher is refreshed where it stands.
  // Moving it to the end would make two of our hooks on one event trade places
  // on every refresh, and each swap is a real write to the user's file.
  const blanket = matchers.find((m) => m.matcher === "");
  const at = blanket ? blanket.hooks.findIndex((h) => h?.command === command) : -1;
  for (const m of matchers) m.hooks = m.hooks.filter((h) => h?.command !== command);
  // `at` is the first copy, so no copy sat before it and the index still holds.
  if (blanket) blanket.hooks.splice(at >= 0 ? at : blanket.hooks.length, 0, entry);
  else matchers.unshift({ matcher: "", hooks: [entry] });

  // A matcher we emptied by removing our own entry is ours to drop; one that
  // still holds someone else's hooks stays exactly as it is.
  return matchers.filter((m) => m.hooks.length > 0);
}

/**
 * Install (or refresh) one codecast hook across the events it fires on.
 *
 * Writing the hook SCRIPT is the caller's job: scripts live in
 * `~/.claude/hooks/` with their own modes and this module is only about the
 * settings entry. Splitting them keeps the JSON merge testable without a
 * filesystem full of shell scripts.
 */
export function installOwnedHook(
  events: readonly string[],
  command: string,
  options: InstallOwnedHookOptions = {},
): ApplyResult {
  const target = options.settingsPath ?? defaultSettingsPath();
  const current = readSettings(target);

  // Seeded with what is already there so the ledger reflects the array we are
  // about to produce rather than treating the user's array as a rival claim.
  const desired: OwnedKey[] = events.map((event) => ({
    keyPath: matcherKeyPath(event),
    value: mergeMatchers(readAt(current, matcherKeyPath(event)), command, options.timeout),
  }));
  // Every other hook event we own is re-stated, not only non-hook keys: the
  // ledger holds one key per event, and several of our hooks share events, so
  // installing one hook must not read as releasing the events of another.
  const writing = new Set(events);
  desired.push(...retainOwned(target, current, (keyPath) => isHookKey(keyPath) && writing.has(keyPath[1])));

  return applyOwnedJson(target, desired, {
    adopt: true,
    dryRun: options.dryRun,
    // Claude Code writes this file with 2-space indentation. Matching it means
    // our writes do not show up as a whole-file reformat in the user's git diff.
    indent: 2,
    mode: options.mode ?? 0o600,
    what: "hooks",
  });
}

/**
 * Take our hook back out of every event, leaving the file otherwise untouched.
 *
 * Passing an empty desired set makes `applyOwnedJson` remove exactly the keys
 * the ledger says we wrote — and skip any the user has since edited, which is
 * the one case a hand-rolled remover always got wrong.
 */
export function removeOwnedHook(
  command: string,
  options: { settingsPath?: string; dryRun?: boolean; events?: readonly string[] } = {},
): ApplyResult {
  const target = options.settingsPath ?? defaultSettingsPath();
  const current = readSettings(target);
  const events = Object.keys(
    (typeof current === "object" && current !== null
      ? (current as Record<string, unknown>).hooks
      : undefined) as Record<string, unknown> ?? {},
  );
  // With `events`, only those events lose the hook; every other event is
  // re-stated as it is, so the rest of our registration survives.
  const only = options.events ? new Set(options.events) : null;

  // Rebuild each event without our command. An event left with nothing but our
  // entry ends up an empty array, which `applyOwnedJson` prunes along with the
  // `hooks` container if that empties too — so a clean removal leaves the file
  // exactly as it was before the install.
  const desired: OwnedKey[] = [];
  // An event holding nothing but our entry is dropped by leaving it out of
  // `desired`, which removes only keys the ledger says we own. An install from
  // before the ledger never recorded its keys, so claim those arrays first:
  // they hold our command and nothing else, so claiming takes nobody's hook.
  const claim: string[][] = [];
  for (const event of events) {
    const existing = readAt(current, matcherKeyPath(event));
    const without = only && !only.has(event) ? existing : stripCommand(existing, command);
    if (Array.isArray(without) && without.length > 0) desired.push({ keyPath: matcherKeyPath(event), value: without });
    else if (hasCommand(existing, command)) claim.push(matcherKeyPath(event));
  }
  desired.push(...retainOwned(target, current, isHookKey));
  return applyOwnedJson(target, desired, { adopt: true, claim, dryRun: options.dryRun, indent: 2, what: "hooks" });
}

/**
 * Everything else codecast already owns in this file, re-stated unchanged.
 *
 * `applyOwnedJson` reads its `desired` list as the WHOLE claim: a ledger key
 * missing from it is a key we no longer want, and it is deleted. Two writers
 * share this file and this ledger — the hooks pair below `hooks.*`, the status
 * line at `statusLine` — so each has to hand back the other's keys or the last
 * one to run silently removes them.
 *
 * What is handed back is the LEDGER's value, never the file's, and only while
 * the key is still there. Re-stating the file's value would launder a user's
 * edit into our ledger, and a later removal would then delete their work;
 * re-stating a key they deleted would resurrect it. Given the ledger value,
 * `planJsonMerge` answers both cases the way it answers every other key.
 */
function retainOwned(target: string, current: unknown, mine: (keyPath: string[]) => boolean): OwnedKey[] {
  const kept: OwnedKey[] = [];
  for (const [encoded, ours] of Object.entries(readLedger(target))) {
    const keyPath = decodeKeyPath(encoded);
    if (mine(keyPath)) continue;
    if (readAt(current, keyPath) !== undefined) kept.push({ keyPath, value: ours });
  }
  return kept;
}

const isHookKey = (keyPath: string[]): boolean => keyPath[0] === "hooks";
const isStatusLineKey = (keyPath: string[]): boolean => keyPath[0] === "statusLine";

/** The value codecast writes at `statusLine`. Claude Code's own shape. */
function statusLineEntry(command: string): Record<string, unknown> {
  return { type: "command", command, padding: 0 };
}

/**
 * Point Claude Code's `statusLine` at our script — but only if nobody else has.
 *
 * Unlike a hooks array, `statusLine` holds ONE command: a user who configured
 * their own has a status line they look at, and replacing it would be taking
 * their screen. `planJsonMerge` already answers this — a key that exists and is
 * not in our ledger is reported as a conflict and left alone — so the caller
 * only has to read `conflicts` to know it did not install.
 */
export function installOwnedStatusLine(
  command: string,
  options: { settingsPath?: string; mode?: number; dryRun?: boolean } = {},
): ApplyResult {
  const target = options.settingsPath ?? defaultSettingsPath();
  const current = readSettings(target);
  const desired: OwnedKey[] = [
    { keyPath: ["statusLine"], value: statusLineEntry(command) },
    ...retainOwned(target, current, isStatusLineKey),
  ];
  // No `adopt`: the value is wholly ours, so the default rule (a key we do not
  // own is a conflict, not a thing to take over) is the right one.
  return applyOwnedJson(target, desired, { dryRun: options.dryRun, indent: 2, mode: options.mode ?? 0o600, what: "statusline" });
}

/** Take our `statusLine` back out, leaving any hook entries we own in place. */
export function removeOwnedStatusLine(
  options: { settingsPath?: string; dryRun?: boolean } = {},
): ApplyResult {
  const target = options.settingsPath ?? defaultSettingsPath();
  const current = readSettings(target);
  return applyOwnedJson(target, retainOwned(target, current, isStatusLineKey), {
    adopt: true,
    dryRun: options.dryRun,
    indent: 2,
    what: "statusline",
  });
}

/** Every matcher under an event with `command` taken out, empties dropped. */
function hasCommand(existing: unknown, command: string): boolean {
  return Array.isArray(existing)
    && (existing as HookMatcher[]).some((m) => Array.isArray(m?.hooks) && m.hooks.some((h) => h?.command === command));
}

function stripCommand(existing: unknown, command: string): HookMatcher[] {
  if (!Array.isArray(existing)) return [];
  return (existing as HookMatcher[])
    .map((m) => ({
      matcher: typeof m?.matcher === "string" ? m.matcher : "",
      hooks: Array.isArray(m?.hooks) ? m.hooks.filter((h) => h?.command !== command) : [],
    }))
    .filter((m) => m.hooks.length > 0);
}

function readSettings(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return {};
  }
}

function readAt(doc: unknown, keyPath: string[]): unknown {
  let node: unknown = doc;
  for (const key of keyPath) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}
