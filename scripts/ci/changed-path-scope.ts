#!/usr/bin/env bun
// Classifies the files a pull request touches into areas, then derives one
// boolean per CI job from those areas. `.github/workflows/ci.yml` reads the
// booleans from `code_paths` and gates each job on its own.
//
// Why: a docs-only pull request used to start the whole matrix — build,
// typecheck, lint and three test jobs (ct-49562).
//
// Anything this file does not recognise turns every flag true, so a new
// top-level directory runs the full matrix until someone maps it here. A false
// is a claim that nothing the job covers changed, and only the mappings below
// can make that claim.

export const AREAS = [
  "cli",
  "web",
  "convex",
  "shared",
  // The vendored @platform mirror. Its own area rather than a corner of
  // "shared", so the job that tests it and checks it for drift can gate on
  // just that mirror (ct-49675).
  "platform",
  "electron",
  "mobile",
  "extension",
  "docs",
] as const;

export type Area = (typeof AREAS)[number];

// Which areas make each ci.yml job worth running. A job runs when any of its
// areas changed. The mapping follows what the job actually executes: `lint`
// only lints packages/web, `typecheck` filters to web + convex, and every
// package test reads @codecast/shared.
export const JOB_AREAS: Record<string, Area[]> = {
  build: ["cli", "web", "shared", "extension"],
  typecheck: ["web", "convex", "shared"],
  lint: ["web"],
  "test-convex": ["convex", "shared"],
  "test-web": ["web", "shared"],
  "test-cli": ["cli", "shared"],
  build: ["cli", "web", "shared", "extension", "platform"],
  typecheck: ["web", "convex", "shared", "platform"],
  lint: ["web"],
  "test-convex": ["convex", "shared", "platform"],
  "test-web": ["web", "shared", "platform"],
  "test-cli": ["cli", "shared", "platform"],
  // The mirror's own job: its package tests, and the drift check. Every other
  // job above lists "platform" too, because the mirror is a dependency of all
  // of them and used to reach them through "shared".
  "test-platform": ["platform"],
};

export const GATED_JOBS = Object.keys(JOB_AREAS);

/**
 * Jobs that report without gating: outside `verify`, `continue-on-error`, and
 * so free to be red while a feature is still landing. They reuse a gated job's
 * flag rather than earning one, because the areas that make a job worth running
 * do not change when the job stops being required.
 *
 * `computer-macos` builds and exercises the `cast computer` helper, which needs
 * a Mac and a Swift toolchain. It becomes a gate — moved into JOB_AREAS and into
 * verify — after ten green runs in a row (ct-49523).
 */
export const ADVISORY_JOBS = ["computer-macos"];

/** The `code_paths` output name carrying a job's gate. */
export function jobFlag(job: string): string {
  return `run_${job.replace(/-/g, "_")}`;
}

const AREA_PREFIXES: Array<[Exclude<Area, "docs">, string[]]> = [
  ["cli", ["packages/cli/"]],
  ["web", ["packages/web/"]],
  ["convex", ["packages/convex/"]],
  ["shared", ["packages/shared/"]],
  // The vendored mirror is its own area: a change to it runs the platform
  // tests and the manifest drift check, which "shared" alone never did
  // (ct-49675).
  ["platform", ["platform/"]],
  ["shared", ["packages/shared/"]],
  ["platform", ["platform/"]],
  ["electron", ["packages/electron/", "packages/desktop/"]],
  ["mobile", ["packages/mobile/"]],
  ["extension", ["packages/browser-extension/", "packages/vscode-extension/"]],
];

const DOCS_FILES = new Set([
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CLAUDE.md",
  "AGENTS.md",
  "LICENSE",
  ".github/CODEOWNERS",
  ".github/pull_request_template.md",
]);

const DOCS_PREFIXES = ["docs/", ".github/ISSUE_TEMPLATE/"];

function isDocsPath(file: string): boolean {
  return DOCS_FILES.has(file) || DOCS_PREFIXES.some((prefix) => file.startsWith(prefix));
}

/** The area a path belongs to, or null when nothing here claims it. */
export function areaOf(file: string): Area | null {
  for (const [area, prefixes] of AREA_PREFIXES) {
    if (prefixes.some((prefix) => file.startsWith(prefix))) return area;
  }
  return isDocsPath(file) ? "docs" : null;
}

/**
 * Paths that make the vendored mirror worth re-checking on top of whatever area
 * they belong to. The mirror's package set is derived from the workspace
 * manifests: scripts/vendor-platform.sh reads the `@platform` dep lines out of
 * every package.json under packages. Adopting a package there is what makes the
 * mirror wrong, and the mirror check is the only thing that catches the
 * adoption landing without a re-vendor (ct-49675).
 */
export function touchesPlatform(file: string): boolean {
  return file.startsWith("platform/") || /^packages\/[^/]+\/package\.json$/.test(file);
}

export type Scope = {
  /** Every area and job flag, in emit order. */
  flags: Record<string, boolean>;
  /** Why the classifier ran everything, empty when it filtered. */
  forcedBy: string[];
};

export function classifyChangedPaths(files: string[]): Scope {
  const paths = files.map((file) => file.trim()).filter(Boolean);
  const forcedBy: string[] = [];

  // Why fail closed: an empty diff is far more likely a broken checkout, a
  // missing merge base or a push event than a genuine no-op, and a wrong false
  // silently drops a gate the branch protection thinks it ran.
  if (paths.length === 0) forcedBy.push("empty diff");

  const areas = new Set<Area>();
  for (const file of paths) {
    const area = areaOf(file);
    if (touchesPlatform(file)) areas.add("platform");
    if (area === null) {
      forcedBy.push(file);
      continue;
    }
    areas.add(area);
  }

  const forced = forcedBy.length > 0;
  const flags: Record<string, boolean> = {};
  for (const area of AREAS) flags[area] = forced || areas.has(area);
  for (const [job, jobAreas] of Object.entries(JOB_AREAS)) {
    flags[jobFlag(job)] = forced || jobAreas.some((area) => areas.has(area));
  }
  return { flags, forcedBy };
}

export function formatScope(scope: Scope): string {
  return Object.entries(scope.flags)
    .map(([name, value]) => `${name}=${value ? "true" : "false"}`)
    .join("\n");
}

if (import.meta.main) {
  const stdin = await Bun.stdin.text();
  const scope = classifyChangedPaths(stdin.split("\n"));
  if (scope.forcedBy.length > 0) {
    console.error(`Running every job — unclassified input: ${scope.forcedBy.join(", ")}`);
  }
  console.log(formatScope(scope));
}
