// Layer 0 of the Changes page (docs/proposals/changes-page.md 7.1): what a
// single commit is, read from its subject and its paths alone. Pure: no reads,
// no clock. Convex's buildDay, the tests and the web evidence drawer all call
// these, so a commit is classified one way everywhere.

/** What a story is about, in the vocabulary the prose call also answers in. */
export type ChangeKind = "feature" | "fix" | "perf" | "infra" | "docs" | "test" | "release" | "revert";

/** One area's share of a commit: files touched and lines changed. */
export type AreaTouch = { touches: number; insertions: number; deletions: number };

/** A commit's files collapsed to what layer 0 reads (spec 7.1 step 1). */
export type FileSummary = {
  areas: Record<string, AreaTouch>;
  /** The 8 paths with the most changed lines, largest first. */
  top_paths: string[];
  /** Every path the schema risk names, so a 600-file commit cannot hide one past the top 8. */
  schema_paths: string[];
};

export type CommitFile = { filename: string; additions: number; deletions: number };

/** Directories whose child names the area: `packages/web/x.ts` is `web`. */
const CONTAINER_DIRS = new Set(["packages", "apps", "backend"]);

/** Files at the repository root (package.json, bun.lock) share one area. */
export const ROOT_AREA = "root";

/**
 * The area a path belongs to: `packages/<x>`, `apps/<x>`, `backend/<x>`, else
 * the first path segment, else `root`. A leading dot is dropped so `.github`
 * reads as `github`.
 */
export function areaOf(path: string): string {
  const parts = path.replace(/^\.?\/+/, "").split("/").filter(Boolean);
  if (parts.length <= 1) return ROOT_AREA;
  const head = CONTAINER_DIRS.has(parts[0]) && parts.length > 2 ? parts[1] : parts[0];
  return head.replace(/^\.+/, "") || ROOT_AREA;
}

const SCHEMA_PATH = /(^|\/)schema\.ts$|(^|\/)migrations\/|\.sql$|(^|\/)prisma\//;

export function isSchemaPath(path: string): boolean {
  return SCHEMA_PATH.test(path);
}

export const TOP_PATHS = 8;

/** Collapse a commit's file list to areas, top paths and schema paths. */
export function summarizeFiles(files: readonly CommitFile[]): FileSummary {
  const areas: Record<string, AreaTouch> = {};
  for (const f of files) {
    const a = (areas[areaOf(f.filename)] ??= { touches: 0, insertions: 0, deletions: 0 });
    a.touches += 1;
    a.insertions += f.additions;
    a.deletions += f.deletions;
  }
  const top_paths = [...files]
    .sort((x, y) => y.additions + y.deletions - (x.additions + x.deletions) || x.filename.localeCompare(y.filename))
    .slice(0, TOP_PATHS)
    .map((f) => f.filename);
  const schema_paths = files.map((f) => f.filename).filter(isSchemaPath);
  return { areas, top_paths, schema_paths };
}

/** Areas ranked by files touched, then lines, then name, so ties never flip. */
export function rankAreas(areas: Record<string, AreaTouch>): string[] {
  return Object.keys(areas).sort((x, y) => {
    const a = areas[x];
    const b = areas[y];
    return b.touches - a.touches || b.insertions + b.deletions - (a.insertions + a.deletions) || x.localeCompare(y);
  });
}

export type Conventional = { type: string; scope: string | null; breaking: boolean; description: string };

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;

/** Parse `type(scope)!: description`; null when the subject is not conventional. */
export function parseConventional(subject: string): Conventional | null {
  const m = CONVENTIONAL.exec(subject.trim());
  if (!m) return null;
  return { type: m[1].toLowerCase(), scope: m[2]?.trim().toLowerCase() || null, breaking: !!m[3], description: m[4].trim() };
}

/**
 * Names a scope or a release word may use for an area, beyond the area's own
 * name. `fix(extension)` lands in `packages/browser-extension`, and
 * `release desktop` ships `packages/electron`.
 */
const AREA_ALIASES: Record<string, readonly string[]> = {
  extension: ["browser-extension", "chrome-extension"],
  desktop: ["electron", "desktop"],
  backend: ["convex"],
};

/** Whether a conventional scope names this area. */
export function scopeNamesArea(scope: string, area: string): boolean {
  if (scope === area) return true;
  if (AREA_ALIASES[scope]?.includes(area)) return true;
  return area.endsWith(`-${scope}`) || area.startsWith(`${scope}-`);
}

/**
 * The area a commit belongs to: the scope's area when the files agree with
 * it, else the area with the most touches. A commit with no file data falls
 * back to its scope, then `root`.
 */
export function commitArea(areas: Record<string, AreaTouch>, scope: string | null): string {
  const ranked = rankAreas(areas);
  if (scope) {
    const named = ranked.find((a) => scopeNamesArea(scope, a));
    if (named) return named;
  }
  return ranked[0] ?? scope ?? ROOT_AREA;
}

export type ReleaseMatch = { surface: string; version: string; scope: string | null };

const RELEASE = /^(?:chore|release)(?:\(([^)]+)\))?: (?:bump|release)\b(.*?)v?(\d+\.\d+\.\d+)/i;

/** Surfaces a release subject may name (`release desktop 1.1.123`). */
const SURFACE_WORDS = ["cli", "desktop", "extension", "backend", "web", "mobile"] as const;

/** A scope that names a package rather than the surface it ships as. */
const SCOPE_SURFACE: Record<string, string> = {
  electron: "desktop",
  "browser-extension": "extension",
  "chrome-extension": "extension",
  convex: "backend",
};

/** Scopes that bump a dependency, never the product's own version. */
const DEPENDENCY_SCOPES = new Set(["deps", "dep", "deps-dev", "dev-deps", "dependencies", "dependency", "npm", "pip", "cargo", "gomod", "bundler", "lockfile"]);

/**
 * A version-bump commit (spec 7.1 step 3): `chore(cli): bump version to
 * 1.1.163`, `chore(electron): release desktop 1.1.123`. The surface is the
 * word the subject names before the version, else the scope mapped to its
 * surface, else `release`. A dependency bump (`chore(deps): bump lodash from
 * 1.0.0 to 2.0.0`) is not a release.
 */
export function parseRelease(subject: string): ReleaseMatch | null {
  const m = RELEASE.exec(subject.trim());
  if (!m) return null;
  const scope = m[1]?.trim().toLowerCase() || null;
  if (scope && DEPENDENCY_SCOPES.has(scope)) return null;
  const words = m[2].toLowerCase().split(/[^a-z-]+/);
  // `bump X from A to B` names a dependency unless X is the version itself, whose new value is B.
  let version = m[3];
  if (words.includes("from")) {
    if (!words.includes("version")) return null;
    version = /\bto\s+v?(\d+\.\d+\.\d+)/i.exec(subject)?.[1] ?? version;
  }
  const named = SURFACE_WORDS.find((w) => words.includes(w));
  const surface = named ?? (scope ? SCOPE_SURFACE[scope] ?? scope : "release");
  return { surface, version, scope };
}

const RESTAMP = /^chore\([^)]*\): restamp\b/i;

/** A build restamp that rides along with a release (`chore(cli): restamp daemon build id`). */
export function isRestamp(subject: string): boolean {
  return RESTAMP.test(subject.trim());
}

/** A revert, conventional (`revert: x`) or git's own (`Revert "x"`). */
export function isRevert(subject: string): boolean {
  return /^revert\b/i.test(subject.trim());
}

const TYPE_KIND: Record<string, ChangeKind> = {
  feat: "feature",
  feature: "feature",
  fix: "fix",
  hotfix: "fix",
  perf: "perf",
  docs: "docs",
  doc: "docs",
  test: "test",
  tests: "test",
  revert: "revert",
  release: "release",
};

/** Leading verbs of a subject that is not conventional. */
const VERB_KIND: [RegExp, ChangeKind][] = [
  [/^(fix|fixes|fixed|repair|resolve|stop|prevent)\b/i, "fix"],
  [/^(add|adds|added|implement|introduce|support|new|build|create)\b/i, "feature"],
  [/^(speed up|faster|optimi[sz]e|cache)\b/i, "perf"],
  [/^(document|docs?)\b/i, "docs"],
  [/^tests?\b/i, "test"],
];

/** The kind a commit's subject declares. Unknown types read as infra, which carries no glyph. */
export function subjectKind(subject: string): ChangeKind {
  if (isRevert(subject)) return "revert";
  if (parseRelease(subject)) return "release";
  const conv = parseConventional(subject);
  if (conv) return TYPE_KIND[conv.type] ?? "infra";
  for (const [re, kind] of VERB_KIND) if (re.test(subject.trim())) return kind;
  return "infra";
}

/** The first line of a commit message, and the rest with trailers stripped. */
export function splitMessage(message: string): { subject: string; body: string } {
  const nl = message.indexOf("\n");
  const subject = (nl < 0 ? message : message.slice(0, nl)).trim();
  const body = nl < 0 ? "" : stripTrailers(message.slice(nl + 1)).trim();
  return { subject, body };
}

const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: \S/;

/** Drop the final paragraph when every line in it is a git trailer (`Codecast-Session: ...`). */
export function stripTrailers(body: string): string {
  const paras = body.trimEnd().split(/\n\s*\n/);
  const last = paras[paras.length - 1]?.split("\n").filter((l) => l.trim()) ?? [];
  if (last.length && last.every((l) => TRAILER_LINE.test(l.trim()))) paras.pop();
  return paras.join("\n\n");
}
