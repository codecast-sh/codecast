#!/usr/bin/env bun
// Quality gate that judges only the lines a pull request ADDED. It runs the
// real checkers over whole files, then keeps a finding only when the line it
// sits on was added since the merge base.
//
// Why: both checkers carry legacy debt that a whole-repo gate cannot hold.
// `eslint .` in packages/web passes only because a 57-entry baseline
// (packages/web/eslint-suppressions.json) forgives what already existed, and
// packages/cli's typecheck has carried pre-existing errors, which is why
// ci.yml's typecheck job leaves it out of the strict filter. Neither fact should
// let NEW debt through, and neither should turn a pull request red for code it
// never touched (ct-49564).
//
// This gate ignores the eslint baseline on purpose: a per-file, per-rule count
// forgives whichever occurrence it likes, so adding a second violation to a
// file that already had one can be reported against either line. Line overlap
// is exact, so the gate asks eslint for every finding and does the filtering
// itself.
//
// Mechanism borrowed from stablyai/orca (MIT):
// config/scripts/check-changed-code-quality.mjs and git-pull-request-diff-base.mjs.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** An inclusive, 1-based line range. */
export type LineRange = { start: number; end: number };

/** Added line ranges of the post-image, keyed by repo-relative path. */
export type AddedLines = Map<string, LineRange[]>;

export type Finding = {
  /** Repo-relative path, or null for a checker error with no file. */
  file: string | null;
  /** The line the checker anchored the finding to. */
  line: number;
  code: string;
  message: string;
};

// eslint and tsc only ever speak about these.
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// ---------------------------------------------------------------------------
// Diff parsing
// ---------------------------------------------------------------------------

/**
 * git C-quotes a path with spaces or control characters in the `+++` header and
 * the quoting is JSON-compatible for everything git emits there.
 */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw.slice(1, -1);
  }
}

/**
 * Added line ranges per file from one multi-file `git diff --unified=0`.
 *
 * Reads the post-image side only: a hunk that deletes lines carries `+n,0` and
 * contributes nothing, so removing code can never be blamed for a finding. The
 * diff is taken with rename detection on, so a moved file reports the lines
 * that actually changed instead of its whole body.
 */
export function parseAddedLines(diff: string): AddedLines {
  const byFile: AddedLines = new Map();
  let file: string | null = null;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      // A deleted file's post-image is /dev/null: nothing was added to it.
      file = target === "/dev/null" ? null : unquotePath(target).replace(/^b\//, "");
      continue;
    }
    if (!line.startsWith("@@") || file === null) continue;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number.parseInt(hunk[1]!, 10);
    const count = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2]!, 10);
    if (count <= 0) continue;

    const ranges = byFile.get(file) ?? [];
    ranges.push({ start, end: start + count - 1 });
    byFile.set(file, ranges);
  }
  return byFile;
}

/** Whether a line falls inside any added range. */
export function isAddedLine(line: number, ranges: LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

/**
 * The findings a change is answerable for: everything anchored on an added
 * line, plus every finding the checker could not attribute to a file (a config
 * or whole-program error, which no line filter can excuse).
 *
 * Why the anchor line rather than the finding's whole span: a rule that matches
 * a construct spans it from its first line to its last, so an existing
 * `useEffect` would be blamed the moment someone adds a line inside its body.
 * packages/web carries 57 suppressed call sites of exactly that shape, so a
 * span test would turn every edit near one red — the debt this gate exists to
 * step around. A checker anchors a finding at the construct's first line; when
 * that line is untouched, the construct predates the change.
 */
export function selectNewFindings(findings: Finding[], added: AddedLines): Finding[] {
  return findings.filter((finding) => {
    if (finding.file === null) return true;
    const ranges = added.get(finding.file);
    return ranges ? isAddedLine(finding.line, ranges) : false;
  });
}

// ---------------------------------------------------------------------------
// Checker output parsing
// ---------------------------------------------------------------------------

/** eslint `--format json`, with paths rewritten relative to the repo root. */
export function parseEslintFindings(stdout: string, cwd: string): Finding[] {
  const results = JSON.parse(stdout) as Array<{
    filePath: string;
    messages: Array<{
      severity: number;
      ruleId: string | null;
      message: string;
      line?: number;
      fatal?: boolean;
    }>;
  }>;

  const findings: Finding[] = [];
  for (const result of results) {
    const file = repoRelative(result.filePath, cwd);
    for (const message of result.messages) {
      // Warnings are advice; only errors block. A parse error (fatal, no rule)
      // has no honest line filter, so it reports as a whole-file failure.
      if (message.severity !== 2) continue;
      findings.push({
        file: message.fatal && message.line === undefined ? null : file,
        line: message.line ?? 1,
        code: message.ruleId ?? "eslint",
        message: message.message,
      });
    }
  }
  return findings;
}

/** tsc `--pretty false` diagnostics, with paths relative to the repo root. */
export function parseTscFindings(stdout: string, cwd: string): Finding[] {
  const findings: Finding[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    // Continuation lines of a multi-line diagnostic are indented; they belong
    // to the error above and carry no location of their own.
    if (!raw.trim() || /^\s/.test(raw)) continue;
    const located = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(raw);
    if (located) {
      findings.push({
        file: repoRelative(located[1]!, cwd),
        line: Number.parseInt(located[2]!, 10),
        code: located[3]!,
        message: located[4]!,
      });
      continue;
    }
    // Whole-program errors ("error TS2688: Cannot find type definition file"),
    // which point at the build rather than at a line.
    const global = /^error (TS\d+): (.*)$/.exec(raw);
    if (global) {
      findings.push({ file: null, line: 1, code: global[1]!, message: global[2]! });
    }
  }
  return findings;
}

function repoRelative(file: string, cwd: string): string {
  const absolute = path.isAbsolute(file) ? file : path.join(cwd, file);
  return path.relative(REPO_ROOT, absolute).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export type Check = {
  /** The id ci.yml invokes this check by. */
  id: string;
  label: string;
  /** Repo-relative directory whose changed files make this check worth running. */
  scope: string;
  run: (files: string[]) => Finding[];
};

function git(args: string[]): string {
  // core.quotePath=false: a non-ASCII path stays literal in the `+++` header
  // instead of arriving as octal escapes the parser would have to decode.
  const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim()}`);
  }
  return result.stdout;
}

function runEslint(files: string[]): Finding[] {
  const cwd = path.join(REPO_ROOT, "packages/web");
  // An empty baseline in a temp file: eslint reads `eslint-suppressions.json`
  // by default, and a suppressed finding never reaches us to be line-filtered.
  const empty = path.join(mkdtempSync(path.join(tmpdir(), "changed-lines-")), "none.json");
  writeFileSync(empty, "{}\n");

  const result = spawnSync(
    "bunx",
    [
      "eslint",
      "--format",
      "json",
      "--suppressions-location",
      empty,
      "--no-warn-ignored",
      ...files.map((file) => path.relative(cwd, path.join(REPO_ROOT, file))),
    ],
    { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const stdout = result.stdout?.trim() ?? "";
  if (!stdout.startsWith("[")) {
    throw new Error(`eslint produced no JSON (exit ${result.status}):\n${result.stderr}`);
  }
  return parseEslintFindings(stdout, cwd);
}

function runTsc(pkg: string, project: string): (files: string[]) => Finding[] {
  return () => {
    const cwd = path.join(REPO_ROOT, pkg);
    // tsc has no per-file mode under a project, so it checks the whole package
    // and the line filter does the rest.
    const result = spawnSync("bunx", ["tsc", "--noEmit", "--pretty", "false", "-p", project], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "";
    if (result.status !== 0 && !stdout.trim()) {
      throw new Error(
        `tsc failed before reporting diagnostics (exit ${result.status}):\n${result.stderr}`,
      );
    }
    return parseTscFindings(stdout, cwd);
  };
}

export const CHECKS: Check[] = [
  {
    id: "eslint-web",
    label: "eslint (packages/web)",
    scope: "packages/web/",
    run: runEslint,
  },
  {
    id: "tsc-cli",
    label: "tsc (packages/cli)",
    scope: "packages/cli/",
    run: runTsc("packages/cli", "tsconfig.typecheck.json"),
  },
  {
    id: "tsc-convex",
    label: "tsc (packages/convex)",
    scope: "packages/convex/",
    run: runTsc("packages/convex", "convex/tsconfig.json"),
  },
];

/**
 * Checks ci.yml deliberately does not invoke, and why. The workflow contract
 * test reads this: every other check must appear in a job, so wiring one is
 * never forgotten silently.
 */
export const CI_EXEMPT_CHECKS: Record<string, string> = {
  "tsc-convex":
    "ci.yml's typecheck job already runs the whole convex project strictly, which subsumes a changed-lines pass. Keep the check for local runs and for the day that strict run cannot be held green.",
};

// ---------------------------------------------------------------------------
// Base resolution
// ---------------------------------------------------------------------------

/** The two git questions base resolution asks, injectable so it can be tested. */
export type RefResolver = {
  exists: (ref: string) => boolean;
  mergeBase: (base: string, head: string) => string;
};

const LIVE_REFS: RefResolver = {
  exists: (ref) =>
    spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    }).status === 0,
  mergeBase: (base, head) => git(["merge-base", base, head]).trim(),
};

/**
 * The commit the added lines are measured against: the merge base of the pull
 * request's base and the CHECKED-OUT tree, falling back to origin/main outside
 * a pull request.
 *
 * Why the working HEAD and not `github.event.pull_request.head.sha`: the
 * checkers read the tree on disk, so the line numbers they report only mean
 * something against that same tree. actions/checkout gives a pull request the
 * merge ref — the base branch with the pull request merged in — whose merge base
 * with `base.sha` IS `base.sha`, so this diff is the pull request's own changes,
 * numbered as the merge result the checkers just read. Pairing `base.sha` with
 * `head.sha` instead would number the hunks against a tree nobody checked.
 *
 * Returns null only on a CI event that is not a pull request and has no base ref
 * to fall back on. There is no pull request to gate there, and a push to main
 * has already passed this gate, so a missing base is not an error. A local run
 * has no event name, so it gets the actionable error instead of a pass.
 */
export function resolveDiffBase(
  env: Record<string, string | undefined>,
  refs: RefResolver = LIVE_REFS,
): string | null {
  for (const candidate of [env.BASE_SHA, env.CHANGED_LINES_BASE, "origin/main", "main"]) {
    if (!candidate || !refs.exists(candidate)) continue;
    return refs.mergeBase(candidate, "HEAD");
  }
  if (env.BASE_SHA) {
    throw new Error(`BASE_SHA ${env.BASE_SHA} is not a commit in this checkout.`);
  }
  if (env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_NAME !== "pull_request") return null;
  throw new Error(
    "No diff base: set BASE_SHA to the pull request base, or fetch origin/main locally.",
  );
}

/**
 * Added lines per source file since `base`, including files that are not yet
 * committed. An uncommitted working tree is the normal case for a local run,
 * and a gate that only saw commits would pass on work it never read.
 */
export function collectAddedLines(base: string): AddedLines {
  const tracked = parseAddedLines(git(["diff", "--unified=0", "--no-color", "-M", base, "--"]));
  const added: AddedLines = new Map();
  for (const [file, ranges] of tracked) {
    if (SOURCE_FILE.test(file) && existsSync(path.join(REPO_ROOT, file))) added.set(file, ranges);
  }
  // An untracked file has no diff, so every one of its lines is new.
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean);
  for (const file of untracked) {
    if (!SOURCE_FILE.test(file)) continue;
    const absolute = path.join(REPO_ROOT, file);
    if (!existsSync(absolute)) continue;
    added.set(file, [{ start: 1, end: readFileSync(absolute, "utf8").split(/\r?\n/).length }]);
  }
  return added;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function annotate(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function report(check: Check, finding: Finding): void {
  const title = annotate(`${check.label} ${finding.code}`);
  const where = finding.file === null ? "" : `file=${annotate(finding.file)},line=${finding.line},`;
  console.error(`::error ${where}title=${title}::${annotate(finding.message)}`);
  console.error(
    `${finding.file ?? check.label}:${finding.line} ${finding.code}: ${finding.message}`,
  );
}

export function main(ids: string[], env: Record<string, string | undefined>): number {
  const unknown = ids.filter((id) => !CHECKS.some((check) => check.id === id));
  if (unknown.length > 0) {
    console.error(
      `Unknown check(s): ${unknown.join(", ")}. Known: ${CHECKS.map((c) => c.id).join(", ")}`,
    );
    return 1;
  }
  const selected = ids.length === 0 ? CHECKS : CHECKS.filter((check) => ids.includes(check.id));

  const base = resolveDiffBase(env);
  if (base === null) {
    console.log(`Changed-lines gate: no pull request base on a ${env.GITHUB_EVENT_NAME} event.`);
    return 0;
  }
  const added = collectAddedLines(base);
  console.log(
    `Changed-lines gate: ${added.size} changed source file(s) since ${base.slice(0, 12)}.`,
  );

  let failures = 0;
  for (const check of selected) {
    const files = [...added.keys()].filter((file) => file.startsWith(check.scope));
    if (files.length === 0) {
      console.log(`${check.label}: no changed files.`);
      continue;
    }
    const findings = selectNewFindings(check.run(files), added);
    for (const finding of findings) report(check, finding);
    failures += findings.length;
    console.log(
      `${check.label}: ${findings.length} finding(s) on added lines across ${files.length} changed file(s).`,
    );
  }

  if (failures > 0) {
    console.error(`Changed-lines gate failed with ${failures} finding(s) since ${base.slice(0, 12)}.`);
    return 1;
  }
  console.log(`Changed-lines gate passed since ${base.slice(0, 12)}.`);
  return 0;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2).filter((arg) => arg !== "--"), process.env));
}
