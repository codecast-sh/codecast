// `cast env`: the environments this repo declares (`.codecast/envs.toml`,
// envDeclaration.ts), run against a candidate and filed as attempts
// (convex/envs.ts); and `cast goal envs`, the levels a goal names. The
// line's eval station calls `cast env eval --task` to run the task's goal's
// L0..L2 envs on the base and the branch and report the paired delta.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "./proc.js";
import { randomUUID } from "node:crypto";
import type { Command } from "commander";
import {
  ENV_LEVEL_NAME,
  deltaPhrase,
  compactCasePages,
  heldCaseId,
  normalizeGoalEnvs,
  pairedDelta,
  parseEnvResult,
  parseGoalEnvSpec,
  standingCost,
  standingLink,
  standingNoise,
  standingScore,
  type EnvCase,
  type EnvDeclaration,
  type EnvResult,
  type EnvSplit,
  type EnvStanding,
  type GoalEnv,
} from "@codecast/shared/contracts/envs";
import { apiPost, type PublishDeps } from "./castApi.js";
import { commandGroup } from "./commandGroups.js";
import { c } from "./colors.js";
import { fillCommand, loadEnvDeclarations, parseEnvsText, repoIdentity, resultText } from "./envDeclaration.js";
import { scopeFor } from "./lineScope.js";
import { caseSetLines, fetchCaseSet, heldTreeProblem, putCaseSet, putCaseSetMeta, readCaseSetInput, withCaseFile, type CaseSetLog } from "./envCases.js";
import { CASES_FILE_ENV, isCaseSetSplit } from "@codecast/shared/contracts/envCases";

/** Set on a dev run told to read the runner's own local corpus instead of codecast's dev set. */
export const LOCAL_CASES_ENV = "CODECAST_ENV_LOCAL_CASES";

/** How long a runner may take when its declaration says nothing. */
export const ENV_TIMEOUT_DEFAULT_S = 1800;

/** Whether the tree has changes no commit holds (tracked or untracked). */
export function treeDirty(dir: string): boolean {
  try { return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0; } catch { return true; }
}

export type Post = (urlPath: string, body: Record<string, unknown>, read?: boolean) => Promise<any>;
type Palette = Record<"green" | "yellow" | "red" | "cyan" | "dim" | "bold" | "reset", string>;

const cwd = () => process.env.CODECAST_CWD || process.cwd();
function fail(message: string): never {
  console.error(`${c.red}error${c.reset} ${message}`);
  process.exit(1);
}

export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function gitSha(dir: string, ref = "HEAD"): string | null {
  try { return execFileSync("git", ["rev-parse", ref], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}

function loadOrFail() {
  try { return loadEnvDeclarations(cwd()); } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
}

function declared(key: string): { decl: EnvDeclaration; root: string } {
  const { root, file, envs } = loadOrFail();
  if (!root) fail("not inside a git repository: envs are declared in <repo>/.codecast/envs.toml");
  if (!file) fail(`this repo declares no envs: add ${path.join(root, ".codecast/envs.toml")}`);
  const decl = envs.find((e) => e.key === key);
  if (!decl) fail(`${key} is not declared in ${file} (declared: ${envs.map((e) => e.key).join(", ") || "none"})`);
  return { decl, root };
}

// ── running one env ──

export type EnvRun = { ok: true; result: EnvResult; warnings: string[]; code: number; ms: number } | { ok: false; error: string; code: number; ms: number };

/** Run a declared env once in `dir` (the repo root, or a base tree) and read its result against the contract. */
export async function runEnv(decl: EnvDeclaration, opts: { dir: string; candidate: string; split: EnvSplit; /** The commit the tree is; null when the tree has uncommitted changes, so no attempt claims a sha it is not. */ sha?: string | null; quiet?: boolean; /** The split's case-set file from codecast (envCases.ts withCaseFile), named to the runner in CODECAST_ENV_CASES. */ casesFile?: string; /** Dev only: the runner may read its own local corpus (CODECAST_ENV_LOCAL_CASES=1). */ localCases?: boolean }): Promise<EnvRun> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-env-")), "result.json");
  const command = fillCommand(decl.command, { candidate: opts.candidate, split: opts.split, out, sha: opts.sha ?? "", root: opts.dir });
  const started = Date.now();
  const env: NodeJS.ProcessEnv = { ...process.env, CODECAST_ENV: decl.key, CODECAST_ENV_CANDIDATE: opts.candidate, CODECAST_ENV_SPLIT: opts.split, CODECAST_ENV_OUT: out, CODECAST_ENV_SHA: opts.sha ?? "" };
  delete env[CASES_FILE_ENV];
  delete env[LOCAL_CASES_ENV];
  if (opts.casesFile) env[CASES_FILE_ENV] = opts.casesFile;
  if (opts.localCases && opts.split === "dev") env[LOCAL_CASES_ENV] = "1";
  // Its own process group, so a timeout stops the runner's children too
  // (a `bun run` script, forked workers), not only the shell holding the pipe.
  const proc = spawn("sh", ["-c", command], {
    cwd: opts.dir,
    detached: true,
    // A held runner's stderr can carry what it read (a stack, a log line), and the caller's output is a synced transcript: count it, never show it.
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : opts.split === "held" ? "pipe" : "inherit"],
    env,
  });
  const limit = (decl.timeout_s ?? ENV_TIMEOUT_DEFAULT_S) * 1000;
  let timedOut = false;
  let stdout = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  let withheld = 0;
  proc.stderr?.on("data", (chunk: Buffer) => { withheld += chunk.toString("utf8").split("\n").length - 1; });
  // The runner has its own process group: when this process ends, it ends too, so it reads no held file past its run.
  const killGroup = () => { try { process.kill(-proc.pid!, "SIGKILL"); } catch {} };
  process.once("exit", killGroup);
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
      proc.stdout?.destroy();
      resolve(-1);
    }, limit);
    // When the runner itself exits, whatever it left in its group (a forked worker, a detached copy holding the pipe) ends with it.
    proc.on("exit", killGroup);
    proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? -1); });
    proc.on("error", () => { clearTimeout(timer); resolve(-1); });
  });
  killGroup();
  process.removeListener("exit", killGroup);
  if (withheld && !opts.quiet) console.error(`${decl.key}: ${withheld} line${withheld === 1 ? "" : "s"} of runner output withheld on the held split (run --split dev to see it)`);
  const ms = Date.now() - started;
  if (timedOut) return { ok: false, error: `${decl.key} ran past its ${limit / 1000}s limit and was stopped (timeout_s in envs.toml)`, code, ms };
  const fromFile = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const text = fromFile?.trim() ? fromFile : resultText(stdout);
  if (!text) return { ok: false, error: `${decl.key} exited ${code} and printed no result (one JSON object on stdout, or written to {out})`, code, ms };
  const parsed = parseEnvResult(text, { env: decl.key, level: decl.level, split: opts.split });
  // A held result's error would quote what the runner printed, which may be what it read: say only that it broke.
  if (!parsed.ok) return { ok: false, error: opts.split === "held" ? `${decl.key}'s held result breaks the contract (the details would quote the runner, so they are withheld: run --split dev to see the same error)` : `${decl.key}'s result breaks the contract: ${parsed.error}`, code, ms };
  const result = parsed.result;
  // A held case is filed by a hash of its id, never its id (contracts/envs heldCaseId).
  // A runner that already files hashed ids (h: and 16 hex, the same hash) keeps them.
  if (result.split === "held") result.cases = await Promise.all(result.cases.map(async (k) => ({ id: /^h:[0-9a-f]{16}$/.test(k.id) ? k.id : await heldCaseId(decl.key, k.id), score: k.score })));
  // The sha is what codecast knows the tree to be, never what the runner says.
  const { sha: _said, ...rest } = result.candidate;
  result.candidate = opts.sha ? { ...rest, sha: opts.sha } : rest;
  return { ok: true, result, warnings: parsed.warnings, code, ms };
}

/**
 * Run an env with its split's cases from codecast. A held run always fetches
 * them, and only on a committed tree whose runner is the base's (heldTreeProblem). A dev run fetches the live dev set
 * when there is one and runs with none when the env keeps no dev set here, so
 * an env without case sets is unaffected; `localCases` skips the fetch and
 * tells the runner to read its own corpus. The fetch's id goes back so the
 * attempt is filed against it.
 */
export async function runWithCases(post: Post, decl: EnvDeclaration, run: Parameters<typeof runEnv>[1], fetch: { goal?: string; scope?: Record<string, unknown>; session_id?: string | null; task_id?: string }): Promise<{ run: EnvRun; read?: string }> {
  if (!isCaseSetSplit(run.split) || (run.split === "dev" && run.localCases)) return { run: await runEnv(decl, run) };
  if (run.split === "held") {
    const problem = heldTreeProblem(run.dir, decl, baseSha(run.dir));
    if (problem) throw new Error(problem);
  }
  let read: string | undefined;
  try {
    const out = await withCaseFile(post, decl.key, run.split, { ...fetch, ttl_s: (decl.timeout_s ?? ENV_TIMEOUT_DEFAULT_S) + 600 }, (casesFile, f) => { read = f.read; return runEnv(decl, { ...run, casesFile }); });
    return { run: out, read };
  } catch (err) {
    const msg = errText(err);
    if (run.split === "dev" && /has no dev set/.test(msg)) return { run: await runEnv(decl, run) };
    throw new Error(run.split === "dev" ? `${msg} (to run on the corpus this machine holds, pass --local-cases)` : msg);
  }
}

/** A refusal to write that passes on its own: Convex's write-rate limit, an overloaded backend, a dropped connection or a timeout. */
const RETRYABLE_WRITE_RE = /too many (?:writes|bytes|requests|concurrent)|write.?rate|overloaded|rate.?limit|\b(?:429|50[234])\b|temporarily|try again|fetch failed|timed? ?out|ECONNRESET|socket hang up/i;
export const isRetryableWrite = (err: unknown): boolean => RETRYABLE_WRITE_RE.test(err instanceof Error ? err.message : String(err));

/**
 * A write that is safe to repeat, retried with backoff (about 1, 2, 4, 8 and
 * 16 seconds, jittered) while the refusal is one that passes. Anything else,
 * or the last try, throws as it came.
 */
export async function withWriteRetry<T>(fn: () => Promise<T>, opts: { tries?: number; sleep?: (ms: number) => Promise<void>; onRetry?: (err: unknown, wait: number) => void } = {}): Promise<T> {
  const tries = opts.tries ?? 6;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !isRetryableWrite(err)) throw err;
      const wait = Math.round(1000 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
      opts.onRetry?.(err, wait);
      await sleep(wait);
    }
  }
}

/**
 * File a result. The server reads the same JSON again. Its cases are filed in
 * pages (contracts/envs compactCasePages): the record carries the first and
 * each later page is its own small write, so a large attempt never trips
 * Convex's write-rate limit, and every write retries a refusal that passes.
 * One client key makes the record safe to repeat; a page already written is a no-op.
 */
export async function recordRun(post: Post, decl: EnvDeclaration, root: string, result: EnvResult, extra: { goal?: string; task_id?: string; session_id?: string | null; scope?: Record<string, unknown>; cases_read?: string }, retry: Parameters<typeof withWriteRetry>[1] = {}): Promise<{ short_id: string; warnings?: string[] }> {
  const wire = { ...result, started_at: new Date(result.started_at).toISOString(), finished_at: new Date(result.finished_at).toISOString(), ...(result.link ? { link: { ...result.link, measured_at: new Date(result.link.measured_at).toISOString() } } : {}) };
  const notify = { onRetry: (err: unknown, wait: number) => console.error(`${c.yellow}warning${c.reset} filing ${decl.key}: ${err instanceof Error ? err.message : String(err)}; trying again in ${(wait / 1000).toFixed(1)}s`), ...retry };
  const body = {
    ...(extra.goal ? {} : extra.scope ?? {}),
    result: JSON.stringify(wire),
    env: decl.key,
    level: decl.level,
    title: decl.title,
    repo: repoIdentity(root),
    client_key: randomUUID(),
    ...(extra.goal ? { goal: extra.goal } : {}),
    ...(extra.task_id ? { task_id: extra.task_id } : {}),
    ...(extra.session_id ? { session_id: extra.session_id } : {}),
    ...(extra.cases_read ? { cases_read: extra.cases_read } : {}),
  };
  const filed = await withWriteRetry(async () => {
    try {
      return await post("/cli/envs/record", body);
    } catch (err) {
      // A server from before pages refuses the key it does not know: file whole, as it expects.
      if (!/client_key|extra field|ArgumentValidationError/i.test(err instanceof Error ? err.message : String(err))) throw err;
      const { client_key: _k, ...whole } = body;
      return await post("/cli/envs/record", whole);
    }
  }, notify);
  const pages = compactCasePages(result.cases);
  for (let seq = filed.case_pages_written ?? 1; seq < (filed.case_pages ?? 1); seq++) {
    await withWriteRetry(() => post("/cli/envs/record-cases", { attempt: filed.short_id, seq, cases: pages[seq] }), notify);
  }
  return filed;
}

const score = (r: { n: number; mean: number; ci95?: [number, number] }) => `${r.mean.toFixed(3)}${r.ci95 ? ` [${r.ci95[0].toFixed(3)}, ${r.ci95[1].toFixed(3)}]` : ""} n=${r.n}`;
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// ── a goal's levels, printed ──

/** A goal's levels as `cast goal show` and `cast goal envs` print them. */
/** The titles this checkout's envs.toml declares, by key; none when it declares none or does not read. */
export function localEnvTitles(): (key: string) => string | undefined {
  try {
    const envs = loadEnvDeclarations(cwd()).envs;
    return (key) => envs.find((e) => e.key === key)?.title;
  } catch {
    return () => undefined;
  }
}

/** A goal's environments by level. An env shows its declared title (an attempt's, else this checkout's declaration) with its key beside it, or its key once. */
export function goalLevelLines(p: Palette, levels: EnvStanding[], goalRef: string, now = Date.now(), declaredTitle: (key: string) => string | undefined = () => undefined): string[] {
  const out = [`\n  ${p.bold}Environments${p.reset} ${p.dim}what predicts it, by level${p.reset}`];
  if (!levels.length) return [...out, `  ${p.dim}None yet: cast goal envs ${goalRef} set L0=<product>/<name> L2=...${p.reset}`];
  for (const s of levels) {
    const title = s.title ?? declaredTitle(s.env);
    out.push(`  ${p.cyan}${s.level}${p.reset} ${p.bold}${title ?? s.env}${p.reset} ${p.dim}${title && title !== s.env ? `${s.env} · ` : ""}${ENV_LEVEL_NAME[s.level]}${s.note ? ` · ${s.note}` : ""}${p.reset}`);
    const a = s.attempt;
    const facts = [a ? `${standingScore(s)} ${a.candidate.label} ${a.split} ${a.short_id} ${ago(a.finished_at, now)}` : `${p.yellow}no attempt yet${p.reset}${p.dim}`, standingNoise(s) ?? "noise unmeasured", standingCost(s)].filter(Boolean);
    out.push(`     ${p.dim}${facts.join(" · ")}${p.reset}`);
    out.push(`     ${p.dim}link ${standingLink(s, (at) => ago(at, now)) ?? "to the level above: not measured"}${p.reset}`);
  }
  return out;
}

/** `cast goal envs <in-N> [set|add|remove] [specs...]`: read or write the goal's envs. */
export async function goalEnvsAction(post: Post, ref: string, action: string | undefined, specs: string[], opts: { allowUndeclared?: boolean; json?: boolean }): Promise<void> {
  const show = async () => {
    const out = await post("/cli/envs/goal-levels", { goal: ref }, true);
    if (!out) fail(`Goal not found (or not visible to you): ${ref}`);
    if (opts.json) { console.log(JSON.stringify(out, null, 2)); return; }
    console.log(`\n  ${c.bold}${out.goal.title}${c.reset}  ${c.cyan}${out.goal.short_id}${c.reset}`);
    for (const line of goalLevelLines(c, out.levels, out.goal.short_id, Date.now(), localEnvTitles())) console.log(line);
    console.log("");
  };
  if (!action || action === "ls" || action === "show") return show();
  if (!["set", "add", "remove"].includes(action)) fail(`unknown action "${action}": set, add, remove, or none to show`);
  if (action !== "set" && !specs.length) fail(`name at least one env: cast goal envs ${ref} ${action} L2=<product>/<name>`);
  let local: EnvDeclaration[] = [];
  try { local = loadEnvDeclarations(cwd()).envs; } catch (err) { fail(err instanceof Error ? err.message : String(err)); }
  const levelOf = (key: string) => local.find((e) => e.key === key)?.level;
  const current: GoalEnv[] = (await post("/cli/envs/goal-levels", { goal: ref }, true))?.levels?.map((s: EnvStanding) => ({ env: s.env, level: s.level, ...(s.note ? { note: s.note } : {}) })) ?? fail(`Goal not found (or not visible to you): ${ref}`);
  let next: GoalEnv[];
  if (action === "remove") {
    const drop = new Set(specs.map((s) => s.replace(/^L[0-5]=/, "")));
    const missing = [...drop].filter((k) => !current.some((e) => e.env === k));
    if (missing.length) fail(`${ref} does not name ${missing.join(", ")}`);
    next = current.filter((e) => !drop.has(e.env));
  } else {
    const read = specs.map((s) => parseGoalEnvSpec(s, levelOf));
    const bad = read.find((r): r is { error: string } => "error" in r);
    if (bad) fail(bad.error);
    const named = read as GoalEnv[];
    for (const e of named) {
      const decl = local.find((d) => d.key === e.env);
      if (!decl && !opts.allowUndeclared) fail(`${e.env} is not declared in this repo's .codecast/envs.toml; run from the repo that declares it, or pass --allow-undeclared`);
      if (decl && decl.level !== e.level) fail(`${e.env} is declared at ${decl.level}, not ${e.level}`);
    }
    next = action === "set" ? named : [...current.filter((e) => !named.some((n) => n.env === e.env)), ...named];
  }
  const norm = normalizeGoalEnvs(next);
  if ("error" in norm) fail(norm.error);
  await post("/cli/initiatives/update", { id: ref, envs: norm });
  console.log(`${c.green}ok${c.reset} ${ref} names ${norm.length ? norm.map((e) => `${e.level}=${e.env}`).join(" ") : "no environments"}`);
  await show();
}

// ── the line's eval station ──

/** A detached tree at a sha (the base, or a climb candidate), with the checkout's node_modules linked in, removed after `fn`. */
export function withTreeAt<T>(root: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-env-base-"));
  const cleanup = () => {
    try { execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: root, stdio: "ignore" }); } catch { fs.rmSync(dir, { recursive: true, force: true }); try { execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "ignore" }); } catch {} }
  };
  const link = (rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === ".git" || (e.name.startsWith(".") && e.name !== ".codecast")) continue;
      const sub = path.join(rel, e.name);
      if (e.name === "node_modules") {
        if (fs.existsSync(path.join(dir, rel)) && !fs.existsSync(path.join(dir, sub))) fs.symlinkSync(path.join(root, sub), path.join(dir, sub));
      } else if (depth < 4) link(sub, depth + 1);
    }
  };
  try {
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", dir, sha], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    link("", 0);
  } catch (err) {
    cleanup();
    return Promise.reject(err);
  }
  return fn(dir).finally(cleanup);
}

/** An env as the base declared it: the base grades both sides, so a branch cannot rewrite its own test. */
export function declarationAt(root: string, sha: string, key: string): EnvDeclaration | null | "unreadable" {
  let text: string;
  try { text = execFileSync("git", ["show", `${sha}:.codecast/envs.toml`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  try { return parseEnvsText(text).find((e) => e.key === key) ?? null; } catch { return "unreadable"; }
}

export type EnvEvalRow = { env: string; level: string; title: string; base?: string; candidate?: string; delta?: ReturnType<typeof pairedDelta>; phrase?: string; note?: string; skipped?: string; error?: string };

/** The base sha a branch is compared against: its merge base with origin's default branch. */
export function baseSha(root: string, explicit?: string): string | null {
  if (explicit) return gitSha(root, explicit);
  for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
    try { return execFileSync("git", ["merge-base", "HEAD", ref], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  }
  return null;
}

/**
 * Run the task's goal's L0..L2 envs that declare a dev split on the base and
 * on this tree, file both attempts, and report the paired delta. A task with
 * no goal, or a goal with no such envs, prints nothing and writes nothing.
 *
 * The base's declaration runs both sides, and two sides whose env_version
 * differ are not compared: a branch that edits its own grader is reported,
 * not scored. A base attempt is reused only when it was filed as `base` at
 * the base sha with the same env_version, never the attempt just filed. Any
 * one env failing is its own row; the rest still run, and --out is written.
 */
export async function envEval(post: Post, opts: { task: string; base?: string; out?: string; sessionId?: string | null }): Promise<EnvEvalRow[]> {
  const rows: EnvEvalRow[] = [];
  const say = (what: string, error: string) => rows.push({ env: what, level: "", title: what, error });
  let goal: string | undefined, base: string | null = null, head: string | null = null;
  try {
    let task: any;
    try { task = await post("/cli/work/get", { short_id: opts.task }, true); } catch (err) { say(opts.task, `could not read the task: ${errText(err)}`); return rows; }
    goal = String(task?.goal_ref ?? "").match(/^in-\d+/i)?.[0]?.toLowerCase();
    if (!goal) return rows;
    let levels: any;
    try { levels = await post("/cli/envs/goal-levels", { goal }, true); } catch (err) { say(goal, `could not read the goal's environments: ${errText(err)}`); return rows; }
    const wanted: EnvStanding[] = (levels?.levels ?? []).filter((s: EnvStanding) => ["L0", "L1", "L2"].includes(s.level));
    if (!wanted.length) return rows;
    let local: ReturnType<typeof loadEnvDeclarations>;
    try { local = loadEnvDeclarations(cwd()); } catch (err) { say(goal, errText(err)); return rows; }
    const root = local.root;
    base = root ? baseSha(root, opts.base) : null;
    const dirty = root ? treeDirty(root) : false;
    head = root && !dirty ? gitSha(root) : null;
    for (const s of wanted) {
      const branchDecl = local.envs.find((e) => e.key === s.env);
      const row: EnvEvalRow = { env: s.env, level: s.level, title: branchDecl?.title ?? s.title ?? s.env };
      rows.push(row);
      try {
        if (!root) { row.skipped = "not inside a git repository"; continue; }
        if (!base) { row.skipped = "no base to compare against (no merge base with origin)"; continue; }
        const baseDecl = declarationAt(root, base, s.env);
        if (baseDecl === "unreadable") { row.skipped = "the base's .codecast/envs.toml does not load"; continue; }
        if (!baseDecl) { row.skipped = branchDecl ? "new on this branch: the base does not declare it, so there is nothing to compare" : "not declared in this repo's .codecast/envs.toml"; continue; }
        if (baseDecl.level !== s.level) { row.skipped = `declared at ${baseDecl.level}, the goal names it at ${s.level}`; continue; }
        if (!baseDecl.splits.includes("dev")) { row.skipped = "declares no dev split"; continue; }
        if (branchDecl && (branchDecl.command !== baseDecl.command || branchDecl.level !== baseDecl.level)) row.note = "the branch changes this env's declaration; the base's was run on both sides";
        const fetchFor = { goal, task_id: opts.task, session_id: opts.sessionId };
        const candRun = await runWithCases(post, baseDecl, { dir: root, candidate: opts.task, split: "dev", sha: head }, fetchFor);
        const cand = candRun.run;
        if (!cand.ok) { row.error = cand.error; continue; }
        if (cand.code !== 0) row.note = [row.note, `the runner exited ${cand.code} on the branch`].filter(Boolean).join("; ");
        row.candidate = (await recordRun(post, baseDecl, root, cand.result, { ...fetchFor, cases_read: candRun.read })).short_id;
        const prior = ((await post("/cli/envs/list", { goal, env: baseDecl.key, limit: 50 }, true).catch(() => [])) as any[])
          .find((a) => a.short_id !== row.candidate && a.candidate?.label === "base" && a.candidate?.sha === base && a.env_version === cand.result.env_version && a.split === "dev");
        let baseCases: EnvCase[];
        let baseVersion: string;
        if (prior) {
          row.base = prior.short_id;
          baseVersion = prior.env_version;
          const read = await post("/cli/envs/get", { id: prior.short_id }, true);
          if (read.cases_complete === false) throw new Error(`base ${prior.short_id} was filed without all its cases; run the eval again to file a whole base`);
          baseCases = read.cases;
        } else {
          const baseRun = await withTreeAt(root, base, (dir) => runWithCases(post, baseDecl, { dir, candidate: "base", split: "dev", sha: base }, fetchFor));
          const b = baseRun.run;
          if (!b.ok) { row.error = `base: ${b.error}`; continue; }
          row.base = (await recordRun(post, baseDecl, root, b.result, { ...fetchFor, cases_read: baseRun.read })).short_id;
          baseVersion = b.result.env_version;
          baseCases = b.result.cases;
        }
        if (baseVersion !== cand.result.env_version) { row.skipped = `the env itself differs on the branch (version ${baseVersion} at the base, ${cand.result.env_version} here), so the two are not compared`; continue; }
        row.delta = pairedDelta(baseCases, cand.result.cases);
        row.phrase = deltaPhrase(row.delta, cand.result.noise?.aa_sd, baseDecl.level);
      } catch (err) {
        row.error = errText(err);
      }
    }
    return rows;
  } finally {
    if (opts.out && rows.length) fs.writeFileSync(opts.out, JSON.stringify({ task: opts.task, goal, base, head, envs: rows }, null, 2));
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export const envEvalLines = (rows: EnvEvalRow[]): string[] =>
  rows.map((r) => `${r.level ? `${r.level} ` : ""}${r.env}: ${r.phrase ? `${r.phrase} (base ${r.base}, branch ${r.candidate})` : r.error ? `could not score: ${r.error}` : `skipped: ${r.skipped}`}${r.note ? ` [${r.note}]` : ""}`);

// ── the command ──

export function registerEnvCommand(program: Command, deps: PublishDeps): void {
  // Filing throws rather than exits, so recordRun can retry a refusal that passes.
  const post: Post = (urlPath, body, read) => apiPost(deps, urlPath, body, { read, ...(urlPath.startsWith("/cli/envs/record") ? { exitOnError: false } : {}) });
  const env = program.command("env").alias("envs").description(commandGroup("env").description);

  env
    .command("ls")
    .description("The envs this repo declares, each with its latest attempt and link")
    .option("--team <name|id|personal>", "Workspace to read attempts from")
    .option("--json", "Output as JSON")
    .action(async (o: { team?: string; json?: boolean }) => {
      const { file, envs } = loadOrFail();
      if (!file) { console.log(`No envs declared here: add .codecast/envs.toml (cast env --help shows its shape)`); return; }
      let standings: EnvStanding[] = [];
      let unreachable: string | null = null;
      if (envs.length) {
        try {
          standings = await apiPost(deps, "/cli/envs/standings", { ...(await scopeFor(deps, o.team, false)), envs: envs.map((e) => ({ env: e.key, level: e.level })) }, { read: true, exitOnError: false });
        } catch (err) {
          unreachable = err instanceof Error ? err.message : String(err);
        }
      }
      if (unreachable && !o.json) console.error(`${c.yellow}warning${c.reset} attempts not read: ${unreachable}`);
      if (o.json) { console.log(JSON.stringify(envs.map((e, i) => ({ ...e, standing: standings[i] })), null, 2)); return; }
      console.log(`\n  ${c.bold}Environments${c.reset} ${c.dim}${file}${c.reset}`);
      envs.forEach((e, i) => {
        const s = standings[i];
        console.log(`  ${c.cyan}${e.level}${c.reset} ${c.bold}${e.key}${c.reset} ${e.title} ${c.dim}splits ${e.splits.join(",")}${e.cost_usd !== undefined ? ` · ~$${e.cost_usd}` : ""}${e.predicts ? ` · predicts ${e.predicts}` : ""}${c.reset}`);
        const a = s?.attempt;
        console.log(`     ${c.dim}${a ? `last ${standingScore(s)} ${a.candidate.label} ${a.split} ${a.short_id} ${ago(a.finished_at)}` : "no attempt yet"}${s?.link ? ` · link ${standingLink(s, (at) => ago(at))}` : ""}${c.reset}`);
      });
      console.log("");
    });

  env
    .command("run")
    .description("Run a declared env on this tree, check its result against the contract, and file the attempt")
    .argument("<key>", "The env's key (<product>/<name>)")
    .option("--candidate <label>", "What is being run: base (a clean tree), or a name for the change (default: base on a clean tree, working-tree otherwise)")
    .option("--split <split>", "dev, held or fresh (default: the first the env declares)")
    .option("--sha <sha>", "The commit the candidate is (default: HEAD)")
    .option("--goal <in-N>", "File the attempt under this goal's workspace")
    .option("--task <ct-N>", "The task the attempt serves")
    .option("--team <name|id|personal>", "Workspace to file in when no --goal names one")
    .option("--no-record", "Run and check only; file nothing")
    .option("--local-cases", "Dev only: run on the corpus this machine holds, not codecast's dev set")
    .option("--json", "Print the checked result as JSON")
    .action(async (key: string, o: { candidate?: string; split?: string; sha?: string; goal?: string; task?: string; team?: string; record: boolean; localCases?: boolean; json?: boolean }) => {
      const { decl, root } = declared(key);
      const split = (o.split ?? decl.splits[0]) as EnvSplit;
      if (!decl.splits.includes(split)) fail(`${key} declares the ${decl.splits.join(", ")} split${decl.splits.length > 1 ? "s" : ""}, not ${split}`);
      const dirty = treeDirty(root);
      const candidate = o.candidate ?? (dirty ? "working-tree" : "base");
      if (dirty && candidate === "base") fail("the tree has uncommitted changes, so this run is not the base: commit or stash them, or name the candidate (--candidate <label>)");
      const head = dirty ? null : gitSha(root);
      const said = o.sha ? gitSha(root, o.sha) ?? o.sha : null;
      if (candidate === "base" && said && said !== head) fail(`--sha ${o.sha} is not this tree (HEAD ${head?.slice(0, 8)}): a base run is the tree it runs on; check that commit out, or name the candidate`);
      const sha = said ?? head;
      if (o.localCases && split !== "dev") fail("--local-cases is for the dev split: held cases come only from codecast");
      const sessionId = deps.detectCurrentSessionId();
      // Offline is fine for a local dev run that files nothing.
      const scope = o.goal || (o.localCases && !o.record) ? undefined : await scopeFor(deps, o.team, true);
      // A run reads its split's cases from codecast through a logged fetch, into a file removed after the run.
      // A held run runs only a committed tree with the base's runner, and files what it fetched.
      if (split === "held" && !o.record) fail("a held run files its attempt: every fetch of the held set is answered by one (drop --no-record)");
      const { run, read: casesRead } = await runWithCases(post, decl, { dir: root, candidate, split, sha, localCases: o.localCases }, { goal: o.goal, scope, session_id: sessionId, task_id: o.task }).catch((err) => fail(errText(err)));
      if (!run.ok) fail(run.error);
      for (const w of run.warnings) console.error(`${c.yellow}warning${c.reset} ${w}`);
      if (run.code !== 0) console.error(`${c.yellow}warning${c.reset} ${key} exited ${run.code}; its result is filed as printed`);
      const r = run.result;
      let filed: { short_id: string; warnings?: string[] } | null = null;
      try {
        filed = o.record ? await recordRun(post, decl, root, r, { goal: o.goal, task_id: o.task, session_id: sessionId, scope, cases_read: casesRead }) : null;
      } catch (err) {
        fail(`${key} ran, but filing its attempt failed: ${errText(err)}`);
      }
      if (o.json) { console.log(JSON.stringify({ ...(filed ? { short_id: filed.short_id } : {}), result: r }, null, 2)); return; }
      const s = r.summary;
      console.log(`${c.green}ok${c.reset} ${filed ? `${c.cyan}${filed.short_id}${c.reset} ` : ""}${r.level} ${c.bold}${key}${c.reset} ${r.split} ${r.candidate.label}${r.candidate.sha ? `@${r.candidate.sha.slice(0, 8)}` : ""}: ${score(s)}${s.unscored ? ` (${s.unscored} unscored)` : ""}`);
      const extra = [s.paired_delta !== undefined ? `vs ${s.baseline?.label ?? "base"} ${deltaPhrase({ n: s.n, delta: s.paired_delta, ci95: s.paired_ci95 }, r.noise?.aa_sd, r.level)}` : null, r.noise ? `A/A sd ${r.noise.aa_sd} over ${r.noise.aa_runs}` : null, r.cost_usd !== undefined ? `$${r.cost_usd.toFixed(2)}` : null, secs(run.ms), r.link ? `link ${r.link.measure} ${r.link.value} to ${r.link.to}` : null].filter(Boolean);
      console.log(`   ${c.dim}${extra.join(" · ")}${filed ? "" : " · not filed (--no-record)"}${c.reset}`);
    });

  env
    .command("show")
    .description("One attempt (ea-N) with its cases, or one env's declaration and recent attempts")
    .argument("<key|ea-N>", "An env key or an attempt's short id")
    .option("--team <name|id|personal>", "Workspace to read an env's attempts from")
    .option("--json", "Output as JSON")
    .action(async (ref: string, o: { team?: string; json?: boolean }) => {
      if (/^ea-\d+$/i.test(ref)) {
        const a = await post("/cli/envs/get", { id: ref }, true);
        if (o.json) { console.log(JSON.stringify(a, null, 2)); return; }
        console.log(`\n  ${c.cyan}${a.short_id}${c.reset} ${a.level} ${c.bold}${a.title ?? a.env}${c.reset} ${c.dim}${a.env} · ${a.split} · ${a.candidate.label}${a.candidate.sha ? `@${a.candidate.sha.slice(0, 8)}` : ""} · ${ago(a.finished_at)}${c.reset}`);
        console.log(`  ${score(a)}${a.unscored ? ` (${a.unscored} unscored)` : ""} ${c.dim}version ${a.env_version}${a.cost_usd !== undefined ? ` · $${a.cost_usd.toFixed(2)}` : ""}${a.noise ? ` · A/A sd ${a.noise.aa_sd} over ${a.noise.aa_runs}` : ""}${a.task_id ? ` · ${a.task_id}` : ""}${c.reset}`);
        if (a.paired_delta !== undefined) console.log(`  vs ${a.baseline?.label ?? "base"}: ${deltaPhrase({ n: a.n, delta: a.paired_delta, ci95: a.paired_ci95 }, a.noise?.aa_sd)}`);
        if (a.link) console.log(`  ${c.dim}link ${a.link.measure} ${a.link.value} to ${a.link.to} (n=${a.link.n}, ${ago(a.link.measured_at)}${a.link.evidence ? `, ${a.link.evidence}` : ""})${c.reset}`);
        const cases = [...a.cases].sort((x: EnvCase, y: EnvCase) => x.score - y.score);
        console.log(`\n  ${c.bold}Cases (${cases.length})${c.reset} ${c.dim}lowest first${c.reset}`);
        for (const k of cases.slice(0, 30)) console.log(`  ${k.score.toFixed(3)} ${k.id}${k.pass === false ? ` ${c.red}fail${c.reset}` : ""}${k.note ? ` ${c.dim}${k.note}${c.reset}` : ""}`);
        if (cases.length > 30) console.log(`  ${c.dim}… ${cases.length - 30} more (--json for all)${c.reset}`);
        console.log("");
        return;
      }
      const { envs } = loadOrFail();
      const decl = envs.find((e) => e.key === ref);
      const scope = await scopeFor(deps, o.team, false);
      const [rows, caseSets]: [any[], CaseSetLog | null] = await Promise.all([post("/cli/envs/list", { ...scope, env: ref, limit: 15 }, true), apiPost(deps, "/cli/envs/cases/log", { ...scope, env: ref, limit: 10 }, { read: true, exitOnError: false }).catch(() => null)]);
      if (o.json) { console.log(JSON.stringify({ declaration: decl ?? null, attempts: rows, case_sets: caseSets }, null, 2)); return; }
      if (decl) console.log(`\n  ${c.cyan}${decl.level}${c.reset} ${c.bold}${decl.title}${c.reset} ${c.dim}${decl.key}${c.reset}\n  ${c.dim}${decl.command}${c.reset}\n  ${c.dim}splits ${decl.splits.join(", ")}${decl.cost_usd !== undefined ? ` · ~$${decl.cost_usd} a run` : ""}${decl.predicts ? ` · predicts ${decl.predicts}` : ""}${decl.role === "check" ? ` · check: may not get ${decl.direction === "lower" ? "higher" : "lower"} by more than ${decl.tolerance ?? 0}` : ""}${c.reset}`);
      else console.log(`\n  ${c.bold}${ref}${c.reset} ${c.yellow}not declared in this repo${c.reset}`);
      console.log(`\n  ${c.bold}Attempts (${rows.length})${c.reset}`);
      if (!rows.length) console.log(`  ${c.dim}None yet: cast env run ${ref}${c.reset}`);
      for (const a of rows) console.log(`  ${c.cyan}${a.short_id}${c.reset} ${score(a)} ${c.dim}${a.split} ${a.candidate.label}${a.candidate.sha ? `@${a.candidate.sha.slice(0, 8)}` : ""} · ${ago(a.finished_at)}${a.task_id ? ` · ${a.task_id}` : ""}${c.reset}`);
      if (caseSets && (caseSets.dev || caseSets.held || caseSets.reads.length)) for (const line of caseSetLines(c, caseSets, (at) => ago(at))) console.log(line);
      console.log("");
    });

  const cases = env.command("cases").description("An env's dev and held cases kept in codecast, so a run works on any machine: dev is readable by anyone in the workspace, held only by cast env run --split held");
  cases
    .command("put")
    .description("Upload this env's case set for a split ({ label?, meta?, cases: [{ id, payload }] })")
    .argument("<key>", "The env's key")
    .requiredOption("--split <dev|held>", "Which split the cases are")
    .requiredOption("--file <path|->", "The case set as JSON, or - for stdin; with --keep-cases, { meta, label? } only")
    .option("--keep-cases", "Replace only the live set's meta (a recalibration): codecast keeps its cases, so none need be at hand")
    .option("--goal <in-N>", "File it under this goal's workspace")
    .option("--team <name|id|personal>", "Workspace to file in when no --goal names one")
    .option("--replace", "Supersede the split's live set")
    .option("--task <ct-N>", "The task this upload serves")
    .action(async (key: string, o: { split: string; file: string; keepCases?: boolean; goal?: string; team?: string; replace?: boolean; task?: string }) => {
      if (!isCaseSetSplit(o.split)) fail(`--split must be dev or held, not ${o.split}`);
      let text: string;
      try { text = readCaseSetInput(o.file); } catch (err) { fail(`could not read ${o.file}: ${errText(err)}`); }
      try {
        const where = { goal: o.goal, scope: o.goal ? undefined : await scopeFor(deps, o.team, true), session_id: deps.detectCurrentSessionId(), task_id: o.task };
        const out = o.keepCases ? await putCaseSetMeta(post, key, o.split, text, where) : await putCaseSet(post, key, o.split, text, { ...where, replace: o.replace });
        console.log(`${c.green}ok${c.reset} ${key} ${o.split} set ${out.version}: ${out.size} cases, live in ${out.workspace}`);
      } catch (err) {
        fail(errText(err));
      }
    });
  cases
    .command("get")
    .description("Download this env's dev set (the held set is never downloaded)")
    .argument("<key>", "The env's key")
    .option("--out <file>", "Write it here (default: stdout)")
    .option("--goal <in-N>", "Read from this goal's workspace")
    .option("--team <name|id|personal>", "Workspace to read from when no --goal names one")
    .action(async (key: string, o: { out?: string; goal?: string; team?: string }) => {
      try {
        const { file } = await fetchCaseSet(post, key, "dev", { goal: o.goal, scope: o.goal ? undefined : await scopeFor(deps, o.team, false), session_id: deps.detectCurrentSessionId() });
        const text = JSON.stringify(file);
        if (o.out) { fs.writeFileSync(o.out, text); console.error(`${c.green}ok${c.reset} ${key} dev set ${file.version}: ${file.cases.length} cases to ${o.out}`); }
        else process.stdout.write(`${text}\n`);
      } catch (err) {
        fail(errText(err));
      }
    });

  env
    .command("link")
    .description("Record a measured link from an env to the level above, with its evidence")
    .argument("<key>", "The env's key")
    .requiredOption("--to <level:target>", "What it predicts: L5:<metric key> or L<n>:<env key>")
    .requiredOption("--measure <word>", "auc, pearson, rank, calibration, or another word")
    .requiredOption("--value <x>", "The measured value")
    .requiredOption("--n <count>", "How many paired observations it rests on")
    .option("--evidence <ref>", "What shows it: an attempt (ea-N), a doc, a session, a link")
    .option("--at <iso>", "When it was measured (default: now)")
    .option("--goal <in-N>", "File it under this goal's workspace")
    .option("--team <name|id|personal>", "Workspace to file in when no --goal names one")
    .action(async (key: string, o: { to: string; measure: string; value: string; n: string; evidence?: string; at?: string; goal?: string; team?: string }) => {
      const { envs } = loadOrFail();
      const level = envs.find((e) => e.key === key)?.level;
      const value = Number(o.value), n = Number(o.n);
      if (!Number.isFinite(value)) fail(`--value "${o.value}" is not a number`);
      if (!Number.isInteger(n) || n < 0) fail(`--n "${o.n}" is not a whole number`);
      const at = o.at ? Date.parse(o.at) : undefined;
      if (o.at && !Number.isFinite(at)) fail(`--at "${o.at}" is not a time`);
      const out = await post("/cli/envs/link", { ...(o.goal ? { goal: o.goal } : await scopeFor(deps, o.team, true)), env: key, ...(level ? { level } : {}), to: o.to, measure: o.measure, value, n, ...(at ? { measured_at: at } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) });
      console.log(`${c.green}ok${c.reset} ${key} ${out.link.measure} ${out.link.value} to ${out.link.to} (n=${out.link.n}${out.link.evidence ? `, ${out.link.evidence}` : ""})`);
    });

  env
    .command("eval", { hidden: true })
    .description("The line's eval station: run the task's goal's L0..L2 dev envs on base and branch and print the paired delta")
    .requiredOption("--task <ct-N>", "The task whose goal names the envs")
    .option("--base <ref>", "The base to compare against (default: the merge base with origin)")
    .option("--out <file>", "Write the rows as JSON")
    .action(async (o: { task: string; base?: string; out?: string }) => {
      const rows = await envEval(post, { ...o, sessionId: deps.detectCurrentSessionId() });
      for (const line of envEvalLines(rows)) console.log(line);
    });
}
