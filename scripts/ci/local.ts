#!/usr/bin/env bun
// CI's own checks, run on this machine for what a branch changed, so a change
// gets past CI on its first push (ct-102059).
//
// The changed paths are the diff from the merge base with origin/main (or
// --base), uncommitted and untracked files included (--committed: commits alone). changed-path-scope.ts
// classifies them exactly as ci.yml classifies a pull request, so the same
// jobs gate on. Each gated job runs its ci.yml steps, except:
// - typecheck: `cast check --changed-since <base>` (by name with --full),
//   never a bare tsc. It also checks mobile, which CI does not.
// - a package test step (REACHED_STEPS) runs, by default, the suite's test
//   files that are changed; that import a changed file (test-reach.ts's import
//   graph; only directly, for a hub file); that read a changed file by name;
//   or that walk their own package's tree while that package changed. A
//   changed lockfile, manifest, tsconfig, bunfig or test preload runs the
//   whole suite. test-always already ran each suite's guards, ratchets and
//   crossing tests. Where the hub rule left tests out, the run says so.
// - the steps in DEFAULT_DROPS run only with --full; RUNNER_SETUP never runs.
// - a job whose `runs-on` is another OS and whose steps need it (xvfb-run,
//   apt) is skipped as not reproducible here: neither a failure nor no verdict.
//
// Steps run as on a runner: on the bun CI pins (fetched once with bunx), with
// CI=true, no agent client on PATH, no agent session's variables, and a tmux
// of the run's own (TMUX_TMPDIR), so ci.yml's bare `tmux kill-server` never
// reaches the person's. cast check keeps the person's environment. Jobs run
// one after another: the laptop runs out of memory running them at once.
// Within a job, a step CI runs on several matrix runners (web's and cli's
// shards) runs once per runner, side by side, each `--parallel` on a runner's
// four workers; reached tests split the same way, by test-times.json. A
// one-process suite is cut into up to four shards. Each step's output goes to a log file rather
// than a pipe (quiet-watchdog.sh says why) and is read the way the change
// flow's CI station reads a red job's log (shared/contracts/ciFailures.ts).
//
// The run ends with one line per job. Exit 0 green, 1 a test or type failure,
// 2 no verdict: a step hung or timed out, or cast check could not answer
// (those are failures of job `ci-station`), as is a crash. Before saying red,
// each failing test file runs once more alone; one that passes is flaky under
// load (local-flaky.ts). --budget <minutes>: steps still running then, and
// jobs left, have no verdict (the re-runs get RERUN_GRACE_MS more, the run
// HARD_STOP_MS). --no-typecheck leaves typechecking to CI, for a fresh
// worktree whose programs would start cold. --json <path> writes {green, head_sha, dirty, failing, flaky,
// narrowed, jobs}; the change flow's Local CI station runs this before the pull
// request (.codecast/flows/change.cast) and writes it under its own file name,
// never ci.json, which is the CI station's verdict on GitHub's CI. --list
// prints the plan.
//
//   bun scripts/ci/local.ts [--base <ref>] [--committed] [--full] [--no-typecheck] [--budget <minutes>] [--json <path>] [--list]

import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { LOCAL_AGENT_CLIENTS } from "../../packages/shared/contracts/agentClients";
import { parseFailures, type CiFailure } from "../../packages/shared/contracts/ciFailures";
import { alwaysRunFiles, SUITES } from "./always-run-tests";
import { settledJobs, sortFlaky, suiteOf } from "./local-flaky";
import { ADVISORY_JOBS, classifyChangedPaths, computerScope, injectionScope } from "./changed-path-scope";
import { importClosure, jobTestFiles } from "./test-reach";
import { shard as byTime } from "./test-shards";

const ROOT = join(import.meta.dir, "..", "..");
export const WORKFLOW = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as any;
/** `cast check`'s programs by name (.codecast/check.toml). */
const CHECK_PROJECTS = (Bun.TOML.parse(readFileSync(join(ROOT, ".codecast/check.toml"), "utf8")) as any).projects as Record<string, string>;

/** Steps that set up a runner, not the code: neither mode runs them. */
export const RUNNER_SETUP: Record<string, string> = {
  "Install tmux": "a laptop has its own tmux",
  "Install tmux (e2e tests need a real tmux server)": "a laptop has its own tmux",
  "Allow the Electron sandbox, and a display for it": "Linux runner setup (AppArmor, xvfb); macOS needs neither",
};
/** The ci.yml steps a default run replaces with one suite's reached test files, by job, step and suite directory. */
export const REACHED_STEPS: Record<string, Record<string, string>> = {
  "test-convex": { "Unit tests (convex package)": "packages/convex" },
  "test-web": { "Unit tests (web package)": "packages/web" },
  "test-cli": { "Unit tests (cli package)": "packages/cli", "Unit tests (evals package)": "packages/evals" },
  "test-shared": { "Unit tests (shared package)": "packages/shared" },
  "test-mobile": { "Unit and guard tests (mobile package)": "packages/mobile" },
};
/** The ci.yml steps only --full runs, with why the default run leaves them out. */
export const DEFAULT_DROPS: Record<string, Record<string, string>> = {
  build: { Build: "builds every bundle: minutes, and a break shows in typecheck first" },
  "test-web": { "Perf budgets (web)": "exact render and store counts; minutes, and only perf work moves them" },
  "test-cli": {
    "E2E messaging pipeline (real tmux + fake-claude shim)": "the cli step already ran messaging.e2e when the change reaches it; three attempts absorb runner flake",
    "Injection suites (captured frames; real-client cells skip without agent binaries)": "the cli step already ran the inject suites the change reaches; three attempts absorb runner flake",
  },
};
/** CI's typecheck steps, which cast check stands in for in both modes: they run a bare tsc per program. */
export const CAST_CHECK_REPLACES = ["Typecheck"];
/** The programs CI's typecheck matrix checks, which --full asks cast check for by name. */
export const TYPECHECK_PROJECTS: string[] = (WORKFLOW.jobs.typecheck.strategy?.matrix?.include ?? []).flatMap((entry: any) => String(entry.programs).split(/\s+/));
/**
 * `cast check` exits with no verdict. A stale answer (75) restarts the watcher with --fresh. A tool failure (70:
 * a watcher that died or did not start) or a pass that outlived the wait (124) is asked again as it was: --fresh
 * would throw away every program's warm pass and rebuild them all cold.
 */
const CHECK_STALE = 75;
const CHECK_ASK_AGAIN = new Set([70, 124]);
/**
 * Shards that run at once. A suite CI shards over runners (a matrix) gets as many shards as CI runs it on; a
 * one-process suite is cut into up to this many, since one process uses one core.
 */
const SHARDS = 4;
/** The time each test file took on a recent CI run, by package (test-shards.ts), to balance shards by. */
const TEST_TIMES: Record<string, Record<string, number>> = JSON.parse(readFileSync(join(import.meta.dir, "test-times.json"), "utf8"));
/** Below this many files a second process costs more than it saves. */
const MIN_SHARD = 50;
/** Output standing still this long is a hung run, as in quiet-watchdog.sh. */
const QUIET_MS = 240_000;
/** CI's runners have four cores, so ci.yml's `--parallel` means four workers there. */
const RUNNER_CORES = 4;
/**
 * A changed file this share of a suite's tests reach is a hub (a schema, the store, a shared contract): by
 * default only the tests that import it directly run for it, and --full runs the rest. Without this a change
 * to one hub selects most of the suite (1,118 of web's 1,564 files for PR #227).
 */
export const HUB_SHARE = 0.25;

/**
 * `typecheck` marks cast check's step: it answers for its own waiting, so no quiet watchdog stops it.
 * Consecutive `shard` steps run at once.
 */
export type Step = { name: string; cwd: string; argv: string[]; env?: Record<string, string>; typecheck?: boolean; shard?: boolean; timeoutMs?: number; graceMs?: number };
/** `selected` of the `total` tests a change reaches in a suite ran: the hub rule left the rest to --full. */
export type Narrowed = { suite: string; selected: number; total: number };
export type Plan = { job: string; skip?: string; steps: Step[]; files?: number; narrowed: Narrowed[]; wide: string[] };
export type JobResult = { job: string; status: "pass" | "fail" | "no verdict" | "skipped"; seconds: number; reason?: string };

function git(args: string[], cwd = ROOT): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Every path changed since base: committed, staged, unstaged and untracked; `committed`, the commits alone (a change flow's frozen change: an install's rewrite of bun.lock is not the change's). */
export function changedPaths(base: string, committed = false, cwd = ROOT): string[] {
  const lines = committed ? git(["diff", "--name-only", "--no-renames", `${base}...HEAD`], cwd).split("\n") : [...git(["diff", "--name-only", "--no-renames", base], cwd).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"], cwd).split("\n")];
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))].sort();
}

/** ci.yml's code_paths outputs for these paths. */
export function scopeFlags(changed: string[]): Record<string, boolean> {
  return { ...classifyChangedPaths(changed).flags, run_test_injection: injectionScope(changed), run_test_computer: computerScope(changed) };
}

// ── which tests a change reaches ────────────────────────────────────────────

const WALKS_TREE = /\b(readdirSync|readdir|Bun\.Glob|new Glob|globSync|scanSync)\b/;
const OWN_DIR = /import\.meta\.(dir|dirname|url)\b|__dirname|process\.cwd\(\)/;
const READS_FILE = /\b(readFileSync|readFile|Bun\.file)\b/;
const PATH_LITERAL = /["'`]([^"'`\n$]*\.[A-Za-z]{1,5})["'`]/g;

/** A test that lists files under its own directory (a source scan): no import says which change can break it. */
export function walksOwnTree(text: string): boolean {
  return WALKS_TREE.test(text) && OWN_DIR.test(text);
}

/** The changed files a disk-reading test names in a string literal: the file's name, or a path ending in it. */
export function namedFiles(text: string, changed: string[]): string[] {
  if (!READS_FILE.test(text)) return [];
  const named = new Set<string>();
  for (const [, literal] of text.matchAll(PATH_LITERAL)) {
    const tail = literal.replace(/^(\.\.?\/)+/, "");
    for (const file of changed) if (file === tail || file.endsWith(`/${tail}`)) named.add(file);
  }
  return [...named];
}

const packageOf = (file: string) => file.split("/").slice(0, 2).join("/");

/**
 * The tests (repo-relative) a change reaches: changed, importing a changed file (directly, for a hub), naming
 * one they read, or scanning a package that changed. `closureOf` gives each file a test imports with its
 * import distance; `reached` counts what the change reaches without the hub rule.
 */
export function selectTests(tests: string[], changed: string[], closureOf: (test: string) => Map<string, number>, sourceOf: (test: string) => string): { picked: string[]; reached: number } {
  const files = new Set(changed);
  const packages = new Set(changed.map(packageOf));
  const closures = tests.map((test) => [...closureOf(test)].filter(([file, hops]) => hops > 0 && files.has(file)));
  const reach = new Map<string, number>();
  for (const closure of closures) for (const [file] of closure) reach.set(file, (reach.get(file) ?? 0) + 1);
  const hub = (file: string) => reach.get(file)! > HUB_SHARE * tests.length;
  const picked: string[] = [];
  let reached = 0;
  tests.forEach((test, i) => {
    const source = () => sourceOf(test);
    const direct = files.has(test) || (packages.has(packageOf(test)) && walksOwnTree(source())) || namedFiles(source(), changed).length > 0;
    if (direct || closures[i].some(([file, hops]) => hops === 1 || !hub(file))) picked.push(test);
    if (direct || closures[i].length > 0) reached++;
  });
  return { picked, reached };
}

const CONFIG_FILE = /(^|\/)(package\.json|tsconfig[^/]*\.json|bunfig\.toml)$/;

/**
 * Why a change runs a suite whole: the lockfile, a manifest, tsconfig or bunfig at the root or in the suite's
 * package, or a file the suite's test preload imports. null when nothing like that changed.
 */
export function suiteWideBy(dir: string, changed: string[], preload: Set<string>): string | null {
  return changed.find((file) => file === "bun.lock" || (CONFIG_FILE.test(file) && (!file.includes("/") || file.startsWith(`${dir}/`))) || preload.has(file)) ?? null;
}

/** Every file a suite's bunfig test preload imports, repo-relative. */
function preloadClosure(dir: string): Set<string> {
  const bunfig = join(ROOT, dir, "bunfig.toml");
  if (!existsSync(bunfig)) return new Set();
  const preload = (Bun.TOML.parse(readFileSync(bunfig, "utf8")) as any).test?.preload ?? [];
  return new Set([preload].flat().flatMap((file: string) => [...importClosure(join(ROOT, dir, file)).keys()].map((f) => relative(ROOT, f))));
}

const repoClosure = (test: string) => new Map([...importClosure(join(ROOT, test))].map(([file, hops]) => [relative(ROOT, file), hops]));
const sources = new Map<string, string>();
const repoSource = (test: string) => sources.get(test) ?? sources.set(test, readFileSync(join(ROOT, test), "utf8")).get(test)!;

/** One suite's reached test files, one `bun test` per chunk, from its package directory with its job's flags. */
function reachedSteps(job: string, dir: string, changed: string[], ciShards: number): { steps: Step[]; narrowed?: Narrowed; wide?: string } {
  const suite = SUITES.find((s) => s.job === job && s.dir === dir);
  if (!suite) throw new Error(`no suite in always-run-tests.ts for ${job} in ${dir}`);
  const roots = suite.roots.map((root) => `${join(suite.dir, root)}/`);
  const always = new Set(alwaysRunFiles(suite).map((file) => join(suite.dir, file)));
  const tests = jobTestFiles(job)
    .map((file) => relative(ROOT, file))
    .filter((file) => roots.some((root) => file.startsWith(root)) && !always.has(file));
  const wide = suiteWideBy(dir, changed, preloadClosure(dir));
  const chosen = wide ? { picked: tests, reached: tests.length } : selectTests(tests, changed, repoClosure, repoSource);
  const picked = chosen.picked.map((file) => `./${relative(suite.dir, file)}`);
  const flags = suite.flags;
  // A --parallel suite runs as CI's matrix shards do, each on a runner's four workers; one-process suites in up
  // to SHARDS processes. Either way never a shard of fewer than MIN_SHARD files.
  const most = flags.some((flag) => flag.startsWith("--parallel")) ? ciShards : SHARDS;
  const count = Math.max(1, Math.min(most, Math.ceil(picked.length / MIN_SHARD)));
  const shards = picked.length ? byTime(picked.map((file) => file.slice(2)), TEST_TIMES[dir] ?? {}, count) : [];
  const what = wide ? `of all ${tests.length} files (${wide} changed)` : "reached files";
  const steps: Step[] = shards.map((files, i) => ({
    name: `bun test ${[...flags, ""].join(" ")}in ${suite.dir}: ${files.length} ${what}${shards.length > 1 ? `, shard ${i + 1}/${shards.length}` : ""}`,
    cwd: join(ROOT, suite.dir),
    argv: ["bun", "test", ...flags, ...files.map((file) => `./${file}`)],
    shard: true,
  }));
  const narrowed = chosen.picked.length < chosen.reached ? { suite: dir, selected: chosen.picked.length, total: chosen.reached } : undefined;
  return { steps, narrowed, wide: wide ?? undefined };
}

// ── ci.yml, read as a laptop runs it ────────────────────────────────────────

/** A gated job's flag, read from its `if:` in ci.yml; null for an ungated job. */
function jobGate(job: string): string | null {
  const cond = WORKFLOW.jobs[job].if;
  if (cond === undefined) return null;
  const flag = /^needs\.code_paths\.outputs\.(\w+) == 'true'$/.exec(String(cond).trim());
  if (!flag) throw new Error(`ci.yml ${job}: no local reading of its if: ${cond}`);
  return flag[1];
}

type Matrix = Record<string, string | number>;

/**
 * Whether a ci.yml `if:` holds for one matrix entry. A local run stands in for a pull request: `github.event_name`
 * is never `push`, so the build-cache saves and the main-only lanes do not run.
 */
export function stepRuns(cond: unknown, flags: Record<string, boolean>, matrix: Matrix, where: string): boolean {
  if (cond === undefined) return true;
  return String(cond)
    .replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .split("&&")
    .every((term) => {
      const text = term.trim();
      const flag = /^needs\.code_paths\.outputs\.(\w+) == 'true'$/.exec(text);
      if (flag) return flags[flag[1]] === true;
      const cmp = /^(matrix\.([\w-]+)|github\.event_name) (==|!=) '?([^']*)'?$/.exec(text);
      if (cmp) {
        const value = cmp[2] ? String(matrix[cmp[2]]) : "pull_request";
        return (value === cmp[4]) === (cmp[3] === "==");
      }
      if (text === "!cancelled()" || text === "always()" || text === "success()") return true;
      if (text === "failure()") return false;
      throw new Error(`ci.yml ${where}: no local reading of its if: ${cond}`);
    });
}

/** A job's matrix entries, one per runner CI starts for it ([{}] for a job without a matrix). */
export function matrixOf(job: string, workflow = WORKFLOW): Matrix[] {
  const matrix = workflow.jobs[job].strategy?.matrix;
  if (!matrix) return [{}];
  if (matrix.include) return matrix.include;
  return Object.entries(matrix).reduce<Matrix[]>((rows, [key, values]) => rows.flatMap((row) => (values as any[]).map((value) => ({ ...row, [key]: value }))), [{}]);
}

/**
 * One ci.yml step for one matrix entry under GitHub's default bash, with `${{ runner.temp }}` and RUNNER_TEMP at a
 * directory of the entry's own (each runner has its own), and `${{ matrix.* }}` at the entry's values.
 */
function ciStep(job: string, step: any, temp: string, matrix: Matrix = {}): Step {
  const expand = (text: string) => {
    let out = text.replaceAll("${{ runner.temp }}", temp);
    for (const [key, value] of Object.entries(matrix)) out = out.replaceAll(`\${{ matrix.${key} }}`, String(value));
    const left = /\$\{\{[^}]*\}\}/.exec(out);
    if (left) throw new Error(`ci.yml ${job} › ${step.name}: no local value for ${left[0]}`);
    return out;
  };
  // A runner's `--parallel` is four workers.
  const run = expand(step.run).replace(/--parallel(?=\s|$)/g, `--parallel=${RUNNER_CORES}`);
  const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(String(value))]));
  const label = Object.keys(matrix).length ? ` [${Object.values(matrix).join(", ")}]` : "";
  return { name: `${step.name}${label}`, cwd: join(ROOT, step["working-directory"] ?? "."), argv: ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], env: { ...env, RUNNER_TEMP: temp } };
}

/** The jobs a run plans: ci.yml's, without the classifier, the verdict and the advisory lanes. */
export function localJobs(workflow = WORKFLOW): string[] {
  return Object.keys(workflow.jobs).filter((job) => job !== "code_paths" && job !== "verify" && !ADVISORY_JOBS.includes(job));
}

/**
 * The run steps of a job that runs reached tests (or cast check) which this file neither models nor drops:
 * each needs an entry in REACHED_STEPS or DEFAULT_DROPS before a default run can leave it out knowingly.
 */
export function unmodeledSteps(workflow = WORKFLOW): string[] {
  const out: string[] = [];
  for (const job of localJobs(workflow)) {
    const modeled = job === "typecheck" ? CAST_CHECK_REPLACES : REACHED_STEPS[job] ? Object.keys(REACHED_STEPS[job]) : null;
    if (!modeled) continue;
    for (const step of workflow.jobs[job].steps) {
      if (step.run && !RUNNER_SETUP[step.name] && !modeled.includes(step.name) && !DEFAULT_DROPS[job]?.[step.name]) out.push(`${job} › ${step.name}`);
    }
  }
  return out;
}

const RUNNER_OS: Array<[RegExp, NodeJS.Platform]> = [[/^ubuntu|linux/, "linux"], [/^macos/, "darwin"], [/^windows/, "win32"]];
/** What in a step's script only its runner's OS has: a virtual display, the Debian package manager. */
const NEEDS_RUNNER_OS = /\b(xvfb-run|apt-get|apt)\b/;

/**
 * Why a job cannot be reproduced on this host, or null: its `runs-on` is another OS family and a step of its
 * own (not runner setup) leans on that OS. A job that only installs a tool there (tmux) runs here as it is.
 */
export function hostMismatch(job: string, platform: string = process.platform, workflow = WORKFLOW): string | null {
  const runsOn = String(workflow.jobs[job]["runs-on"] ?? "");
  const family = RUNNER_OS.find(([pattern]) => pattern.test(runsOn))?.[1];
  if (!family || family === platform) return null;
  const leans = workflow.jobs[job].steps.some((step: any) => step.run && !RUNNER_SETUP[step.name] && NEEDS_RUNNER_OS.test(step.run));
  return leans ? `CI runs it on ${runsOn}, not reproducible on ${platform}` : null;
}

/** What each CI job runs here for these changed paths, in ci.yml's order. */
export function planJobs(changed: string[], o: { base: string; full: boolean; temp: string; noTypecheck?: boolean }): Plan[] {
  const flags = scopeFlags(changed);
  return localJobs().map((job) => {
    const plan = planJob(job, changed, flags, o);
    // A step gets its job's timeout-minutes, as CI gives the whole job.
    const timeoutMs = Number(WORKFLOW.jobs[job]["timeout-minutes"]) * 60_000 || undefined;
    return { ...plan, steps: plan.steps.map((step) => ({ ...step, timeoutMs })) };
  });
}

function planJob(job: string, changed: string[], flags: Record<string, boolean>, o: { base: string; full: boolean; temp: string; noTypecheck?: boolean }): Plan {
  const plan: Plan = { job, steps: [], narrowed: [], wide: [] };
  const gate = jobGate(job);
  if (gate && !flags[gate]) return { ...plan, skip: "nothing it gates on changed" };
  const elsewhere = hostMismatch(job);
  if (elsewhere) return { ...plan, skip: elsewhere };
  if (job === "typecheck") {
    if (o.noTypecheck) return { ...plan, skip: "left to CI (--no-typecheck)" };
    const argv = ["cast", "check", ...(o.full ? TYPECHECK_PROJECTS : ["--changed-since", o.base]), "--json"];
    return { ...plan, steps: [{ name: argv.join(" "), cwd: ROOT, argv, typecheck: true }] };
  }
  const dropped: string[] = [];
  const entries = matrixOf(job);
  for (const step of WORKFLOW.jobs[job].steps) {
    if (!step.run || RUNNER_SETUP[step.name]) continue;
    // The matrix entries (runners) this step runs on; a step on several runs them side by side.
    const on = entries.map((matrix, i) => ({ matrix, i })).filter(({ matrix }) => stepRuns(step.if, flags, matrix, `${job} › ${step.name}`));
    if (on.length === 0) continue;
    const suite = o.full ? undefined : REACHED_STEPS[job]?.[step.name];
    if (suite) {
      const reached = reachedSteps(job, suite, changed, on.length);
      plan.steps.push(...reached.steps);
      if (reached.narrowed) plan.narrowed.push(reached.narrowed);
      if (reached.wide) plan.wide.push(`${suite} (${reached.wide})`);
    } else if (!o.full && DEFAULT_DROPS[job]?.[step.name]) {
      dropped.push(step.name);
    } else {
      for (const { matrix, i } of on) {
        const temp = entries.length > 1 ? join(o.temp, `${job}.${i + 1}`) : o.temp;
        plan.steps.push({ ...ciStep(job, step, temp, matrix), shard: on.length > 1 });
      }
    }
  }
  plan.files = plan.steps.reduce((n, step) => n + step.argv.filter((arg) => arg.startsWith("./")).length, 0) || undefined;
  if (plan.steps.length === 0) {
    const reasons = [REACHED_STEPS[job] && !o.full ? "no test file reaches a changed file" : "", dropped.length ? `--full only: ${dropped.join(", ")}` : ""];
    plan.skip = reasons.filter(Boolean).join("; ");
  }
  return plan;
}

// ── reading a step's output ─────────────────────────────────────────────────

const STAMP = "2000-01-01T00:00:00.0000000Z ";

/**
 * A step's output as the CI station reads a job log: the `##[group]Run` header, each line stamped (the
 * parser drops unstamped lines after an annotation), each test file header bun prints as a group, repo-relative,
 * and the runner's exit line. always-run-tests.ts prints `::group::<package dir>: N files` before each package.
 */
export function asJobLog(step: Pick<Step, "name" | "cwd">, output: string, code: number): string {
  let dir = step.cwd;
  const lines = output.split(/\r?\n/).map((line) => {
    const suite = /^::group::(packages\/\S+): \d+ files$/.exec(line);
    if (suite) dir = join(ROOT, suite[1]);
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    return STAMP + (header ? `##[group]${relative(ROOT, join(dir, header[1]))}:` : line);
  });
  return [`${STAMP}##[group]Run ${step.name}`, ...lines, ...(code === 0 ? [] : [`${STAMP}##[error]Process completed with exit code ${code}`])].join("\n");
}

/** The failures in one red step's output, with every file repo-relative. */
export function stepFailures(job: string, step: Pick<Step, "name" | "cwd">, output: string, code: number): CiFailure[] {
  return parseFailures(job, asJobLog(step, output, code)).map((failure) => ({
    ...failure,
    file: failure.file?.startsWith(`${ROOT}/`) ? relative(ROOT, failure.file) : failure.file,
  }));
}

/** A step this run could not judge: a hang, a timeout, a typecheck with no answer. It is the station's, not the change's. */
export function unjudged(job: string, what: string, why: string, output: string): CiFailure {
  return { job: "ci-station", test: `${job}: ${what}`, assertion: why, file: null, line: null, excerpt: output.split("\n").slice(-40).join("\n").slice(-4000) };
}

const TSC_ERROR = /^(\S+?\.[cm]?[jt]sx?)\((\d+),\d+\): error (TS\d+): (.*)$/;

/**
 * `cast check --json`'s answer per project: a type error is the change's (mobile's labeled local only, since
 * CI does not typecheck mobile), a project it could not check is the station's.
 */
export function typecheckFailures(results: Array<{ project: string; errors?: number; diagnostics?: string; error?: string }>): { failing: CiFailure[]; unjudged: CiFailure[] } {
  const failing: CiFailure[] = [];
  const station: CiFailure[] = [];
  for (const r of results) {
    if (r.error !== undefined) {
      station.push(unjudged("typecheck", r.project, r.error, r.error));
      continue;
    }
    if (!r.errors) continue;
    const dir = CHECK_PROJECTS[r.project] ? dirname(CHECK_PROJECTS[r.project]) : ".";
    const label = r.project === "mobile" ? "local only (CI doesn't typecheck mobile): " : "";
    const lines = (r.diagnostics ?? "").split("\n").map((line) => TSC_ERROR.exec(line.trim())).filter((m) => m !== null);
    for (const [text, file, line, code, message] of lines) {
      const path = relative(ROOT, join(ROOT, dir, file));
      failing.push({ job: "typecheck", test: `${label}${path}: ${code} ${message}`, assertion: `${code}: ${message}`, file: path, line: Number(line), excerpt: text });
    }
    if (lines.length === 0) failing.push({ job: "typecheck", test: `${label}${r.project}: ${r.errors} errors`, assertion: null, file: null, line: null, excerpt: r.diagnostics ?? "" });
  }
  return { failing, unjudged: station };
}

// ── running steps as a runner would ─────────────────────────────────────────

/**
 * PATH as a runner has it. CI installs no agent client, so the tests that drive a real one (the injection
 * matrix, the real-pane e2e cells) skip there; here they would drive the person's own clients. A PATH
 * directory holding a client is replaced by links to everything else in it.
 */
export function withoutAgentClients(path: string, into: string): string {
  const clients = new Set(Object.values(LOCAL_AGENT_CLIENTS).map((client) => client.binary));
  return path
    .split(":")
    .map((dir, i) => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return dir;
      }
      if (!entries.some((entry) => clients.has(entry))) return dir;
      const shadow = join(into, String(i));
      rmSync(shadow, { recursive: true, force: true });
      mkdirSync(shadow, { recursive: true });
      for (const entry of entries) if (!clients.has(entry)) symlinkSync(join(dir, entry), join(shadow, entry));
      return shadow;
    })
    .join(":");
}

/**
 * What an agent session or a terminal multiplexer sets, and a runner never has: the cli tests that spawn the
 * CLI read them (a launch token, a session id) and fail where CI passes.
 */
const SESSION_ENV = /^(CLAUDE|CODECAST|CODEX|AI_AGENT|TMUX)/;

/**
 * The environment of a step as a runner gives it: CI=true, no session variables, PATH without agent clients,
 * and TMUX_TMPDIR in the run's own directory, so a bare `tmux` (ci.yml's `tmux kill-server`) finds the run's
 * server and never the person's.
 */
export function runnerEnv(env: Record<string, string | undefined>, runDir: string): Record<string, string | undefined> {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_ENV.test(key)));
  const tmux = join(runDir, "tmux");
  mkdirSync(tmux, { recursive: true, mode: 0o700 });
  return { ...out, CI: "true", PATH: withoutAgentClients(env.PATH ?? "", join(runDir, "path")), TMUX_TMPDIR: tmux };
}

/** Every process under these, children first found. */
function descendants(roots: number[]): number[] {
  const table = Bun.spawnSync(["ps", "-Ao", "pid=,ppid="]).stdout.toString();
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [...roots];
  while (queue.length) for (const child of children.get(queue.shift()!) ?? []) out.push(child), queue.push(child);
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Stop a process and everything under it: TERM, then KILL whatever is left after five seconds. */
async function stopTree(pid: number): Promise<void> {
  const all = [pid, ...descendants([pid])];
  for (const p of all) try { process.kill(p, "SIGTERM"); } catch {}
  for (let i = 0; i < 50 && all.some(alive); i++) await Bun.sleep(100);
  for (const p of all.filter(alive)) try { process.kill(p, "SIGKILL"); } catch {}
}

/** Where the cli suite's preload puts each test process's private tmux server (isolatedTmuxServer.ts). */
// Steps run without CODECAST_DIR (runnerEnv), so it is HOME's.
const TEST_TMUX_BASES = [join(process.env.HOME || homedir(), ".codecast", "test-tmux"), "/tmp/codecast-test-tmux"];
const uid = process.getuid?.() ?? 0;
const killServer = (socket: string, env: Record<string, string | undefined>) =>
  Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore", timeout: 5000 });

/**
 * Kill the run's tmux servers: every one under its TMUX_TMPDIR, and each test process's private server
 * (`run-<pid>` under isolatedTmuxServer.ts's bases) that appeared during the run and whose process is gone,
 * the way that file's sweepDeadServers reaps a killed run's.
 */
export function sweepTmux(runTmux: string, before: Set<string>, env: Record<string, string | undefined>): number {
  let killed = 0;
  const sockets = join(runTmux, `tmux-${uid}`);
  for (const name of existsSync(sockets) ? readdirSync(sockets) : []) killServer(join(sockets, name), env), killed++;
  for (const base of TEST_TMUX_BASES) {
    for (const name of existsSync(base) ? readdirSync(base) : []) {
      const pid = Number(/^run-(\d+)(?:-|$)/.exec(name)?.[1]);
      if (!pid || before.has(join(base, name)) || alive(pid)) continue;
      killServer(join(base, name, `tmux-${uid}`, "default"), env);
      rmSync(join(base, name), { recursive: true, force: true });
      killed++;
    }
  }
  return killed;
}

/** The private-server directories that exist before the run starts: never the run's to sweep. */
const testTmuxDirs = () => new Set(TEST_TMUX_BASES.flatMap((base) => (existsSync(base) ? readdirSync(base).map((name) => join(base, name)) : [])));

const live = new Set<Bun.Subprocess>();
/** The person's environment, with CI's bun first on PATH once ciBun() found it: what cast check runs in. */
const ownEnv: Record<string, string | undefined> = { ...process.env };
let stepEnv: Record<string, string | undefined> = ownEnv;
/** When --budget stops the run (epoch ms), or 0 for no budget. */
let deadline = 0;
const pastBudget = (graceMs = 0) => deadline > 0 && Date.now() > deadline + graceMs;
/** The re-runs of failing files alone may use this much past the budget: under load the budget is what runs out first. */
const RERUN_GRACE_MS = 5 * 60_000;
/** A run still going this long past its budget (a hang outside any step) ends with no verdict. */
const HARD_STOP_MS = 8 * 60_000;

/** One step, its output written to its own log file (cast check's JSON answer to a second one). */
async function runStep(step: Step, log: string): Promise<{ code: number; output: string; stdout: string; stopped: string | null }> {
  if (step.env?.RUNNER_TEMP) mkdirSync(step.env.RUNNER_TEMP, { recursive: true });
  const fd = openSync(log, "w");
  const out = step.typecheck ? openSync(`${log}.json`, "w") : fd;
  const proc = Bun.spawn(step.argv, { cwd: step.cwd, env: { ...(step.typecheck ? ownEnv : stepEnv), ...step.env }, stdin: "ignore", stdout: out, stderr: fd });
  live.add(proc);
  const began = Date.now();
  let size = 0;
  let still = began;
  let stopped: string | null = null;
  const watch = setInterval(() => {
    const now = statSync(log).size;
    if (now !== size) [size, still] = [now, Date.now()];
    if (stopped) return;
    if (!step.typecheck && Date.now() - still > QUIET_MS) stopped = `no output for ${QUIET_MS / 1000}s: stopped as hung`;
    else if (step.timeoutMs && Date.now() - began > step.timeoutMs) stopped = `ran past the job's ${step.timeoutMs / 60_000} minute timeout: stopped`;
    else if (pastBudget(step.graceMs)) stopped = "ran past the run's --budget: stopped";
    if (stopped) void stopTree(proc.pid);
  }, 5000);
  const code = await proc.exited;
  live.delete(proc);
  clearInterval(watch);
  if (stopped) writeSync(fd, `\nerror: ${stopped}\n`);
  closeSync(fd);
  if (out !== fd) closeSync(out);
  return { code, output: readFileSync(log, "utf8"), stdout: step.typecheck ? readFileSync(`${log}.json`, "utf8") : "", stopped };
}

type Verdict = { failing: CiFailure[]; unjudged: CiFailure[] };

/** A step to its verdict: cast check is asked again while it has none. */
async function judgeStep(job: string, step: Step, log: string): Promise<Verdict> {
  let r = await runStep(step, log);
  if (r.stopped) return { failing: [], unjudged: [unjudged(job, step.name, r.stopped, r.output)] };
  if (!step.typecheck) return { failing: r.code === 0 ? [] : stepFailures(job, step, r.output, r.code), unjudged: [] };
  for (let ask = 0; CHECK_ASK_AGAIN.has(r.code) && ask < 2; ask++) {
    console.log(`  ${job}: no verdict (exit ${r.code}), asking again`);
    r = await runStep(step, log);
  }
  if (r.code === CHECK_STALE) {
    console.log(`  ${job}: a stale answer (exit ${r.code}), asking again with --fresh`);
    r = await runStep({ ...step, argv: [...step.argv, "--fresh"] }, log);
  }
  let results: any[] = [];
  try {
    results = JSON.parse(r.stdout);
  } catch {}
  const verdict = typecheckFailures(Array.isArray(results) ? results : []);
  if (r.code !== 0 && verdict.failing.length === 0 && verdict.unjudged.length === 0) {
    const why = r.code === 1 ? "cast check failed without naming an error" : `cast check exited ${r.code} with no verdict`;
    verdict.unjudged.push(unjudged(job, step.name, why, r.output));
  }
  return verdict;
}

async function runPlan(plan: Plan, logDir: string): Promise<{ result: JobResult } & Verdict> {
  if (plan.skip) return { result: { job: plan.job, status: "skipped", seconds: 0, reason: plan.skip }, failing: [], unjudged: [] };
  const started = performance.now();
  const verdict: Verdict = { failing: [], unjudged: [] };
  for (let i = 0; i < plan.steps.length; ) {
    if (pastBudget()) {
      verdict.unjudged.push(unjudged(plan.job, `${plan.steps.length - i} steps`, "not run: past the run's --budget", ""));
      break;
    }
    let end = i + 1;
    if (plan.steps[i].shard) while (end < plan.steps.length && end - i < SHARDS && plan.steps[end].shard && plan.steps[end].cwd === plan.steps[i].cwd) end++;
    const batch = plan.steps.slice(i, end).map((step, k) => {
      console.log(`  ${plan.job}: ${step.name}`);
      return judgeStep(plan.job, step, join(logDir, `${plan.job}.${i + k + 1}.log`));
    });
    for (const v of await Promise.all(batch)) verdict.failing.push(...v.failing), verdict.unjudged.push(...v.unjudged);
    i = end;
  }
  const seconds = Math.round((performance.now() - started) / 1000);
  const logs = `logs ${join(logDir, `${plan.job}.*.log`)}`;
  const status = verdict.failing.length ? "fail" : verdict.unjudged.length ? "no verdict" : "pass";
  const counts = [verdict.failing.length && `${verdict.failing.length} failing`, verdict.unjudged.length && `${verdict.unjudged.length} not judged`].filter(Boolean).join(", ");
  const reason = counts ? `${counts}, ${logs}` : plan.files ? `${plan.files} test files${plan.wide.length ? `, whole suite: ${plan.wide.join(", ")}` : ""}` : undefined;
  return { result: { job: plan.job, status, seconds, reason }, ...verdict };
}

/**
 * The bun CI pins (setup-bun's default), fetched once into bun's cache by `bunx` and linked as `bun` into this
 * run's directory. Every step runs on it: suites behave differently across bun versions (bun 1.3.14 under
 * --isolate hands later web files the first file's mocked modules). dir is null when this bun is that one or
 * it cannot be fetched.
 */
function ciBun(runDir: string): { version: string; dir: string | null } | null {
  const action = readFileSync(join(ROOT, ".github/actions/setup-bun/action.yml"), "utf8");
  const version = /bun-version:[\s\S]*?default:\s*"([^"]+)"/.exec(action)?.[1];
  if (!version) return null;
  if (version === Bun.version) return { version, dir: null };
  const probe = Bun.spawnSync(["bunx", `bun@${version}`, "-e", "console.log(process.execPath)"], { cwd: tmpdir(), timeout: 180_000 });
  const binary = probe.stdout.toString().trim().split("\n").at(-1);
  if (probe.exitCode !== 0 || !binary?.startsWith("/")) return { version, dir: null };
  // bunx installs it as bun.exe; PATH needs it named bun.
  const dir = join(runDir, "bun");
  mkdirSync(dir, { recursive: true });
  symlinkSync(binary, join(dir, "bun"));
  return { version, dir };
}

/** The node major ci.yml's setup-node steps pin, when it differs from this machine's. */
function nodeMismatch(): string | null {
  const pins = new Set<string>();
  for (const job of Object.values<any>(WORKFLOW.jobs)) for (const step of job.steps) if (String(step.uses ?? "").startsWith("actions/setup-node")) pins.add(String(step.with?.["node-version"]));
  const local = Bun.spawnSync(["node", "--version"]).stdout.toString().trim().replace(/^v/, "");
  const differ = [...pins].filter((pin) => local.split(".")[0] !== pin.split(".")[0]);
  return differ.length ? `CI runs node ${differ.join(", ")} for test-mobile and test-electron; this is node ${local || "(none)"}` : null;
}

function argValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

async function main(): Promise<never> {
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const list = args.includes("--list");
  const json = argValue(args, "--json");
  const noTypecheck = args.includes("--no-typecheck");
  const budget = Number(argValue(args, "--budget") ?? 0);
  const base = argValue(args, "--base") ?? git(["merge-base", "origin/main", "HEAD"]).trim();
  const started = performance.now();
  if (budget > 0) {
    deadline = Date.now() + budget * 60_000;
    const stop = () => Promise.all([...live].map((proc) => stopTree(proc.pid))).then(() => process.exit(2));
    setTimeout(() => (console.log(`no verdict: still running ${HARD_STOP_MS / 60_000} minutes past the --budget`), stop()), budget * 60_000 + HARD_STOP_MS);
  }
  const changed = changedPaths(base, args.includes("--committed"));
  const scope = classifyChangedPaths(changed);
  const logDir = list ? join(tmpdir(), "ci-local") : mkdtempSync(join(tmpdir(), "ci-local-"));
  const plans = planJobs(changed, { base, full, temp: logDir, noTypecheck });
  const narrowed = plans.flatMap((plan) => plan.narrowed);
  console.log(`${changed.length} paths changed since ${base.slice(0, 9)}${scope.forcedBy.length ? `; every job runs, unclassified: ${scope.forcedBy.slice(0, 5).join(", ")}` : ""}`);
  for (const n of narrowed) console.log(`narrowed: ${n.suite} runs ${n.selected} of the ${n.total} test files the change reaches (hub files' deeper importers wait for --full)`);

  if (list) {
    for (const plan of plans) {
      console.log(plan.skip ? `${plan.job}: skipped, ${plan.skip}` : `${plan.job}:`);
      for (const step of plan.steps) console.log(`  ${step.name}`);
    }
    process.exit(0);
  }

  const pinned = ciBun(logDir);
  if (pinned?.dir) {
    ownEnv.PATH = `${pinned.dir}:${process.env.PATH}`;
    console.log(`steps run on bun ${pinned.version}, as CI does (this is bun ${Bun.version})`);
  } else if (pinned && pinned.version !== Bun.version) {
    console.log(`warning: CI runs bun ${pinned.version}, which could not be fetched; steps run on bun ${Bun.version}`);
  }
  const node = nodeMismatch();
  if (node) console.log(`note: ${node}`);
  stepEnv = runnerEnv(ownEnv, logDir);
  const before = testTmuxDirs();
  const sweep = () => sweepTmux(stepEnv.TMUX_TMPDIR!, before, stepEnv);

  // Stopping the run stops everything it started, its tmux servers included.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      await Promise.all([...live].map((proc) => stopTree(proc.pid)));
      sweep();
      process.exit(130);
    });
  }

  const results: JobResult[] = [];
  const red: CiFailure[] = [];
  const station: CiFailure[] = [];
  for (const plan of plans) {
    if (!plan.skip && pastBudget()) {
      plan.skip = `past the run's ${budget} minute --budget`;
      station.push(unjudged(plan.job, "the job", `not run: ${plan.skip}`, ""));
    }
    if (!plan.skip) console.log(`${plan.job}...`);
    const run = await runPlan(plan, logDir);
    results.push(run.result);
    red.push(...run.failing);
    station.push(...run.unjudged);
  }
  const { failing, flaky, unjudged: cutOff } = await sortFlaky(red, async (file) => {
    const { dir, rel } = suiteOf(ROOT, file);
    console.log(`again alone: ${file}`);
    const r = await runStep({ name: `${file} alone`, cwd: dir, argv: ["bun", "test", `./${rel}`], timeoutMs: 120_000, graceMs: RERUN_GRACE_MS }, join(logDir, `alone.${rel.replaceAll("/", "_")}.log`));
    return r.stopped ? "stopped" : r.code === 0 ? "pass" : "fail";
  }, () => !pastBudget(RERUN_GRACE_MS));
  station.push(...cutOff);
  results.splice(0, results.length, ...settledJobs(results, { failing, flaky, unjudged: station }));
  sweep();

  for (const f of [...failing, ...station]) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}${f.test ? ` ${f.test}` : ""}` : (f.test ?? f.assertion ?? "a step failed without naming a test");
    console.log(`\n${f.job} ✗ ${where}${f.job === "ci-station" && f.assertion ? `: ${f.assertion}` : ""}`);
    console.log(f.excerpt.split("\n").slice(-12).map((line) => `    ${line}`).join("\n"));
  }
  const green = failing.length === 0 && station.length === 0;
  if (json) {
    const head_sha = git(["rev-parse", "HEAD"]).trim();
    const dirty = git(["status", "--porcelain"]).trim().length > 0;
    writeFileSync(json, `${JSON.stringify({ green, head_sha, dirty, failing: [...failing, ...station], flaky, narrowed, jobs: results }, null, 2)}\n`);
  }
  console.log("");
  for (const r of results) console.log(`${r.job.padEnd(14)} ${r.status.padEnd(10)} ${String(r.seconds).padStart(4)}s${r.reason ? `  ${r.reason}` : ""}`);
  for (const file of new Set(flaky.map((f) => f.file))) console.log(`flaky under load: ${file} failed in the run and passed alone`);
  for (const n of narrowed) console.log(`narrowed: ${n.suite} ran ${n.selected} of ${n.total} reached test files; --full runs the rest`);
  const verdict = failing.length ? "red" : station.length ? "no verdict" : "green";
  console.log(`${verdict} in ${Math.round((performance.now() - started) / 1000)}s; logs in ${logDir}`);
  process.exit(failing.length ? 1 : station.length ? 2 : 0);
}

// A crash is this script's failure, never the change's: no verdict, so the change flow's Local CI lets CI judge it.
if (import.meta.main) {
  main().catch((err) => {
    console.log(`no verdict: local.ts crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(2);
  });
}
