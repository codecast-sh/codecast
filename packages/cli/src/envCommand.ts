// `cast env`: the environments this repo declares (`.codecast/envs.toml`,
// envDeclaration.ts), run against a candidate and filed as attempts
// (convex/envs.ts); and `cast goal envs`, the levels a goal names. The
// line's eval station calls `cast env eval --task` to run the task's goal's
// L0..L2 envs on the base and the branch and report the paired delta.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import type { Command } from "commander";
import {
  ENV_LEVEL_NAME,
  deltaPhrase,
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

function gitSha(dir: string, ref = "HEAD"): string | null {
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
export async function runEnv(decl: EnvDeclaration, opts: { dir: string; candidate: string; split: EnvSplit; /** The commit the tree is; null when the tree has uncommitted changes, so no attempt claims a sha it is not. */ sha?: string | null; quiet?: boolean }): Promise<EnvRun> {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-env-")), "result.json");
  const command = fillCommand(decl.command, { candidate: opts.candidate, split: opts.split, out, sha: opts.sha ?? "", root: opts.dir });
  const started = Date.now();
  // Its own process group, so a timeout stops the runner's children too
  // (a `bun run` script, forked workers), not only the shell holding the pipe.
  const proc = spawn("sh", ["-c", command], {
    cwd: opts.dir,
    detached: true,
    stdio: ["ignore", "pipe", opts.quiet ? "ignore" : "inherit"],
    env: { ...process.env, CODECAST_ENV: decl.key, CODECAST_ENV_CANDIDATE: opts.candidate, CODECAST_ENV_SPLIT: opts.split, CODECAST_ENV_OUT: out, CODECAST_ENV_SHA: opts.sha ?? "" },
  });
  const limit = (decl.timeout_s ?? ENV_TIMEOUT_DEFAULT_S) * 1000;
  let timedOut = false;
  let stdout = "";
  proc.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-proc.pid!, "SIGKILL"); } catch {}
      proc.stdout?.destroy();
      resolve(-1);
    }, limit);
    proc.on("close", (c) => { clearTimeout(timer); resolve(c ?? -1); });
    proc.on("error", () => { clearTimeout(timer); resolve(-1); });
  });
  const ms = Date.now() - started;
  if (timedOut) return { ok: false, error: `${decl.key} ran past its ${limit / 1000}s limit and was stopped (timeout_s in envs.toml)`, code, ms };
  const fromFile = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null;
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
  const text = fromFile?.trim() ? fromFile : resultText(stdout);
  if (!text) return { ok: false, error: `${decl.key} exited ${code} and printed no result (one JSON object on stdout, or written to {out})`, code, ms };
  const parsed = parseEnvResult(text, { env: decl.key, level: decl.level, split: opts.split });
  if (!parsed.ok) return { ok: false, error: `${decl.key}'s result breaks the contract: ${parsed.error}`, code, ms };
  const result = parsed.result;
  // A held case is filed by a hash of its id, never its id (contracts/envs heldCaseId).
  if (result.split === "held") result.cases = await Promise.all(result.cases.map(async (k) => ({ id: await heldCaseId(decl.key, k.id), score: k.score })));
  // The sha is what codecast knows the tree to be, never what the runner says.
  const { sha: _said, ...rest } = result.candidate;
  result.candidate = opts.sha ? { ...rest, sha: opts.sha } : rest;
  return { ok: true, result, warnings: parsed.warnings, code, ms };
}

/** File a result. The server reads the same JSON again; the result's cases go as the runner wrote them. */
export async function recordRun(post: Post, decl: EnvDeclaration, root: string, result: EnvResult, extra: { goal?: string; task_id?: string; session_id?: string | null; scope?: Record<string, unknown> }): Promise<{ short_id: string; warnings?: string[] }> {
  const wire = { ...result, started_at: new Date(result.started_at).toISOString(), finished_at: new Date(result.finished_at).toISOString(), ...(result.link ? { link: { ...result.link, measured_at: new Date(result.link.measured_at).toISOString() } } : {}) };
  return await post("/cli/envs/record", {
    ...(extra.goal ? {} : extra.scope ?? {}),
    result: JSON.stringify(wire),
    env: decl.key,
    level: decl.level,
    title: decl.title,
    repo: repoIdentity(root),
    ...(extra.goal ? { goal: extra.goal } : {}),
    ...(extra.task_id ? { task_id: extra.task_id } : {}),
    ...(extra.session_id ? { session_id: extra.session_id } : {}),
  });
}

const score = (r: { n: number; mean: number; ci95?: [number, number] }) => `${r.mean.toFixed(3)}${r.ci95 ? ` [${r.ci95[0].toFixed(3)}, ${r.ci95[1].toFixed(3)}]` : ""} n=${r.n}`;
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

// ── a goal's levels, printed ──

/** A goal's levels as `cast goal show` and `cast goal envs` print them. */
export function goalLevelLines(p: Palette, levels: EnvStanding[], goalRef: string, now = Date.now()): string[] {
  const out = [`\n  ${p.bold}Environments${p.reset} ${p.dim}what predicts it, by level${p.reset}`];
  if (!levels.length) return [...out, `  ${p.dim}None yet: cast goal envs ${goalRef} set L0=<product>/<name> L2=...${p.reset}`];
  for (const s of levels) {
    out.push(`  ${p.cyan}${s.level}${p.reset} ${p.bold}${s.title ?? s.env}${p.reset} ${p.dim}${s.env} · ${ENV_LEVEL_NAME[s.level]}${s.note ? ` · ${s.note}` : ""}${p.reset}`);
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
    for (const line of goalLevelLines(c, out.levels, out.goal.short_id)) console.log(line);
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

/** The env's base run: a detached tree at the base sha, with the checkout's node_modules linked in. */
function withBaseTree<T>(root: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
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
function declarationAt(root: string, sha: string, key: string): EnvDeclaration | null | "unreadable" {
  let text: string;
  try { text = execFileSync("git", ["show", `${sha}:.codecast/envs.toml`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
  try { return parseEnvsText(text).find((e) => e.key === key) ?? null; } catch { return "unreadable"; }
}

export type EnvEvalRow = { env: string; level: string; title: string; base?: string; candidate?: string; delta?: ReturnType<typeof pairedDelta>; phrase?: string; note?: string; skipped?: string; error?: string };

/** The base sha a branch is compared against: its merge base with origin's default branch. */
function baseSha(root: string, explicit?: string): string | null {
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
        const cand = await runEnv(baseDecl, { dir: root, candidate: opts.task, split: "dev", sha: head });
        if (!cand.ok) { row.error = cand.error; continue; }
        if (cand.code !== 0) row.note = [row.note, `the runner exited ${cand.code} on the branch`].filter(Boolean).join("; ");
        row.candidate = (await recordRun(post, baseDecl, root, cand.result, { goal, task_id: opts.task, session_id: opts.sessionId })).short_id;
        const prior = ((await post("/cli/envs/list", { goal, env: baseDecl.key, limit: 50 }, true).catch(() => [])) as any[])
          .find((a) => a.short_id !== row.candidate && a.candidate?.label === "base" && a.candidate?.sha === base && a.env_version === cand.result.env_version && a.split === "dev");
        let baseCases: EnvCase[];
        let baseVersion: string;
        if (prior) {
          row.base = prior.short_id;
          baseVersion = prior.env_version;
          baseCases = (await post("/cli/envs/get", { id: prior.short_id }, true)).cases;
        } else {
          const b = await withBaseTree(root, base, (dir) => runEnv(baseDecl, { dir, candidate: "base", split: "dev", sha: base }));
          if (!b.ok) { row.error = `base: ${b.error}`; continue; }
          row.base = (await recordRun(post, baseDecl, root, b.result, { goal, task_id: opts.task, session_id: opts.sessionId })).short_id;
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
  const post: Post = (urlPath, body, read) => apiPost(deps, urlPath, body, { read });
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
    .option("--json", "Print the checked result as JSON")
    .action(async (key: string, o: { candidate?: string; split?: string; sha?: string; goal?: string; task?: string; team?: string; record: boolean; json?: boolean }) => {
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
      const run = await runEnv(decl, { dir: root, candidate, split, sha });
      if (!run.ok) fail(run.error);
      for (const w of run.warnings) console.error(`${c.yellow}warning${c.reset} ${w}`);
      if (run.code !== 0) console.error(`${c.yellow}warning${c.reset} ${key} exited ${run.code}; its result is filed as printed`);
      const r = run.result;
      const filed = o.record ? await recordRun(post, decl, root, r, { goal: o.goal, task_id: o.task, session_id: deps.detectCurrentSessionId(), scope: o.goal ? undefined : await scopeFor(deps, o.team, true) }) : null;
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
      const rows: any[] = await post("/cli/envs/list", { ...(await scopeFor(deps, o.team, false)), env: ref, limit: 15 }, true);
      if (o.json) { console.log(JSON.stringify({ declaration: decl ?? null, attempts: rows }, null, 2)); return; }
      if (decl) console.log(`\n  ${c.cyan}${decl.level}${c.reset} ${c.bold}${decl.title}${c.reset} ${c.dim}${decl.key}${c.reset}\n  ${c.dim}${decl.command}${c.reset}\n  ${c.dim}splits ${decl.splits.join(", ")}${decl.cost_usd !== undefined ? ` · ~$${decl.cost_usd} a run` : ""}${decl.predicts ? ` · predicts ${decl.predicts}` : ""}${c.reset}`);
      else console.log(`\n  ${c.bold}${ref}${c.reset} ${c.yellow}not declared in this repo${c.reset}`);
      console.log(`\n  ${c.bold}Attempts (${rows.length})${c.reset}`);
      if (!rows.length) console.log(`  ${c.dim}None yet: cast env run ${ref}${c.reset}`);
      for (const a of rows) console.log(`  ${c.cyan}${a.short_id}${c.reset} ${score(a)} ${c.dim}${a.split} ${a.candidate.label}${a.candidate.sha ? `@${a.candidate.sha.slice(0, 8)}` : ""} · ${ago(a.finished_at)}${a.task_id ? ` · ${a.task_id}` : ""}${c.reset}`);
      console.log("");
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
