#!/usr/bin/env bun
// CI's own checks, run on this machine for what a branch changed, so a change
// gets past CI on its first push (ct-102059).
//
// The changed paths are the diff from the merge base with origin/main (or
// --base), uncommitted and untracked files included. changed-path-scope.ts
// classifies them exactly as ci.yml classifies a pull request, so the same
// jobs gate on. By default each gated job runs its cheap part:
// - ci-contract, test-always, lint, test-electron, test-platform: their ci.yml
//   steps, as CI runs them.
// - typecheck: `cast check --changed-since <base>`, never a bare tsc.
// - each package test job: the test files that are changed, that import a
//   changed file (test-reach.ts's import graph; only directly, for a hub
//   file), or that walk their own package's tree off disk while that package
//   changed, from the package's directory with the job's flags. test-always
//   already ran the job's guards, ratchets and crossing tests.
// - build: only with --full.
// --full runs every gated job's ci.yml steps instead (typecheck still through
// cast check).
//
// Steps run as on a runner: on the bun CI pins (fetched once with bunx), with
// CI=true, and with no agent client on PATH and no agent session's variables
// (cast check keeps the person's own environment). Jobs run one after another: the
// laptop runs out of memory running them at once. Within a job a one-process
// suite is cut into up to four shards that run together, as CI shards web.
// Each step's output goes to a log file rather than a pipe (quiet-watchdog.sh
// says why), and is read the way the change flow's CI station reads a red
// job's log (shared/contracts/ciFailures.ts). The run ends with one line per
// job and exits 1 on any failure; --json <path> writes {green, failing, jobs}.
// --list prints the plan without running it.
//
//   bun scripts/ci/local.ts [--base <ref>] [--full] [--json <path>] [--list]

import { closeSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { LOCAL_AGENT_CLIENTS } from "../../packages/shared/contracts/agentClients";
import { parseFailures, type CiFailure } from "../../packages/shared/contracts/ciFailures";
import { alwaysRunFiles, SUITES } from "./always-run-tests";
import { ADVISORY_JOBS, classifyChangedPaths, computerScope, injectionScope } from "./changed-path-scope";
import { importClosure, jobTestFiles } from "./test-reach";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW = Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as any;

/** Steps that set up a runner, not the code: a laptop has its own tmux and needs no Linux sandbox switch. */
const RUNNER_SETUP = /^(Install tmux|Allow the Electron sandbox)/;
/** CI's typecheck job runs a bare tsc per package; here typecheck goes through `cast check`, whose programs are the same. */
const TYPECHECK_PROJECTS = ["cli", "web", "sim", "convex", "evals", "playground"];
/** `cast check` exits where it has no verdict: a watcher that died or answered stale is restarted with --fresh; a pass that outlived the wait keeps running, so the same ask picks it up. */
const CHECK_RESTART = new Set([70, 75]);
const CHECK_STILL_RUNNING = 124;
/** Files per `bun test` process: an isolated file's global lives until its process exits. */
const CHUNK = 300;
/**
 * A suite that runs in one process (every one but --parallel's) is cut into up to this many shards that
 * run at once, as CI cuts test-web into shards: one process uses one core. Jobs still run one at a time.
 */
const SHARDS = 4;
/** Below this many files a second process costs more than it saves. */
const MIN_SHARD = 50;
/** Output standing still this long is a hung run, as in quiet-watchdog.sh. */
const QUIET_MS = 240_000;

/**
 * `typecheck` marks cast check's step: it waits on its own watcher and says when it has no verdict, so no quiet
 * watchdog stops it. Consecutive `shard` steps run at once.
 */
export type Step = { name: string; cwd: string; argv: string[]; env?: Record<string, string>; typecheck?: boolean; shard?: boolean; timeoutMs?: number };
export type Plan = { job: string; skip?: string; steps: Step[]; files?: number };
export type JobResult = { job: string; status: "pass" | "fail" | "skipped"; seconds: number; reason?: string };

function git(args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

/** Every path changed since base: committed, staged, unstaged and untracked. */
export function changedPaths(base: string): string[] {
  const lines = [...git(["diff", "--name-only", "--no-renames", base]).split("\n"), ...git(["ls-files", "--others", "--exclude-standard"]).split("\n")];
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))].sort();
}

/** ci.yml's code_paths outputs for these paths. */
export function scopeFlags(changed: string[]): Record<string, boolean> {
  return { ...classifyChangedPaths(changed).flags, run_test_injection: injectionScope(changed), run_test_computer: computerScope(changed) };
}

const WALKS_TREE = /\b(readdirSync|readdir|Bun\.Glob|new Glob|globSync|scanSync)\b/;
const OWN_DIR = /import\.meta\.(dir|dirname|url)\b|__dirname|process\.cwd\(\)/;

/** A test that lists files under its own directory (a source scan): no import says which change can break it. */
export function walksOwnTree(text: string): boolean {
  return WALKS_TREE.test(text) && OWN_DIR.test(text);
}

const packageOf = (file: string) => file.split("/").slice(0, 2).join("/");

/**
 * A changed file this share of a suite's tests reach is a hub (a schema, the store, a shared contract): by
 * default only the tests that import it directly run for it, and --full runs the rest. Without this a change
 * to one hub selects most of the suite (1,118 of web's 1,564 files for PR #227).
 */
export const HUB_SHARE = 0.25;

/**
 * The tests (repo-relative) a change reaches: changed, importing a changed file (directly, for a hub), or
 * scanning a package that changed. `closureOf` gives each file a test imports with its import distance.
 */
export function selectTests(tests: string[], changed: string[], closureOf: (test: string) => Map<string, number>, walks: (test: string) => boolean): string[] {
  const files = new Set(changed);
  const packages = new Set(changed.map(packageOf));
  const closures = tests.map((test) => [...closureOf(test)].filter(([file, hops]) => hops > 0 && files.has(file)));
  const reach = new Map<string, number>();
  for (const closure of closures) for (const [file] of closure) reach.set(file, (reach.get(file) ?? 0) + 1);
  const hub = (file: string) => reach.get(file)! > HUB_SHARE * tests.length;
  return tests.filter((test, i) => {
    if (files.has(test) || (packages.has(packageOf(test)) && walks(test))) return true;
    return closures[i].some(([file, hops]) => hops === 1 || !hub(file));
  });
}

const repoClosure = (test: string) => new Map([...importClosure(join(ROOT, test))].map(([file, hops]) => [relative(ROOT, file), hops]));
const repoWalks = (test: string) => walksOwnTree(readFileSync(join(ROOT, test), "utf8"));

/** A gated job's flag, read from its `if:` in ci.yml; null for an ungated job. */
function jobGate(job: string): string | null {
  const cond = WORKFLOW.jobs[job].if;
  if (cond === undefined) return null;
  const flag = /^needs\.code_paths\.outputs\.(\w+) == 'true'$/.exec(String(cond).trim());
  if (!flag) throw new Error(`ci.yml ${job}: no local reading of its if: ${cond}`);
  return flag[1];
}

function stepRuns(cond: unknown, flags: Record<string, boolean>, where: string): boolean {
  if (cond === undefined) return true;
  const text = String(cond).replace(/^\$\{\{\s*|\s*\}\}$/g, "").trim();
  const flag = /^needs\.code_paths\.outputs\.(\w+) == 'true'$/.exec(text);
  if (flag) return flags[flag[1]] === true;
  if (text === "!cancelled()") return true;
  if (text === "failure()") return false;
  throw new Error(`ci.yml ${where}: no local reading of its if: ${cond}`);
}

/** A job's run steps as ci.yml writes them, under GitHub's default bash, without the runner's own setup. */
export function ciSteps(job: string, flags: Record<string, boolean>, temp: string): Step[] {
  const steps: Step[] = [];
  for (const step of WORKFLOW.jobs[job].steps) {
    const where = `${job} › ${step.name ?? step.uses}`;
    if (!step.run || RUNNER_SETUP.test(step.name ?? "") || !stepRuns(step.if, flags, where)) continue;
    const expand = (text: string) => {
      const out = text.replaceAll("${{ runner.temp }}", temp);
      const left = /\$\{\{[^}]*\}\}/.exec(out);
      if (left) throw new Error(`ci.yml ${where}: no local value for ${left[0]}`);
      return out;
    };
    // macOS draws Electron without a virtual display.
    const run = process.platform === "linux" ? expand(step.run) : expand(step.run).replace(/^xvfb-run -a /m, "");
    const env = Object.fromEntries(Object.entries(step.env ?? {}).map(([key, value]) => [key, expand(String(value))]));
    steps.push({ name: step.name, cwd: join(ROOT, step["working-directory"] ?? "."), argv: ["bash", "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", run], env });
  }
  return steps;
}

/** The reached test files of a package job, one `bun test` per chunk, from each package directory with its job's flags. */
function reachedSteps(job: string, changed: string[]): Step[] {
  const steps: Step[] = [];
  for (const suite of SUITES.filter((s) => s.job === job)) {
    const roots = suite.roots.map((root) => `${join(suite.dir, root)}/`);
    const always = new Set(alwaysRunFiles(suite).map((file) => join(suite.dir, file)));
    const tests = jobTestFiles(job)
      .map((file) => relative(ROOT, file))
      .filter((file) => roots.some((root) => file.startsWith(root)) && !always.has(file));
    const picked = selectTests(tests, changed, repoClosure, repoWalks).map((file) => `./${relative(suite.dir, file)}`);
    const shard = !suite.flags.includes("--parallel");
    const shards = Math.min(SHARDS, Math.ceil(picked.length / MIN_SHARD));
    const size = shard ? Math.min(CHUNK, Math.ceil(picked.length / shards)) : CHUNK;
    for (let i = 0; i < picked.length; i += size) {
      const files = picked.slice(i, i + size);
      const part = picked.length > size ? ` part ${i / size + 1}` : "";
      const name = `bun test ${suite.flags.join(" ")} in ${suite.dir}: ${files.length} reached files${part}`.replace("  ", " ");
      steps.push({ name, cwd: join(ROOT, suite.dir), argv: ["bun", "test", ...suite.flags, ...files], shard });
    }
  }
  return steps;
}

/** What each CI job runs here for these changed paths, in ci.yml's order. */
export function planJobs(changed: string[], o: { base: string; full: boolean; temp: string }): Plan[] {
  const flags = scopeFlags(changed);
  const jobs = Object.keys(WORKFLOW.jobs).filter((job) => job !== "code_paths" && job !== "verify" && !ADVISORY_JOBS.includes(job));
  return jobs.map((job) => {
    const plan = planJob(job, changed, flags, o);
    // A step gets its job's timeout-minutes, as CI gives the whole job.
    const timeoutMs = Number(WORKFLOW.jobs[job]["timeout-minutes"]) * 60_000 || undefined;
    return { ...plan, steps: plan.steps.map((step) => ({ ...step, timeoutMs })) };
  });
}

function planJob(job: string, changed: string[], flags: Record<string, boolean>, o: { base: string; full: boolean; temp: string }): Plan {
  const gate = jobGate(job);
  if (gate && !flags[gate]) return { job, skip: "nothing it gates on changed", steps: [] };
  if (job === "typecheck") {
    const argv = o.full ? ["cast", "check", ...TYPECHECK_PROJECTS] : ["cast", "check", "--changed-since", o.base];
    return { job, steps: [{ name: argv.join(" "), cwd: ROOT, argv, typecheck: true }] };
  }
  if (o.full) return { job, steps: ciSteps(job, flags, o.temp) };
  if (job === "build") return { job, skip: "--full only", steps: [] };
  if (SUITES.some((suite) => suite.job === job)) {
    const steps = reachedSteps(job, changed);
    const files = steps.reduce((n, step) => n + step.argv.filter((arg) => arg.startsWith("./")).length, 0);
    return steps.length ? { job, steps, files } : { job, skip: "no test file reaches a changed file", steps: [] };
  }
  return { job, steps: ciSteps(job, flags, o.temp) };
}

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

/** The environment of a step as a runner gives it: CI=true, no session variables, PATH without agent clients. */
export function runnerEnv(env: Record<string, string | undefined>, into: string): Record<string, string | undefined> {
  const out = Object.fromEntries(Object.entries(env).filter(([key]) => !SESSION_ENV.test(key)));
  return { ...out, CI: "true", PATH: withoutAgentClients(env.PATH ?? "", into) };
}

const live = new Set<Bun.Subprocess>();
/** The environment steps run in, with CI's bun first on PATH once ciBun() found it. cast check keeps the person's own. */
const ownEnv: Record<string, string | undefined> = { ...process.env };
let stepEnv: Record<string, string | undefined> = ownEnv;

function stop(proc: Bun.Subprocess) {
  Bun.spawnSync(["pkill", "-TERM", "-P", String(proc.pid)]);
  proc.kill();
}

/** One step, its output written to its own log file. */
async function runStep(step: Step, log: string): Promise<{ code: number; output: string }> {
  const fd = openSync(log, "w");
  const proc = Bun.spawn(step.argv, { cwd: step.cwd, env: { ...(step.typecheck ? ownEnv : stepEnv), ...step.env }, stdin: "ignore", stdout: fd, stderr: fd });
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
    if (stopped) stop(proc);
  }, 5000);
  let code = await proc.exited;
  live.delete(proc);
  clearInterval(watch);
  if (stopped) {
    writeSync(fd, `\nerror: ${stopped}\n`);
    code = 124;
  }
  closeSync(fd);
  return { code, output: readFileSync(log, "utf8") };
}

/** A step to its verdict: cast check is asked again while it has none. */
async function judgeStep(job: string, step: Step, log: string): Promise<CiFailure[]> {
  let { code, output } = await runStep(step, log);
  for (let ask = 0; step.typecheck && code === CHECK_STILL_RUNNING && ask < 2; ask++) {
    console.log(`  ${job}: the pass outlived cast check's wait, asking again`);
    ({ code, output } = await runStep(step, log));
  }
  if (step.typecheck && CHECK_RESTART.has(code)) {
    console.log(`  ${job}: no verdict (exit ${code}), asking again with --fresh`);
    ({ code, output } = await runStep({ ...step, argv: [...step.argv, "--fresh"] }, log));
  }
  return code === 0 ? [] : stepFailures(job, step, output, code);
}

async function runPlan(plan: Plan, logDir: string): Promise<{ result: JobResult; failing: CiFailure[] }> {
  if (plan.skip) return { result: { job: plan.job, status: "skipped", seconds: 0, reason: plan.skip }, failing: [] };
  const started = performance.now();
  const failing: CiFailure[] = [];
  for (let i = 0; i < plan.steps.length; ) {
    let end = i + 1;
    if (plan.steps[i].shard) while (end < plan.steps.length && end - i < SHARDS && plan.steps[end].shard && plan.steps[end].cwd === plan.steps[i].cwd) end++;
    const batch = plan.steps.slice(i, end).map((step, k) => {
      console.log(`  ${plan.job}: ${step.name}`);
      return judgeStep(plan.job, step, join(logDir, `${plan.job}.${i + k + 1}.log`));
    });
    for (const failures of await Promise.all(batch)) failing.push(...failures);
    i = end;
  }
  const seconds = Math.round((performance.now() - started) / 1000);
  const reason = failing.length ? `${failing.length} failing, logs ${join(logDir, `${plan.job}.*.log`)}` : plan.files ? `${plan.files} reached test files` : undefined;
  return { result: { job: plan.job, status: failing.length ? "fail" : "pass", seconds, reason }, failing };
}

/**
 * The directory holding the bun CI pins (setup-bun's default), fetched once into bun's cache by `bunx`, or null
 * when this bun is that one or it cannot be fetched. Every step runs on it: the suites behave differently across
 * bun versions (bun 1.3.14 under --isolate hands later web files the first file's mocked modules).
 */
function ciBun(): { version: string; dir: string | null } | null {
  const action = readFileSync(join(ROOT, ".github/actions/setup-bun/action.yml"), "utf8");
  const version = /bun-version:[\s\S]*?default:\s*"([^"]+)"/.exec(action)?.[1];
  if (!version) return null;
  if (version === Bun.version) return { version, dir: null };
  const probe = Bun.spawnSync(["bunx", `bun@${version}`, "-e", "console.log(process.execPath)"], { cwd: tmpdir() });
  const binary = probe.stdout.toString().trim().split("\n").at(-1);
  if (probe.exitCode !== 0 || !binary?.startsWith("/")) return { version, dir: null };
  // bunx installs it as bun.exe; PATH needs it named bun.
  const dir = join(tmpdir(), `ci-local-bun-${version}`);
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "bun"), { force: true });
  symlinkSync(binary, join(dir, "bun"));
  return { version, dir };
}

function argValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`);
  return value;
}

if (import.meta.main) {
  // Stopping the run stops the tests it started.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      for (const proc of live) stop(proc);
      process.exit(130);
    });
  }
  const args = process.argv.slice(2);
  const full = args.includes("--full");
  const json = argValue(args, "--json");
  const base = argValue(args, "--base") ?? git(["merge-base", "origin/main", "HEAD"]).trim();
  const started = performance.now();
  const changed = changedPaths(base);
  const scope = classifyChangedPaths(changed);
  const list = args.includes("--list");
  const logDir = list ? join(tmpdir(), "ci-local") : mkdtempSync(join(tmpdir(), "ci-local-"));
  const plans = planJobs(changed, { base, full, temp: logDir });
  console.log(`${changed.length} paths changed since ${base.slice(0, 9)}${scope.forcedBy.length ? `; every job runs, unclassified: ${scope.forcedBy.slice(0, 5).join(", ")}` : ""}`);
  const pinned = list ? null : ciBun();
  if (pinned?.dir) {
    ownEnv.PATH = `${pinned.dir}:${process.env.PATH}`;
    console.log(`steps run on bun ${pinned.version}, as CI does (this is bun ${Bun.version})`);
  } else if (pinned && pinned.version !== Bun.version) {
    console.log(`warning: CI runs bun ${pinned.version}, which could not be fetched; steps run on bun ${Bun.version}`);
  }
  if (!list) stepEnv = runnerEnv(ownEnv, join(logDir, "path"));

  if (list) {
    for (const plan of plans) {
      console.log(plan.skip ? `${plan.job}: skipped, ${plan.skip}` : `${plan.job}:`);
      for (const step of plan.steps) console.log(`  ${step.name}`);
    }
    process.exit(0);
  }

  const results: JobResult[] = [];
  const failing: CiFailure[] = [];
  for (const plan of plans) {
    if (!plan.skip) console.log(`${plan.job}...`);
    const run = await runPlan(plan, logDir);
    results.push(run.result);
    failing.push(...run.failing);
  }

  for (const f of failing) {
    const where = f.file ? `${f.file}${f.line ? `:${f.line}` : ""}${f.test ? ` ${f.test}` : ""}` : (f.assertion ?? "a step failed without naming a test");
    console.log(`\n${f.job} ✗ ${where}`);
    console.log(f.excerpt.split("\n").slice(-12).map((line) => `    ${line}`).join("\n"));
  }
  const green = failing.length === 0;
  if (json) writeFileSync(json, `${JSON.stringify({ green, failing, jobs: results }, null, 2)}\n`);
  console.log("");
  for (const r of results) console.log(`${r.job.padEnd(14)} ${r.status.padEnd(8)} ${String(r.seconds).padStart(4)}s${r.reason ? `  ${r.reason}` : ""}`);
  console.log(`${green ? "green" : "red"} in ${Math.round((performance.now() - started) / 1000)}s; logs in ${logDir}`);
  process.exit(green ? 0 : 1);
}
