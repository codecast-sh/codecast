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
// A ratchet closes both holes. The allowlist is its one record: an offender
// that is not listed fails, and a STALE entry fails, so a swap fails even when
// the list still balances and ground taken cannot be quietly given back. The
// listed files carry a pinned number (occurrences, or lines for the size
// baseline), so a listed file may not grow either. There is no total to keep
// in step: the list is the count, and two branches that each fix a different
// file edit different lines of it rather than one shared number.
//
// The fix for a failure is always to remove the offence, never to widen the
// list. The only sanctioned edit to the list is downward:
//   RATCHET_WRITE=prune bun test <the ratchet test>
// which drops entries that no longer match and lowers the numbers that fell
// past the shrink floor. Every other line stays exactly as written, so two
// prunes from different bases rewrite only the lines each one had to. It never
// adds an entry and never raises a number.

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
  /** One line: what to do instead of adding an entry. */
  fix: string;
  /** The exact command that prunes this ratchet's allowlist. */
  pruneCommand: string;
  /** A scan that walks the wrong tree matches nothing and passes forever. */
  minScanned: number;
  /** When set, a listed file whose number fell below this fraction of its pin
   *  (0.9 means it came down by more than a tenth) fails until the allowlist is
   *  pruned, so a file that was split cannot quietly grow back to its old size.
   *  Unset, a pin only caps growth. */
  shrinkFloor?: number;
};

/** A listed file that shrank far enough that its line must be lowered. */
function belowShrinkFloor(spec: RatchetSpec, pinned: number, value: number): boolean {
  return spec.shrinkFloor !== undefined && value < pinned * spec.shrinkFloor;
}

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
    `# Prune it (drops gone entries, lowers only the numbers that must come down, adds nothing):`,
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
 * Rewrite the allowlist downward. `prune` touches only the lines that fail:
 * it drops an entry that no longer matches and lowers a number that fell past
 * the shrink floor, and leaves every other line exactly as written. It never
 * adds a key and never raises a number, so it cannot be used to widen. `init`
 * writes the current scan verbatim, for bootstrapping a brand new ratchet.
 */
export function syncAllowlist(spec: RatchetSpec, offenders: readonly RatchetOffender[], mode: "prune" | "init"): void {
  const current = new Map(offenders.map((o) => [o.key, o.value]));
  const exists = existsSync(spec.allowlist);
  if (mode === "init") {
    const existing = exists ? parseAllowlist(readFileSync(spec.allowlist, "utf8")) : new Map<string, RatchetAllowance>();
    const next = new Map<string, RatchetAllowance>();
    for (const [key, value] of current) next.set(key, { value, note: existing.get(key)?.note });
    writeFileSync(spec.allowlist, formatAllowlist(spec, next));
    return;
  }
  if (!exists) return;
  const lines: string[] = [];
  for (const raw of readFileSync(spec.allowlist, "utf8").split("\n")) {
    const entry = [...parseAllowlist(raw)][0];
    if (!entry) {
      lines.push(raw); // a comment or a blank line
      continue;
    }
    const [key, { value: pinned }] = entry;
    const value = current.get(key);
    if (value === undefined) continue; // gone: drop it
    lines.push(pinned !== undefined && belowShrinkFloor(spec, pinned, value) ? raw.replace(/^(\s*\S+\s+)\d+/, `$1${value}`) : raw);
  }
  writeFileSync(spec.allowlist, lines.join("\n"));
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
    if (allowance.value === undefined) {
      // A line with no number caps nothing: the file could grow without limit.
      problems.push(
        `${spec.name}: ${key} is listed in ${listName} with no number, so nothing stops it growing. Write its current ${value} after it.`,
      );
    } else if (value > allowance.value) {
      problems.push(
        `${spec.name}: ${key} went from ${allowance.value} to ${value}. A listed file may not grow. ${spec.fix}`,
      );
    } else if (belowShrinkFloor(spec, allowance.value, value)) {
      problems.push(
        `${spec.name}: ${key} came down from ${allowance.value} to ${value}. Lower its line in ${listName} so the ground stays taken. (${spec.pruneCommand})`,
      );
    }
  }

  const offenderKeys = new Set(offenders.map((o) => o.key));
  for (const key of allowed.keys()) {
    if (offenderKeys.has(key)) continue;
    problems.push(`${spec.name}: ${key} no longer breaks this rule — delete its line from ${listName} so it cannot come back for free. (${spec.pruneCommand})`);
  }

  return { scanned, offenders, problems };
}
