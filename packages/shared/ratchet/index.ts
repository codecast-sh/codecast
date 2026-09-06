import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

// THE SHRINK-ONLY RATCHET.
//
// Thirty guard tests in this repo already scan the tree for a pattern and hold
// an allowlist of the files that still break the rule. Every one of them can be
// satisfied by adding a line, and none of them notices when the debt grows
// sideways: a file migrates off the pattern, a new file adopts it, both lists
// move together and the guard stays green. That is how a guard rots into
// paperwork.
//
// A ratchet closes both holes. It holds a PINNED COUNT of offending files as a
// literal in the test, so a swap fails even when the allowlist still balances,
// and it fails on a STALE entry, so ground taken cannot be quietly given back.
// The count may only ever be lowered. The listed files carry a pinned number
// too (occurrences, or lines for the size baseline), so a listed file may not
// grow either.
//
// The fix for a failure is always to remove the offence, never to widen the
// list. The only sanctioned edit to a pin is downward:
//   RATCHET_WRITE=prune bun test <the ratchet test>
// which drops entries that no longer match and lowers pinned numbers that came
// down. It never adds an entry and never raises a number.

export type RatchetAllowance = { value?: number; note?: string };

export type RatchetSpec = {
  /** Names the ratchet in every failure message. */
  name: string;
  /** Absolute directory that every reported path is relative to. */
  root: string;
  /** Directories under `root` to scan. Defaults to the root itself. */
  dirs?: readonly string[];
  /** File extensions to read. */
  extensions?: readonly string[];
  /** Directory names never descended into. */
  ignoreDirs?: readonly string[];
  /** Files this rule does not apply to at all (tests, the module that owns
   *  the pattern). An exempt file is not scanned and cannot be an offender. */
  exempt?: (rel: string) => boolean;
  /** How many times this file breaks the rule. 0 means it does not. */
  count: (source: string, rel: string) => number;
  /** Absolute path of the allowlist file. */
  allowlist: string;
  /** How many files break the rule today. May only ever be lowered. */
  pin: number;
  /** One line: what to do instead of adding an entry. */
  fix: string;
  /** The exact command that prunes this ratchet's allowlist. */
  pruneCommand: string;
  /** A scan that walks the wrong tree matches nothing and passes forever. */
  minScanned: number;
};

export type RatchetOffender = { key: string; value: number };

export type RatchetResult = {
  /** How many files the scan actually read. */
  scanned: number;
  offenders: RatchetOffender[];
  /** Empty when the ratchet holds. Every entry is a complete sentence. */
  problems: string[];
};

const DEFAULT_EXTENSIONS = [".ts", ".tsx"] as const;
const DEFAULT_IGNORED = [
  "node_modules",
  ".git",
  ".next",
  ".expo",
  ".turbo",
  "dist",
  "out",
  "build",
  "coverage",
  "_generated",
] as const;

/** Every file under `dir` with a scanned extension, recursively. */
export function walkFiles(dir: string, extensions: readonly string[], ignoreDirs: ReadonlySet<string>, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (ignoreDirs.has(name) || name.startsWith(".")) continue;
    const full = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue; // a symlink another agent's worktree left dangling
    }
    if (isDir) walkFiles(full, extensions, ignoreDirs, out);
    else if (extensions.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** The source with comment-only lines dropped, so prose about the banned
 *  idiom (including the ratchet's own explanation of it) never counts. */
export function codeOnly(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

/** Occurrences of `pattern` in the file's code, comments excluded. */
export function countMatches(source: string, pattern: RegExp): number {
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  return (codeOnly(source).match(re) ?? []).length;
}

export function parseAllowlist(text: string): Map<string, RatchetAllowance> {
  const out = new Map<string, RatchetAllowance>();
  for (const raw of text.split("\n")) {
    const hash = raw.indexOf("#");
    const body = (hash === -1 ? raw : raw.slice(0, hash)).trim();
    if (!body) continue;
    const note = hash === -1 ? undefined : raw.slice(hash + 1).trim() || undefined;
    const [key, second] = body.split(/\s+/);
    const value = second !== undefined && Number.isFinite(Number(second)) ? Number(second) : undefined;
    out.set(key, { value, note });
  }
  return out;
}

export function formatAllowlist(spec: RatchetSpec, entries: ReadonlyMap<string, RatchetAllowance>): string {
  const header = [
    `# ${spec.name}: the files that still break this rule.`,
    "#",
    "# THIS LIST MAY ONLY SHRINK. Adding a line to get a test green is never the",
    `# fix. ${spec.fix}`,
    "#",
    `# Prune it (drops gone entries, lowers numbers that came down, adds nothing):`,
    `#   ${spec.pruneCommand}`,
    "",
  ].join("\n");
  const lines = [...entries.keys()]
    .sort()
    .map((key) => {
      const { value, note } = entries.get(key)!;
      const body = value === undefined ? key : `${key} ${value}`;
      return note ? `${body}  # ${note}` : body;
    });
  return `${header}${lines.join("\n")}\n`;
}

function scan(spec: RatchetSpec): { scanned: number; offenders: RatchetOffender[] } {
  const extensions = spec.extensions ?? DEFAULT_EXTENSIONS;
  const ignoreDirs = new Set([...DEFAULT_IGNORED, ...(spec.ignoreDirs ?? [])]);
  const dirs = spec.dirs ?? ["."];
  const offenders: RatchetOffender[] = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const file of walkFiles(join(spec.root, dir), extensions, ignoreDirs)) {
      const rel = file.slice(spec.root.length + 1).split("\\").join("/");
      if (spec.exempt?.(rel)) continue;
      scanned++;
      const n = spec.count(readFileSync(file, "utf8"), rel);
      if (n > 0) offenders.push({ key: rel, value: n });
    }
  }
  offenders.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { scanned, offenders };
}

/**
 * Rewrite the allowlist downward. `prune` keeps only entries that still match
 * and lowers pinned numbers that came down; it never adds a key and never
 * raises a number, so it cannot be used to widen. `init` writes the current
 * scan verbatim, for bootstrapping a brand new ratchet.
 */
export function syncAllowlist(spec: RatchetSpec, offenders: readonly RatchetOffender[], mode: "prune" | "init"): void {
  const current = new Map(offenders.map((o) => [o.key, o.value]));
  const existing = existsSync(spec.allowlist) ? parseAllowlist(readFileSync(spec.allowlist, "utf8")) : new Map<string, RatchetAllowance>();
  const next = new Map<string, RatchetAllowance>();
  if (mode === "init") {
    for (const [key, value] of current) next.set(key, { value, note: existing.get(key)?.note });
  } else {
    for (const [key, allowance] of existing) {
      const value = current.get(key);
      if (value === undefined) continue; // gone: drop it
      const pinned = allowance.value;
      next.set(key, { value: pinned === undefined ? undefined : Math.min(pinned, value), note: allowance.note });
    }
  }
  writeFileSync(spec.allowlist, formatAllowlist(spec, next));
}

/**
 * Run a ratchet. `problems` is empty when it holds; each entry is a whole
 * sentence naming the file and the one thing to do about it.
 *
 * Set RATCHET_WRITE=prune (or =init for a new ratchet) to rewrite the
 * allowlist downward before checking.
 */
export function checkRatchet(spec: RatchetSpec): RatchetResult {
  const { scanned, offenders } = scan(spec);
  const write = process.env.RATCHET_WRITE;
  if (write === "prune" || write === "init") syncAllowlist(spec, offenders, write);

  const problems: string[] = [];
  const listName = basename(spec.allowlist);

  if (scanned < spec.minScanned) {
    // A ratchet that walks the wrong tree matches nothing and passes forever.
    problems.push(
      `${spec.name}: scanned only ${scanned} files, expected at least ${spec.minScanned} — the scan root is wrong, so this ratchet is guarding nothing.`,
    );
  }

  const allowed = existsSync(spec.allowlist)
    ? parseAllowlist(readFileSync(spec.allowlist, "utf8"))
    : new Map<string, RatchetAllowance>();

  for (const { key, value } of offenders) {
    const allowance = allowed.get(key);
    if (!allowance) {
      problems.push(`${spec.name}: ${key} newly breaks this rule (${value}). ${spec.fix}`);
      continue;
    }
    if (allowance.value !== undefined && value > allowance.value) {
      problems.push(
        `${spec.name}: ${key} went from ${allowance.value} to ${value}. A listed file may not grow. ${spec.fix}`,
      );
    }
  }

  const offenderKeys = new Set(offenders.map((o) => o.key));
  for (const key of allowed.keys()) {
    if (offenderKeys.has(key)) continue;
    problems.push(`${spec.name}: ${key} no longer breaks this rule — delete its line from ${listName} so it cannot come back for free. (${spec.pruneCommand})`);
  }

  if (offenders.length > spec.pin) {
    problems.push(
      `${spec.name}: ${offenders.length} files break this rule and the pin is ${spec.pin}. Never raise the pin. ${spec.fix}`,
    );
  } else if (offenders.length < spec.pin) {
    // A pin left above reality re-opens room for the next offender to land free.
    problems.push(
      `${spec.name}: only ${offenders.length} files break this rule now — lower the pin in this test from ${spec.pin} to ${offenders.length} to keep the ground you took.`,
    );
  }

  return { scanned, offenders, problems };
}
