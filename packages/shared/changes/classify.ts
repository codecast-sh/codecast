// Layer 0 of the Changes page (docs/proposals/changes-page.md 7.1): what a
// single commit is, read from its subject and its paths alone. Pure: no reads,
// no clock. Convex's buildDay, the tests and the web evidence drawer all call
// these, so a commit is classified one way everywhere.

/** What a story is about, in the vocabulary the prose call also answers in. */
export type ChangeKind = "feature" | "fix" | "perf" | "infra" | "docs" | "test" | "release" | "revert";

/**
 * One area's share of a commit: files touched and lines changed, and how many
 * of those lines sit in generated files (isGeneratedPath). Commits projected
 * before `generated` existed read as all source.
 */
export type AreaTouch = { touches: number; insertions: number; deletions: number; generated?: number };

/** A commit's files collapsed to what layer 0 reads (spec 7.1 step 1). */
export type FileSummary = {
  areas: Record<string, AreaTouch>;
  /** The same touches one folder deeper, keyed `area/sub` (narrowAreas). */
  subareas: Record<string, AreaTouch>;
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
  return areaParts(path).area;
}

/** Whether a path lands in an area as a day names it: the area itself, or the folder under it once narrowAreas split it. */
export function pathInArea(path: string, area: string): boolean {
  const p = areaParts(path);
  return p.area === area || p.sub === area;
}

/** The area and, when the path goes deeper, the folder under it: `outreach/backend/x.ts` is `outreach` then `backend`. */
function areaParts(path: string): { area: string; sub: string | null } {
  const parts = path.replace(/^\.?\/+/, "").split("/").filter(Boolean);
  if (parts.length <= 1) return { area: ROOT_AREA, sub: null };
  const contained = CONTAINER_DIRS.has(parts[0]) && parts.length > 2;
  const rest = parts.slice(contained ? 2 : 1);
  return { area: (contained ? parts[1] : parts[0]).replace(/^\.+/, "") || ROOT_AREA, sub: rest.length > 1 ? rest[0] : null };
}

const SCHEMA_PATH = /(^|\/)schema\.ts$|(^|\/)migrations\/|\.sql$|(^|\/)prisma\//;

/**
 * Files no one wrote by hand: lockfiles, drizzle snapshots, generated code,
 * test fixtures and snapshots, fonts and images. Their lines are real diff
 * but not work to review, so size judgments (the bulk risk, the order of a
 * story's files) read past them.
 */
const GENERATED_PATH = new RegExp([
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|composer\.lock|Podfile\.lock|go\.sum|flake\.lock)$/.source,
  /(^|\/)meta\/[^/]*_snapshot\.json$/.source,
  /(^|\/)(_generated|__generated__|__fixtures__|__snapshots__)\//.source,
  /\.snap$/.source,
  /\.(woff2?|ttf|otf|eot)$/.source,
  /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|svg)$/.source,
].join("|"), "i");

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH.test(path);
}

export function isSchemaPath(path: string): boolean {
  return SCHEMA_PATH.test(path);
}

export const TOP_PATHS = 8;

/** Collapse a commit's file list to areas, top paths and schema paths. */
export function summarizeFiles(files: readonly CommitFile[]): FileSummary {
  const areas: Record<string, AreaTouch> = {};
  const subareas: Record<string, AreaTouch> = {};
  const add = (bag: Record<string, AreaTouch>, key: string, f: CommitFile) => {
    const a = (bag[key] ??= { touches: 0, insertions: 0, deletions: 0, generated: 0 });
    a.touches += 1;
    a.insertions += f.additions;
    a.deletions += f.deletions;
    if (isGeneratedPath(f.filename)) a.generated! += f.additions + f.deletions;
  };
  for (const f of files) {
    const { area, sub } = areaParts(f.filename);
    add(areas, area, f);
    add(subareas, sub ? `${area}/${sub}` : area, f);
  }
  const top_paths = [...files]
    .sort((x, y) => y.additions + y.deletions - (x.additions + x.deletions) || x.filename.localeCompare(y.filename))
    .slice(0, TOP_PATHS)
    .map((f) => f.filename);
  const schema_paths = files.map((f) => f.filename).filter(isSchemaPath);
  return { areas, subareas, top_paths, schema_paths };
}

/** One area holding this share of a day's file touches is split into the folders under it. */
export const NARROW_SHARE = 0.8;

/**
 * A repository whose work all sits under one folder (`outreach/backend`,
 * `outreach/web`) would put every story of the day in one section. When one
 * area holds most of the day's touches, its touches are relabelled by the
 * folder under it, so the day reads as backend, web, mobile. Commits without
 * subareas (rows projected before they existed) keep their areas.
 */
export function narrowAreas<C extends { areas: Record<string, AreaTouch>; subareas?: Record<string, AreaTouch> }>(commits: readonly C[]): C[] {
  const totals: Record<string, number> = {};
  let all = 0;
  for (const c of commits) for (const [a, t] of Object.entries(c.areas)) { totals[a] = (totals[a] ?? 0) + t.touches; all += t.touches; }
  const [top] = Object.entries(totals).sort((x, y) => y[1] - x[1]);
  if (!top || top[1] < all * NARROW_SHARE) return [...commits];
  const subs = new Set(commits.flatMap((c) => Object.keys(c.subareas ?? {}).filter((k) => k.startsWith(`${top[0]}/`))));
  if (subs.size < 2) return [...commits];
  return commits.map((c) => splitArea(c, top[0]));
}

/** One commit with `top` replaced by its subareas, named without the prefix, as narrowAreas splits a day's dominant area. */
export function splitArea<C extends { areas: Record<string, AreaTouch>; subareas?: Record<string, AreaTouch> }>(c: C, top: string): C {
  if (!c.subareas || !c.areas[top]) return c;
  const areas: Record<string, AreaTouch> = {};
  for (const [a, t] of Object.entries(c.areas)) if (a !== top) areas[a] = t;
  for (const [k, t] of Object.entries(c.subareas)) {
    if (k !== top && !k.startsWith(`${top}/`)) continue;
    const label = k === top ? top : k.slice(top.length + 1);
    const into = (areas[label] ??= { touches: 0, insertions: 0, deletions: 0, generated: 0 });
    into.touches += t.touches;
    into.insertions += t.insertions;
    into.deletions += t.deletions;
    into.generated! += t.generated ?? 0;
  }
  return { ...c, areas };
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
  return { surface: surfaceNamed(words, scope), version, scope };
}

/** The surface a release names: a surface word it says, else its scope mapped to its surface, else `release`. */
function surfaceNamed(words: readonly string[], scope: string | null): string {
  const named = SURFACE_WORDS.find((w) => words.includes(w));
  return named ?? (scope ? SCOPE_SURFACE[scope] ?? scope : "release");
}

const TAG = /^(.*?)[-_/@]?v?(\d+(?:\.\d+){1,3}(?:[-+][0-9a-z.+-]+)?)$/i;

/**
 * A pushed tag read as a release (spec 7.3): `v1.2.3`, `cli-v1.1.163`,
 * `desktop/1.1.123`, `@codecast/cli@1.2.3`. The name before the version picks
 * the surface the way a release commit's scope does. A tag with no version
 * (`latest`, `nightly`) is a moving pointer, not a release, and reads as null.
 */
export function parseReleaseTag(tag: string): { surface: string; version: string } | null {
  const m = TAG.exec(tag.trim().replace(/^refs\/tags\//, ""));
  if (!m) return null;
  const name = m[1].toLowerCase().replace(/[-_/@]+$/, "");
  const last = name.split("/").pop() ?? "";
  const scope = last && last !== "release" && last !== "v" ? last : null;
  return { surface: surfaceNamed(name.split(/[^a-z]+/), scope), version: m[2] };
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
