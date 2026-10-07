// The line profile's shape (docs/architecture/line-profile.md LP2, LP3): what
// `.codecast/line.toml` resolves to, and the copy `cast line profile --publish`
// writes onto each project it files into (projects.line_profile). The CLI
// loader, the Convex mutation and the web store all name these types, so the
// three cannot drift. Pure types and one comparison; no runtime deps.
import { canonicalJson } from "./appConnector";
import type { SignalKind } from "./signalFingerprint";

export type LineValueSource = "file" | "default";

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
  /**
   * Whether Ship merges on its own (`[line.merge]`). Absent on a profile
   * published by a CLI older than the key: read it as the default.
   */
  merge?: { auto: boolean; method: "squash" | "merge" | "rebase" };
  finders: LineFinder[];
}

/** A finder as a project row holds it: the project it files into is the row. Kinds are stored as written. */
export type LineFinderDecl = Omit<LineFinder, "project" | "kind"> & { kind: "any" | string[] };

/**
 * The resolved profile apart from its finders (which are published per
 * project), with where each value came from and what the loader said.
 * `file` is repo relative (`.codecast/line.toml`), or null when the repo has none.
 */
export type LineProfileFacts = Omit<LineProfile, "finders"> & {
  /** By dotted key (team, commands.check, caps.cards, finders, ...). */
  sources: Record<string, LineValueSource>;
  notes: string[];
  warnings: string[];
  file: string | null;
  /** The repo's own line (line-map.md LX5), when it has `.codecast/line/line.cast`; absent otherwise. */
  line?: PublishedRepoLine;
};

/**
 * projects.line_profile. finders/root/default/changed_at have been written
 * since LP3; the rest arrives with every publish from a CLI that sends the
 * whole profile, so a row published before that lacks them.
 *
 * changed_at: when the profile's content (values, finders, sources, notes,
 * warnings, default) last changed. published_at: when the row was last
 * written, which a move to another checkout or device also does.
 */
export type PublishedLineProfile = {
  finders: LineFinderDecl[];
  root?: string;
  default?: boolean;
  changed_at: number;
} & Partial<LineProfileFacts & {
  /** The device whose daemon published it: where an edit of the file is routed. */
  device_id: string;
  /** Who published it from that device: the only viewer an edit is routed for. */
  publisher_user_id: string;
  published_at: number;
}>;

/** Where a repo's profile lives, from its root. */
export const LINE_PROFILE_REL_PATH = ".codecast/line.toml";
/** codecast's prompting standard, for a repo that names none (LP2). The repo is public. */
export const CODECAST_PROMPTING = "https://github.com/codecast-sh/codecast/blob/main/docs/prompting.md";
/**
 * The shared principles every project's line reads in addition to the
 * profile's own files (LP5). A link, because the review node runs in the
 * project's worktree, where codecast's docs/ is not on disk.
 */
export const CODECAST_PRINCIPLES = "https://github.com/codecast-sh/codecast/blob/main/docs/principles.md";

/** What a repo without a profile gets, and what a key the file leaves out takes. */
export const LINE_PROFILE_DEFAULTS: LineProfile = {
  team: null,
  project: null,
  principles: [],
  prompting: CODECAST_PROMPTING,
  size_budget: 400,
  watch_days: 7,
  commands: { check: "cast ws check", prove: null, eval: null, ship: null },
  caps: { cards: 5 },
  merge: { auto: false, method: "squash" },
  finders: [],
};

/** The window of signals the line page reads (LE13): a week of throughput plus margin. */
export const LINE_SIGNAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export const COMMAND_KEYS = ["check", "prove", "eval", "ship"] as const;
export const CAPS_KEYS = ["cards"] as const;
export const MERGE_KEYS = ["auto", "method"] as const;
export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;

// ── Value rules: the loader, the daemon's editor and the settings page judge a value the same way ──

/** A count the profile takes (size_budget, watch_days, caps): a whole number, 1 or more. */
export const isLineCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/**
 * Whether a string carries a control character the file cannot hold. Tabs go
 * in raw and newlines as escapes; Bun.TOML (the loader) reads `\t` as a form
 * feed and fails on `\u0001`, so the rest are refused.
 */
export const hasLineControlChars = (s: string) => /[\u0000-\u0008\u000b-\u001f\u007f]/.test(s);

/**
 * A finder's kind as a person writes it: "any", or the kinds it names, split
 * on commas, spaces and "or" ("bug, regression", "prompt_miss or bug").
 * The names are not checked here; the loader checks them against SIGNAL_KINDS.
 */
export function splitFinderKind(raw: string): "any" | string[] {
  const t = raw.trim();
  if (t.toLowerCase() === "any") return "any";
  return t.split(/\s+or\s+|[\s,]+/i).map((x) => x.trim()).filter(Boolean);
}

/** How each editable key's value is written: a line of text, a whole number, or a list of strings. */
export type LineValueKind = "text" | "int" | "list";

/** Every key an edit may set or remove under [line], with the kind of value it takes. */
export const LINE_VALUE_KINDS: Readonly<Record<string, LineValueKind>> = {
  team: "text",
  project: "text",
  principles: "list",
  prompting: "text",
  size_budget: "int",
  watch_days: "int",
  ...Object.fromEntries(COMMAND_KEYS.map((k) => [`commands.${k}`, "text"])),
  ...Object.fromEntries(CAPS_KEYS.map((k) => [`caps.${k}`, "int"])),
};

/**
 * A value as a person types it, read for `key`: a count is a whole number,
 * a list splits on commas and newlines, text is trimmed and holds no control
 * character. The settings page and `cast line set` both read values here.
 */
export function parseLineValue(key: string, text: string): { value: LineValue } | { error: string } {
  const kind = LINE_VALUE_KINDS[key];
  if (!kind) return { error: `unknown key "${key}" (known: ${Object.keys(LINE_VALUE_KINDS).join(", ")})` };
  const trimmed = text.trim();
  if (kind === "int") {
    const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
    return isLineCount(n) ? { value: n } : { error: "A whole number, 1 or more" };
  }
  if (kind === "list") return { value: trimmed.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean) };
  if (hasLineControlChars(trimmed)) return { error: "Control characters cannot go in the file" };
  return { value: trimmed };
}

/** What a default means for the line, one line each (a station that passes with a note). */
export function lineProfileNotes(profile: Pick<LineProfile, "commands" | "project">): string[] {
  const notes: string[] = [];
  if (!profile.commands.prove) notes.push("no prove command: the prove station passes with a note");
  if (!profile.commands.eval) notes.push("no eval command: the eval station passes with a note");
  if (!profile.commands.ship) notes.push("no ship command: the ship station runs Ship, which opens a pull request and merges only under [line.merge] auto or the line's role's merge grant");
  if (!profile.project) notes.push("no project: signals filed here go to the workspace, not a project, unless --project names one");
  return notes;
}

// ── Edits (the daemon's line_profile_edit; cli/src/lineProfileEdit.ts applies them) ──

export type LineValue = string | number | string[];

export interface LineFinderInput {
  id: string;
  source: string;
  kind: string | string[];
  fingerprint: string;
  runs?: string;
  project?: string;
}

/**
 * set/remove name a dotted key under [line] (team, prompting, commands.check,
 * caps.cards, ...); remove puts it back to its default. set_finder replaces a
 * [[line.finders]] block by id (or adds one); remove_finder drops it.
 */
export type LineProfileEdit =
  | { op: "set"; key: string; value: LineValue }
  | { op: "remove"; key: string }
  | { op: "set_finder"; finder: LineFinderInput }
  | { op: "remove_finder"; id: string }
  | LineStationEdit;

// ── The repo's own line (docs/architecture/line-map.md LX5) ──
//
// A project's graph and station prompts live beside its profile, in
// `.codecast/line/`: `line.cast` and one file per station prompt or script,
// written out from the shipped line the first time a station is changed
// (cli/src/repoLine.ts). A task-bound run in that checkout runs it ahead of
// the role's line and the shipped one, and `cast line profile --publish`
// copies it onto the project row so the app shows what the repo holds.

export const REPO_LINE_REL_DIR = ".codecast/line";
export const REPO_LINE_REL_PATH = ".codecast/line/line.cast";
/**
 * The workflow slug a run of a repo's line pushes its graph under: its own
 * row, so it never overwrites the `line` row a role's sweep runs read.
 */
export const REPO_LINE_SLUG = "line-repo";
/** A file the repo's line may hold: a plain name in REPO_LINE_REL_DIR, never a path. */
export const REPO_LINE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(cast|md|sh|txt)$/;

/** A station's editable values. null, empty text or a timeout of 0 or less removes the value. */
export type LineStationPatch = { prompt?: string | null; script?: string | null; timeout?: number | null };

/**
 * set_station changes one station's prompt, script or timeout (seconds) in
 * the repo's line, writing the line out from the shipped one first when the
 * repo has none. reset_station puts one station back to the shipped line's.
 */
export type LineStationEdit =
  | ({ op: "set_station"; station: string } & LineStationPatch)
  | { op: "reset_station"; station: string };

export const isLineStationEdit = (e: LineProfileEdit): e is LineStationEdit => e.op === "set_station" || e.op === "reset_station";

/** A station as the published line carries it: the runner's push shape (prompt and script as text). */
export type RepoLineNode = { id: string; label: string; shape: string; type: string; prompt?: string; script?: string; timeout?: number; [attr: string]: unknown };
export type RepoLineEdge = { from: string; to: string; label?: string; condition?: string };

/**
 * projects.line_profile.line: the repo's line as the runner parses it. `files`
 * names the file (repo relative) each station's prompt or script lives in;
 * `graph_hash` is the hash a run of it records (parser.ts graphHash).
 */
export type PublishedRepoLine = {
  file: string;
  graph_hash: string;
  name: string;
  goal?: string;
  stack?: string;
  source: string;
  nodes: RepoLineNode[];
  edges: RepoLineEdge[];
  files: Record<string, { prompt?: string; script?: string }>;
};

const FACT_KEYS = ["team", "project", "principles", "prompting", "size_budget", "watch_days", "commands", "caps", "merge", "sources", "notes", "warnings", "line"] as const;

/** The content changed_at tracks: every fact but where it lives and who published it. */
export function lineProfileContentKey(p: Omit<PublishedLineProfile, "changed_at"> | null | undefined): string {
  if (!p) return "";
  const facts: Record<string, unknown> = { default: !!p.default, finders: p.finders };
  for (const k of FACT_KEYS) facts[k] = p[k];
  return canonicalJson(facts);
}

/** Whether a publish would write anything: content, or where the file lives and which device holds it. */
export function lineProfileUnchanged(prev: PublishedLineProfile | null | undefined, next: Omit<PublishedLineProfile, "changed_at" | "published_at">): boolean {
  return !!prev
    && lineProfileContentKey(prev) === lineProfileContentKey(next)
    && prev.root === next.root
    && (prev.file ?? null) === (next.file ?? null)
    && prev.device_id === next.device_id;
}
