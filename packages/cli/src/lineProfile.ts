// The line profile (docs/architecture/line-profile.md LP2): what a repo says
// about its own line in `.codecast/line.toml`, validated and merged with the
// defaults a repo without one gets. One loader, read by `cast line profile`,
// by `cast signal add` and `cast goals` for their defaults (team, project),
// and by the runner for the values the shipped template names.
//
// Unknown keys are refused with the path of the key, so a typo never turns
// into a default that silently stands.
import fs from "node:fs";
import path from "node:path";
import { SIGNAL_KINDS, type SignalKind } from "@codecast/shared/contracts/signalFingerprint";

export const LINE_PROFILE_REL_PATH = ".codecast/line.toml";
/** codecast's prompting standard, for a repo that names none (LP2). The repo is public. */
export const CODECAST_PROMPTING = "https://github.com/codecast-sh/codecast/blob/main/docs/prompting.md";
/**
 * The shared principles every project's line reads in addition to the
 * profile's own files (LP5). A link, because the review node runs in the
 * project's worktree, where codecast's docs/ is not on disk.
 */
export const CODECAST_PRINCIPLES = "https://github.com/codecast-sh/codecast/blob/main/docs/principles.md";

/** The principles a line reads, as prose for a node prompt: the shared set, then the profile's own files. */
export function principlesProse(paths: string[]): string {
  const shared = `${CODECAST_PRINCIPLES} (the shared set)`;
  return paths.length ? `${shared} and ${paths.join(", ")} (this project's own)` : shared;
}

export interface LineFinder {
  id: string;
  source: string;
  /** The kinds it files, or "any" for a finder that types each signal itself (a person). */
  kind: SignalKind[] | "any";
  fingerprint: string;
  runs?: string;
  /** The project its signals go to, when not the profile's. */
  project?: string;
}

export interface LineProfile {
  team: string | null;
  project: string | null;
  principles: string[];
  prompting: string;
  size_budget: number;
  watch_days: number;
  commands: { check: string; prove: string | null; eval: string | null; ship: string | null };
  caps: { cards: number };
  finders: LineFinder[];
}

export const LINE_PROFILE_DEFAULTS: LineProfile = {
  team: null,
  project: null,
  principles: [],
  prompting: CODECAST_PROMPTING,
  size_budget: 400,
  watch_days: 7,
  commands: { check: "cast ws check", prove: null, eval: null, ship: null },
  caps: { cards: 5 },
  finders: [],
};

export type ValueSource = "file" | "default";

export interface ResolvedLineProfile {
  /** The directory holding `.codecast/line.toml`, else the repository root, else null. */
  root: string | null;
  /** The profile file read, or null when the repo has none. */
  file: string | null;
  profile: LineProfile;
  /** Where each value came from, by dotted key (team, commands.check, caps.cards, finders, ...). */
  sources: Record<string, ValueSource>;
  /** What a default means for the line, one line each (a station that passes with a note). */
  notes: string[];
  /** Shapes the loader accepted but the contract spells another way; the file should change. */
  warnings: string[];
}

export class LineProfileError extends Error {
  constructor(message: string, file?: string) {
    super(file ? `${file}: ${message}` : message);
    this.name = "LineProfileError";
  }
}

/** The values a profile file sets; anything absent takes the default. */
export type LineProfileValues = Omit<{ [K in keyof LineProfile]?: LineProfile[K] }, "commands" | "caps"> & {
  commands?: { [K in keyof LineProfile["commands"]]?: string };
  caps?: { cards?: number };
};

const LINE_KEYS = ["team", "project", "principles", "prompting", "size_budget", "watch_days", "commands", "caps", "finders"] as const;
const COMMAND_KEYS = ["check", "prove", "eval", "ship"] as const;
const CAPS_KEYS = ["cards"] as const;
const FINDER_KEYS = ["id", "source", "kind", "fingerprint", "runs", "project"] as const;

const isTable = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Date);

function refuseUnknown(table: Record<string, unknown>, known: readonly string[], where: string): void {
  const bad = Object.keys(table).filter((k) => !known.includes(k));
  if (bad.length) throw new LineProfileError(`${where} has unknown key${bad.length > 1 ? "s" : ""} ${bad.map((k) => `"${k}"`).join(", ")} (known: ${known.join(", ")})`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim()) throw new LineProfileError(`${where} must be a non-empty string`);
  return value.trim();
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new LineProfileError(`${where} must be a positive integer`);
  return value;
}

/**
 * A finder's kind: one kind, a list of kinds, or "any". A sentence such as
 * "prompt_miss, bug or request" is read as the list it names, with a warning,
 * because the contract's form is the list.
 */
export function parseFinderKind(value: unknown, where: string, warnings: string[]): LineFinder["kind"] {
  const check = (k: string): SignalKind => {
    const kind = k.trim().toLowerCase();
    if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) throw new LineProfileError(`${where} names unknown kind "${k.trim()}" (kinds: ${SIGNAL_KINDS.join(", ")}, or "any")`);
    return kind as SignalKind;
  };
  if (Array.isArray(value)) {
    if (!value.length) throw new LineProfileError(`${where} must name at least one kind`);
    return [...new Set(value.map((k, i) => check(text(k, `${where}[${i}]`))))];
  }
  const raw = text(value, where);
  if (raw.toLowerCase() === "any") return "any";
  const parts = raw.split(/\s*,\s*|\s+or\s+/i).filter(Boolean);
  const kinds = [...new Set(parts.map(check))];
  if (parts.length > 1) warnings.push(`${where} = "${raw}" is a sentence; write the list: kind = [${kinds.map((k) => `"${k}"`).join(", ")}]`);
  return kinds;
}

/** Parse and validate `.codecast/line.toml` text: the values it sets, and the warnings. */
export function parseLineProfileText(textIn: string, file?: string): { values: LineProfileValues; warnings: string[] } {
  let raw: unknown;
  try {
    raw = Bun.TOML.parse(textIn);
  } catch (err) {
    throw new LineProfileError(`invalid TOML: ${err instanceof Error ? err.message : String(err)}`, file);
  }
  const warnings: string[] = [];
  try {
    if (!isTable(raw)) throw new LineProfileError("must be a TOML table");
    refuseUnknown(raw, ["line"], "the file");
    if (raw.line === undefined) return { values: {}, warnings };
    if (!isTable(raw.line)) throw new LineProfileError("[line] must be a table");
    const line = raw.line;
    refuseUnknown(line, LINE_KEYS, "[line]");
    const values: LineProfileValues = {};
    if (line.team !== undefined) values.team = text(line.team, "[line] team");
    if (line.project !== undefined) values.project = text(line.project, "[line] project");
    if (line.principles !== undefined) {
      values.principles = typeof line.principles === "string"
        ? [text(line.principles, "[line] principles")]
        : Array.isArray(line.principles)
          ? line.principles.map((p, i) => text(p, `[line] principles[${i}]`))
          : (() => { throw new LineProfileError("[line] principles must be a path or a list of paths"); })();
    }
    if (line.prompting !== undefined) values.prompting = text(line.prompting, "[line] prompting");
    if (line.size_budget !== undefined) values.size_budget = count(line.size_budget, "[line] size_budget");
    if (line.watch_days !== undefined) values.watch_days = count(line.watch_days, "[line] watch_days");
    if (line.commands !== undefined) {
      if (!isTable(line.commands)) throw new LineProfileError("[line.commands] must be a table");
      refuseUnknown(line.commands, COMMAND_KEYS, "[line.commands]");
      values.commands = {};
      for (const k of COMMAND_KEYS) if (line.commands[k] !== undefined) values.commands[k] = text(line.commands[k], `[line.commands] ${k}`);
    }
    if (line.caps !== undefined) {
      if (!isTable(line.caps)) throw new LineProfileError("[line.caps] must be a table");
      refuseUnknown(line.caps, CAPS_KEYS, "[line.caps]");
      values.caps = {};
      if (line.caps.cards !== undefined) values.caps.cards = count(line.caps.cards, "[line.caps] cards");
    }
    if (line.finders !== undefined) {
      if (!Array.isArray(line.finders)) throw new LineProfileError("[[line.finders]] must be an array of tables");
      const seen = new Set<string>();
      values.finders = line.finders.map((f, i) => {
        const where = `[[line.finders]] #${i + 1}`;
        if (!isTable(f)) throw new LineProfileError(`${where} must be a table`);
        refuseUnknown(f, FINDER_KEYS, where);
        const id = text(f.id, `${where} id`);
        if (seen.has(id)) throw new LineProfileError(`${where} repeats id "${id}"`);
        seen.add(id);
        const at = `[[line.finders]] "${id}"`;
        const finder: LineFinder = {
          id,
          source: text(f.source, `${at} source`),
          kind: parseFinderKind(f.kind, `${at} kind`, warnings),
          fingerprint: text(f.fingerprint, `${at} fingerprint`),
        };
        if (f.runs !== undefined) finder.runs = text(f.runs, `${at} runs`);
        if (f.project !== undefined) finder.project = text(f.project, `${at} project`);
        return finder;
      });
    }
    return { values, warnings };
  } catch (err) {
    if (err instanceof LineProfileError && file) throw new LineProfileError(err.message, file);
    throw err;
  }
}

/** The defaults with the file's values laid over them, and where each came from. */
export function resolveLineProfile(values: LineProfileValues, opts: { root?: string | null; file?: string | null; warnings?: string[] } = {}): ResolvedLineProfile {
  const d = LINE_PROFILE_DEFAULTS;
  const sources: Record<string, ValueSource> = {};
  const pick = <T>(key: string, value: T | undefined, fallback: T): T => {
    sources[key] = value === undefined ? "default" : "file";
    return value === undefined ? fallback : value;
  };
  const profile: LineProfile = {
    team: pick("team", values.team, d.team),
    project: pick("project", values.project, d.project),
    principles: pick("principles", values.principles, d.principles),
    prompting: pick("prompting", values.prompting, d.prompting),
    size_budget: pick("size_budget", values.size_budget, d.size_budget),
    watch_days: pick("watch_days", values.watch_days, d.watch_days),
    commands: {
      check: pick("commands.check", values.commands?.check, d.commands.check),
      prove: pick("commands.prove", values.commands?.prove, d.commands.prove),
      eval: pick("commands.eval", values.commands?.eval, d.commands.eval),
      ship: pick("commands.ship", values.commands?.ship, d.commands.ship),
    },
    caps: { cards: pick("caps.cards", values.caps?.cards, d.caps.cards) },
    finders: pick("finders", values.finders, d.finders),
  };
  const notes: string[] = [];
  if (!profile.commands.prove) notes.push("no prove command: the prove station passes with a note");
  if (!profile.commands.eval) notes.push("no eval command: the eval station passes with a note");
  if (!profile.commands.ship) notes.push("no ship command: the line's own merge step lands the change");
  if (!profile.project) notes.push("no project: signals filed here go to the workspace, not a project, unless --project names one");
  return { root: opts.root ?? null, file: opts.file ?? null, profile, sources, notes, warnings: opts.warnings ?? [] };
}

/** The nearest `.codecast/line.toml` from `cwd` up, stopping at the repository root (the first directory holding `.git`). */
export function findLineProfile(cwd: string): { file: string | null; root: string | null } {
  let dir = path.resolve(cwd);
  for (;;) {
    const file = path.join(dir, LINE_PROFILE_REL_PATH);
    if (fs.existsSync(file)) return { file, root: dir };
    if (fs.existsSync(path.join(dir, ".git"))) return { file: null, root: dir };
    const up = path.dirname(dir);
    if (up === dir) return { file: null, root: null };
    dir = up;
  }
}

/** The resolved profile for a directory. Throws LineProfileError on a malformed file. */
export function loadLineProfile(cwd: string = process.env.CODECAST_CWD || process.cwd()): ResolvedLineProfile {
  const { file, root } = findLineProfile(cwd);
  if (!file) return resolveLineProfile({}, { root });
  const { values, warnings } = parseLineProfileText(fs.readFileSync(file, "utf8"), file);
  return resolveLineProfile(values, { root, file, warnings });
}

/**
 * The run values a profile command may name (LP2 "$vars expand"). The runner
 * hands them to every station script as environment variables, so a command
 * such as `line.ts prove --dir $run_dir` expands them in its own shell.
 */
export const LINE_COMMAND_VARS = ["task_id", "branch", "default_branch", "run_dir", "run_id", "project_path", "worktree"] as const;

/** The environment a station script runs a profile command in: LINE_COMMAND_VARS from the run's context, the ones it has. */
export function lineCommandEnv(context: Record<string, string>): Record<string, string> {
  return Object.fromEntries(LINE_COMMAND_VARS.filter((k) => context[k] !== undefined).map((k) => [k, context[k]]));
}

/**
 * The profile as flat `line.<key>` variables (the runner's `$line.commands.check`).
 * Commands absent from the profile are empty, so an edge condition can test
 * them; principles read as prose in a node prompt (the shared set, then the profile's files).
 */
export function lineProfileVars(profile: LineProfile): Record<string, string> {
  const vars: Record<string, string> = {
    "line.team": profile.team ?? "",
    "line.project": profile.project ?? "",
    "line.principles": principlesProse(profile.principles),
    "line.prompting": profile.prompting,
    "line.size_budget": String(profile.size_budget),
    "line.watch_days": String(profile.watch_days),
    "line.caps.cards": String(profile.caps.cards),
  };
  for (const k of COMMAND_KEYS) vars[`line.commands.${k}`] = profile.commands[k] ?? "";
  return vars;
}

/** `cast line profile`: every value with where it came from. */
export function formatLineProfile(r: ResolvedLineProfile): string {
  const p = r.profile;
  const rows: Array<[string, string]> = [
    ["team", p.team ?? "(none: the session's team, else the directory's mapping)"],
    ["project", p.project ?? "(none)"],
    ["principles", `${p.principles.length ? p.principles.join(", ") : "(none)"}, read with the shared set`],
    ["prompting", p.prompting],
    ["size_budget", String(p.size_budget)],
    ["watch_days", String(p.watch_days)],
    ...COMMAND_KEYS.map((k): [string, string] => [`commands.${k}`, p.commands[k] ?? "(none)"]),
    ["caps.cards", String(p.caps.cards)],
  ];
  const width = Math.max(...rows.map(([k]) => k.length));
  const out = [r.file ? `profile ${r.file}` : `no ${LINE_PROFILE_REL_PATH}${r.root ? ` in ${r.root}` : ""}: every value is a default`, ""];
  for (const [k, v] of rows) out.push(`${k.padEnd(width)}  ${v}  (${r.sources[k]})`);
  out.push("", `finders (${p.finders.length}, ${r.sources.finders})`);
  for (const f of p.finders) {
    const kinds = f.kind === "any" ? "any" : f.kind.join(", ");
    out.push(`  ${f.id}  ${f.source}  ${kinds}  ${f.fingerprint}  -> ${f.project ?? p.project ?? "(no project)"}${f.runs ? `\n    runs: ${f.runs}` : ""}`);
  }
  if (r.notes.length) out.push("", ...r.notes.map((n) => `note: ${n}`));
  if (r.warnings.length) out.push("", ...r.warnings.map((w) => `warning: ${w}`));
  return `${out.join("\n")}\n`;
}
