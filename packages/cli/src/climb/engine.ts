// The climb's deterministic stations (flows.md FL10, contracts/climb.ts):
// gauge, admit, screen, confirm and guard.
//
// Nothing a station decides rests on the climb's own state file. The state
// (sealed, store.ts) is a cache of which filed attempt (ea-N) answers which
// run; every station reads those attempts back from the registry and checks
// each is the run it claims (env, split, candidate label and sha, version, the
// climb's task, filed after the climb began), re-derives the ceiling, the
// files that grade and each candidate's admissibility from git and committed
// config, and replays the stations before it from those attempts. A forged
// status, cut or budget changes nothing; an attempt that is not the run it
// claims is refused. What stays on trust: the registry records an attempt's
// candidate, sha and task as its filer states them, and agents file as the
// same user, so an agent that reads the seal's key can file a result it made
// up and point the cache at it. Closing that needs filings signed by a
// credential agents cannot read (a separate OS user, or a run credential the
// server checks). Also on trust: the eval gate's verdict per candidate, and
// the spend the cache records.
//
// Every env run goes through the budget first, counted from the registry's
// own attempts under the climb's task, and a run the budget cannot cover
// stops the climb. Runs already filed are reused, so a resumed run pays for
// nothing twice.
import fs from "node:fs";
import path from "node:path";
import type { EnvCase, EnvDeclaration, EnvLevel, EnvResult, EnvSplit, EnvStanding } from "@codecast/shared/contracts/envs";
import { CLIMB_AA_RUNS, baseMeanCases, changedCases, halve, levelCanSee, levelNoise, readClimbCard, separates, type ClimbBudget, type ClimbCard, type LevelNoise } from "@codecast/shared/contracts/climb";
import { parseEnvsText } from "../envDeclaration.js";
import { parseLineProfileText, resolveLineProfile } from "../lineProfile.js";
import { StoreTampered, archiveSealed, readSealed, writeSealed } from "./store.js";
import type { ClimbBase } from "./base.js";
import { movedHistory, pairedTerms } from "./noise.js";
import { gateLimitS, gateLog, runGate } from "./gate.js";
import { MetricUnread, readability as readabilityOf, type Readability } from "./readability.js";
import { resolveCommand, withDirs, graderPackageDirs, gradingGlobs, inadmissible, packagesPrint, pinsAScript, protectedDigest, tryGit } from "./protect.js";

/** A run's outcome; `unfiled` is a run that finished but the registry refused to file, with the registry's reason. */
export type RunOut = { ok: true; result: EnvResult; short_id?: string; unfiled?: string } | { ok: false; error: string };
export type ClimbIo = {
  root: string;
  post: (urlPath: string, body: Record<string, unknown>, read?: boolean) => Promise<any>;
  /** This attempt at the climb: the flow run's id, so a failure is reused within the attempt that made it and run again by the next. */
  attempt?: string;
  /** Run one env in `dir` (a detached tree at `sha`) on a split and file the attempt under the climb's task. */
  run: (decl: EnvDeclaration, opts: { dir: string; label: string; split: EnvSplit; sha: string; goal: string; task?: string }) => Promise<RunOut>;
  /** A detached tree at a sha, removed after `fn`. */
  tree: <T>(sha: string, fn: (dir: string) => Promise<T>) => Promise<T>;
  /** The product's eval verdict over the reps its eval command wrote: 0 passed, 1 worse, other unscored. */
  evalResult: (reps: string, out: string) => number;
  log: (line: string) => void;
};

/** One candidate on one level and split: the paired delta, whether it separated, and how many cases its change moved past the base's own spread. */
export type Cut = { attempt?: string; delta: number; ci95?: [number, number]; keep: boolean; why: string; changed?: number; of?: number };
export type LevelState = {
  env: string; level: EnvLevel; title: string; kept: boolean; why: string;
  cost_usd: number; held: boolean; plausible_effect?: number;
  noise?: LevelNoise; version?: string; base_attempts: string[];
  /** Why the level's base runs failed to run (the runner's own error, or no case scored): an environment failure, never a sensitivity verdict. */
  failed?: string;
  /** The held split's own A/A: the spread between the base's two held runs, and how many cases moved between them. */
  held_aa?: { se: number; moved: number; of: number };
};
export type CandStatus = "admitted" | "refused" | "dropped" | "unscreened" | "survivor" | "overfit" | "guard_failed" | "promoted";
export type Cand = {
  id: string; branch: string; sha?: string; hypothesis: string; predicted_delta?: number;
  /** Why admit or the reviewer barred it; a barred candidate never runs. */
  barred?: string;
  status: CandStatus; why?: string;
  dev: Record<string, Cut>; held: Record<string, Cut>; guard?: { pass: boolean; why: string };
};
/** A run the cache names: its attempt, and whether it was reused from before the climb. */
type Done = { attempt: string; reused?: boolean; usd?: number };
/** A run that failed or was refused: never run again, and its cost counted. */
/** A run that failed or was refused in one attempt (the flow run that made it): its cost counted, run again by any later attempt. */
type Failed = { usd: number; why: string; attempt?: string };
export type ClimbState = {
  base: string;
  /** Where the base came from and how far this checkout's HEAD stood from it (base.ts). */
  base_info?: ClimbBase; task?: string; card: ClimbCard; notes: string[];
  /** When the climb's task was created: runs of the climb are filed after it, reused base runs before it. */
  reuse_before: number;
  /** The goal's checks (L0 envs and `role = "check"` envs) as they stood at gauge; the guard runs these and any the goal names now. */
  checks: string[];
  /** The installed packages the grading files import, as they stood at gauge (protect.ts packagesPrint). */
  packages: string;
  levels: LevelState[]; candidates: Cand[];
  ledger: { usd: number; runs: number; done: Record<string, Done>; failed: Record<string, Failed> };
  /** The product eval gate's verdict per candidate sha (on trust: it is not filed anywhere); a void verdict is never kept here. */
  gates: Record<string, number>;
  /** Each finished eval gate run's duration (ms; twice the longest is the next limit), and per candidate sha why its gate was stopped at the limit. */
  gate_ms?: number[]; gate_stuck?: Record<string, string>;
  /** Script paths the eval command names that the climb could not reach at the base (protect.ts resolveCommand). */
  gate_unreached?: string[];
  /** How many times the eval gate ran, void runs included: each counts against the run limit. */
  gate_runs?: number;
  /** Per candidate and check (`cand-1|env` or `cand-1|gate`), the round its void verdict is on: a re-run files under a new key. */
  guard_rounds?: Record<string, number>;
  /** Why promotion is held: the best survivor's guard came back void (an outage, a capped pool), never a verdict. */
  pending?: string;
  /** Whether production can read one change of the card's plausible lift (readability.ts), read before any spend. */
  readability?: Readability | { metric: string; unread: string };
  promoted_task?: string; stopped?: string; outcome?: string;
};

export const STOP = { none: 3, budget: 4, card: 5, pending: 6 } as const;
export class ClimbStop extends Error { constructor(message: string, readonly code: number) { super(message); } }

export function readState(dir: string): ClimbState | null {
  try { return readSealed<ClimbState>(dir); } catch (err) { if (err instanceof StoreTampered) throw new ClimbStop(err.message, STOP.none); throw err; }
}
const save = (dir: string, s: ClimbState) => writeSealed(dir, s);

/** Every env the base declares, read at the base sha: what runs both sides and what candidates may not touch. */
function baseDecls(root: string, base: string): EnvDeclaration[] {
  const text = tryGit(root, ["show", `${base}:.codecast/envs.toml`]);
  if (text === null) throw new ClimbStop(`the base ${base.slice(0, 8)} declares no .codecast/envs.toml`, STOP.none);
  return parseEnvsText(text);
}
const declOf = (decls: EnvDeclaration[], key: string) => decls.find((d) => d.key === key) ?? null;
/** A check is what a climb may not make worse and never climbs: every L0 env, and any env declared `role = "check"`. */
export const isCheck = (d: Pick<EnvDeclaration, "level" | "role">) => d.level === "L0" || d.role === "check";
/** The goal's checks Guard runs on every survivor, by env key. */
const goalChecks = (levels: ReadonlyArray<{ env: string; level: EnvLevel }>, decls: EnvDeclaration[]) => levels.filter((l) => isCheck(declOf(decls, l.env) ?? { level: l.level })).map((l) => l.env);

/**
 * The repo's ceiling on what a climb of `goal` may spend, from
 * `.codecast/climb.toml` as committed at the base (so no station's edit, and
 * no candidate's, moves it): `[goals."in-9".budget]` for one goal, else
 * `[budget]` for every goal, each with `usd` and `runs`. Null when the file
 * names none, and the climb's default holds.
 */
export function repoCeiling(root: string, base: string, goal: string): { usd?: number; runs?: number } | null {
  const text = tryGit(root, ["show", `${base}:.codecast/climb.toml`]);
  if (!text) return null;
  let raw: any;
  try { raw = Bun.TOML.parse(text); } catch { throw new ClimbStop(".codecast/climb.toml at the base is not valid TOML", STOP.none); }
  const b = raw?.goals?.[goal]?.budget ?? raw?.budget;
  return b && typeof b === "object" ? { ...(typeof b.usd === "number" ? { usd: b.usd } : {}), ...(typeof b.runs === "number" ? { runs: b.runs } : {}) } : null;
}

export type PromoteMode = "line" | "experiment";
/**
 * How the repo ships a promoted change, from `.codecast/climb.toml` at the
 * base, `[promote] mode`: "line" files it as a task for the product's own
 * change line (a product that ships approved work live and runs a split test
 * only when a person asks), "experiment" puts a holdout experiment to a
 * person. Experiment when the file says nothing.
 */
export function promoteMode(root: string, base: string): PromoteMode {
  const text = tryGit(root, ["show", `${base}:.codecast/climb.toml`]);
  if (!text) return "experiment";
  let raw: any;
  try { raw = Bun.TOML.parse(text); } catch { throw new ClimbStop(".codecast/climb.toml at the base is not valid TOML", STOP.none); }
  const mode = raw?.promote?.mode;
  if (mode === undefined) return "experiment";
  if (mode !== "line" && mode !== "experiment") throw new ClimbStop(`.codecast/climb.toml [promote] mode is "${mode}"; it is "line" or "experiment"`, STOP.none);
  return mode;
}

/** The product's eval command as the line profile committed at the base names it: the gate no station or candidate can swap. */
export function baseEvalCommand(root: string, base: string): string {
  const text = tryGit(root, ["show", `${base}:.codecast/line.toml`]);
  if (!text) return "";
  try { return resolveLineProfile(parseLineProfileText(text).values).profile.commands.eval ?? ""; } catch { return ""; }
}

// ── one station's view: the state re-derived from git, config and the registry ──

type View = {
  io: ClimbIo; dir: string; s: ClimbState;
  decls: EnvDeclaration[]; globs: string[]; budget: ClimbBudget;
  /** Lazily: the grading files' digest at the base. */
  digest?: string;
  /** Attempts read back this station, by id. */
  read: Map<string, { cases: EnvCase[]; version: string; cost: number; unscored: number; aa_sd?: number }>;
};

async function load(io: ClimbIo, dir: string): Promise<View> {
  const s = readState(dir) ?? (() => { throw new ClimbStop("no climb state: gauge first", STOP.none); })();
  const decls = baseDecls(io.root, s.base);
  const globs = gradingGlobs(io.root, s.base, decls);
  const goal = await io.post("/cli/envs/goal-levels", { goal: s.card.goal }, true).catch(() => null);
  const ceiling = goal?.goal?.budget ?? repoCeiling(io.root, s.base, s.card.goal);
  const read = readClimbCard({ ...s.card, budget: s.card.budget }, { short_id: s.card.goal, budget: ceiling, levels: s.card.levels.map((l) => ({ env: l.env, level: l.level })) });
  const budget = read.ok ? read.card.budget : s.card.budget;
  if (goal?.levels) s.checks = [...new Set([...s.checks, ...goalChecks(goal.levels as EnvStanding[], decls)])];
  // A candidate is admissible only as git shows it now, whatever the state says.
  for (const c of s.candidates) if (!c.barred && c.sha) { const why = inadmissible(io.root, s.base, c.sha, globs); if (why) c.barred = why; }
  return { io, dir, s, decls, globs, budget, read: new Map() };
}

/** An attempt read back and checked against the run the cache says it is. */
async function verified(v: View, key: string, d: Done, want: { env: string; split: EnvSplit; label: string; sha: string }) {
  const hit = v.read.get(d.attempt);
  if (hit) return hit;
  const a = await v.io.post("/cli/envs/get", { id: d.attempt }, true).catch(() => null);
  const lie = (why: string) => { throw new ClimbStop(`the climb's record names ${d.attempt} for ${key}, but ${why}`, STOP.none); };
  if (!a || !Array.isArray(a.cases)) lie("the registry has no such attempt");
  if (a.env !== want.env || a.split !== want.split || a.candidate?.label !== want.label || a.candidate?.sha !== want.sha) lie(`it is ${a.candidate?.label}@${String(a.candidate?.sha).slice(0, 8)} on ${a.env} ${a.split}`);
  if (v.s.task && v.s.reuse_before) {
    const at = Number(a.created_at ?? a.finished_at);
    if (d.reused ? !(Number(a.finished_at) < v.s.reuse_before) : a.task_id !== v.s.task || !(at >= v.s.reuse_before)) lie(d.reused ? "it was filed after the climb began" : "it was not filed by this climb");
  }
  const out = { cases: a.cases as EnvCase[], version: String(a.env_version), cost: Number(a.cost_usd ?? 0), unscored: Number(a.unscored ?? 0) || 0, ...(a.noise?.aa_sd ? { aa_sd: a.noise.aa_sd } : {}) };
  v.read.set(d.attempt, out);
  return out;
}

// ── budget and runs ──

const usd = (x: number) => `$${x.toFixed(2)}`;
/** What the climb has spent: its own filed runs and its failed ones, by what each cost; eval gates count as runs. */
function spent(v: View): { usd: number; runs: number } {
  const done = Object.values(v.s.ledger.done).filter((d) => !d.reused);
  const failed = Object.values(v.s.ledger.failed ?? {});
  const usd = [...done.map((d) => d.usd ?? 0), ...failed.map((f) => f.usd)].reduce((x, y) => x + y, 0);
  return { usd: Math.round(usd * 1e6) / 1e6, runs: done.length + failed.length + (v.s.gate_runs ?? Object.keys(v.s.gates).length) };
}

async function stopForBudget(v: View, est: number, what: string): Promise<void> {
  const b = v.budget;
  const now = spent(v);
  v.s.ledger.usd = now.usd;
  v.s.ledger.runs = now.runs;
  if (now.runs + 1 <= b.runs && now.usd + est <= b.usd + 1e-9) return;
  v.s.stopped = `budget spent: ${usd(now.usd)} of ${usd(b.usd)} and ${now.runs} of ${b.runs} runs, before ${what} (about ${usd(est)})`;
  for (const c of v.s.candidates) if (c.status === "admitted" || c.status === "survivor") { c.status = "unscreened"; c.why = "the budget ran out before it was decided"; }
  save(v.dir, v.s);
  throw new ClimbStop(v.s.stopped, STOP.budget);
}
/** What the next run of an env is expected to cost: the declared price, or the dearest filed run of it so far. */
function estimate(v: View, decl: EnvDeclaration): number {
  const seen = Object.entries(v.s.ledger.done).filter(([k]) => k.split("|")[1] === decl.key).map(([, d]) => d.usd ?? 0);
  return Math.max(decl.cost_usd ?? 0, ...seen);
}

const HELD_FAILED = "the held run failed; its output is sealed and not repeated here";

/** The base's grading files, packages and declarations must still be what gauge saw before a candidate runs in a tree that links them. */
async function treeGuard(v: View, tree: string): Promise<string | null> {
  v.digest ??= await v.io.tree(v.s.base, async (t) => protectedDigest(t, v.globs));
  if (protectedDigest(tree, v.globs) !== v.digest) return "its tree holds the files that grade differently from the base";
  if (packagesPrint(v.io.root, graderPackageDirs(v.io.root, v.s.base, v.globs)) !== v.s.packages) return "PACKAGES";
  return null;
}

/** One env run, once: a key the cache names is read back from the registry and checked; otherwise it runs, under the budget, and is filed. */
async function runOnce(v: View, key: string, decl: EnvDeclaration, opts: { label: string; split: EnvSplit; sha: string }): Promise<{ cases: EnvCase[]; version: string; attempt?: string; unscored: number } | { error: string }> {
  const want = { env: decl.key, split: opts.split, label: opts.label, sha: opts.sha };
  const done = v.s.ledger.done[key];
  if (done) { const r = await verified(v, key, done, want); return { cases: r.cases, version: r.version, attempt: done.attempt, unscored: r.unscored }; }
  // A failure is reused only by the attempt that made it (its stations replay one another). A later attempt runs the
  // env again, since it may have been fixed since; the old failure keeps its cost on the ledger under another key.
  const attempt = v.io.attempt ?? `process-${process.pid}`;
  const failed = v.s.ledger.failed?.[key];
  if (failed && failed.attempt === attempt) return { error: failed.why };
  if (failed) {
    const ledger = v.s.ledger.failed!;
    ledger[`${key}~${Object.keys(ledger).filter((k) => k.startsWith(`${key}~`)).length + 1}`] = failed;
    delete ledger[key];
  }
  await stopForBudget(v, estimate(v, decl), `${opts.label} on ${decl.key} ${opts.split}`);
  let refused: string | null = null;
  const out = await v.io.tree(opts.sha, async (tree): Promise<RunOut> => {
    refused = await treeGuard(v, tree);
    if (refused) return { ok: false, error: refused };
    return v.io.run(decl, { dir: tree, label: opts.label, split: opts.split, sha: opts.sha, goal: v.s.card.goal, task: v.s.task });
  });
  if (refused === "PACKAGES") { save(v.dir, v.s); throw new PackagesMoved(); }
  const fail = (why: string, usd: number) => { (v.s.ledger.failed ??= {})[key] = { usd, why, attempt }; save(v.dir, v.s); return { error: why }; };
  if (refused) return fail(`GRADER: ${refused}`, 0);
  const cost = Math.max(0, (out.ok ? out.result.cost_usd : undefined) ?? decl.cost_usd ?? 0);
  if (!out.ok) return fail(opts.split === "held" ? HELD_FAILED : out.error.replace(/\s+/g, " ").slice(0, 300), cost);
  if (!out.short_id) return fail(`the run finished but could not be filed (${out.unfiled ?? "no attempt id came back"}), and the climb counts only filed runs`, cost);
  v.s.ledger.done[key] = { attempt: out.short_id, usd: cost };
  save(v.dir, v.s);
  const r = await verified(v, key, v.s.ledger.done[key], want);
  v.io.log(`${opts.label} ${decl.key} ${opts.split}: mean ${out.result.summary.mean.toFixed(3)} n=${r.cases.length} (${out.short_id})`);
  return { cases: r.cases, version: r.version, attempt: out.short_id, unscored: r.unscored };
}

// ── gauge: the card held to the caps, what grades pinned, and what each level can see ──

export async function gauge(io: ClimbIo, dir: string, opts: { card: unknown; base: string; base_info?: ClimbBase; task?: string; goal?: string }): Promise<ClimbState> {
  let prior = readState(dir);
  let carried: string | null = null;
  // A climb under way is pinned to the base it started on: a default branch that moved meanwhile neither resets its
  // record nor its spend. One that stopped, or never kept a level (its env failed, say), starts fresh on the new base,
  // where the fix that lets it run may be. The old state is set aside, never deleted.
  if (prior && prior.base !== opts.base && (prior.stopped || !prior.levels.some((l) => l.kept))) {
    const to = archiveSealed(dir);
    carried = `the last attempt, on base ${prior.base.slice(0, 10)}, stopped (${prior.stopped ?? "no level kept"}) after $${prior.ledger.usd.toFixed(2)}; this attempt starts fresh on ${opts.base.slice(0, 10)}${to ? ` (the last attempt's state is kept at ${to})` : ""}`;
    io.log(carried);
    prior = null;
  }
  if (prior && prior.base !== opts.base) io.log(`the climb stays on its base ${prior.base.slice(0, 8)} (the default branch is now ${opts.base.slice(0, 8)})`);
  if (!prior) {
    const card = opts.card as any;
    const goalRef = String(card?.goal ?? "").match(/^in-\d+/i)?.[0]?.toLowerCase();
    if (!goalRef) throw new ClimbStop("the card names no goal (in-N)", STOP.card);
    const taskGoal = opts.goal?.match(/^in-\d+/i)?.[0]?.toLowerCase();
    if (opts.goal !== undefined && !taskGoal) throw new ClimbStop("the climb's task names no goal (its goal_ref is in-N or in-N:metric)", STOP.none);
    if (taskGoal && taskGoal !== goalRef) throw new ClimbStop(`the card names ${goalRef}, but the climb's task climbs ${taskGoal}`, STOP.card);
    const levels = await io.post("/cli/envs/goal-levels", { goal: goalRef }, true);
    if (!levels?.goal) throw new ClimbStop(`goal ${goalRef} not found or not visible`, STOP.none);
    const goalLevels = (levels.levels as EnvStanding[]).map((l) => ({ env: l.env, level: l.level }));
    const read = readClimbCard(card, { short_id: levels.goal.short_id, budget: levels.goal.budget ?? repoCeiling(io.root, opts.base, levels.goal.short_id), levels: goalLevels });
    if (!read.ok) throw new ClimbStop(`the card is refused: ${read.error}`, STOP.card);
    const decls = baseDecls(io.root, opts.base);
    // Every precondition of every chosen level, before a base run spends anything: the card goes back to Frame with the whole list.
    const problems = preflight(read.card, decls, levels.levels as EnvStanding[]);
    if (problems.length) throw new ClimbStop(`the card's levels cannot run as chosen, and nothing was spent:\n- ${problems.join("\n- ")}`, STOP.card);
    const task = opts.task ? await io.post("/cli/work/get", { short_id: opts.task }, true).catch(() => null) : null;
    const notes = [...read.notes, ...(carried ? [carried] : [])];
    // Before anything is spent: can production confirm one change of the size the card expects? When it cannot, the card says so and names what stands in.
    let readability: ClimbState["readability"];
    if (read.card.metric && read.card.production_lift) {
      const row = await io.post("/cli/initiatives/get", { id: goalRef }, true).catch(() => null);
      try { readability = readabilityOf(row, read.card.metric, read.card.production_lift); } catch (err) { readability = { metric: read.card.metric, unread: err instanceof MetricUnread ? err.message : String(err) }; }
    }
    save(dir, {
      base: opts.base, ...(opts.base_info ? { base_info: opts.base_info } : {}), ...(opts.task ? { task: opts.task } : {}), card: read.card, notes,
      reuse_before: Number(task?.created_at ?? task?._creationTime) || 0,
      ...(readability ? { readability } : {}),
      checks: goalChecks(goalLevels, decls),
      packages: packagesPrint(io.root, graderPackageDirs(io.root, opts.base, gradingGlobs(io.root, opts.base, decls))),
      levels: [], candidates: [], ledger: { usd: 0, runs: 0, done: {}, failed: {} }, gates: {},
    });
  }
  const v = await load(io, dir);
  await withRegauge(v, () => measureLevels(v));
  return v.s;
}

/** Each card level's base runs and what they show: the noise, the MDE, and whether the level can see one change. */
async function measureLevels(v: View): Promise<void> {
  const s = v.s, dir = v.dir;
  // Each Gauge measures afresh: a stop an earlier attempt recorded here is the old attempt's, not this one's.
  delete s.stopped;
  for (const cl of s.card.levels) {
    const decl = declOf(v.decls, cl.env);
    const row: LevelState = { env: cl.env, level: cl.level, title: decl?.title ?? cl.env, kept: false, why: "", cost_usd: decl?.cost_usd ?? 0, held: !!decl?.splits.includes("held") && !!decl?.protects?.length, base_attempts: [], ...(cl.plausible_effect !== undefined ? { plausible_effect: cl.plausible_effect } : {}) };
    s.levels = [...s.levels.filter((l) => l.env !== cl.env), row];
    // Preflight held every level to its preconditions before the climb's first run; one missing here was refused there.
    if (!decl) { row.why = "the base does not declare it"; continue; }
    const k = cl.level === "L0" ? 1 : CLIMB_AA_RUNS;
    await reuseBaseRuns(v, cl.env, k);
    const runs: EnvCase[][] = [];
    let version: string | undefined;
    let reported = 0;
    for (let i = 0; i < k; i++) {
      const r = await runOnce(v, `base|${cl.env}|dev|${i}`, decl, { label: "base", split: "dev", sha: s.base });
      // A base run that fails, or scores no case, is the environment failing to run: never a verdict on what the level can see.
      if ("error" in r) { row.failed = r.error; row.why = `the base run failed to run: ${r.error}`; break; }
      if (!r.cases.length) { row.failed = `the base run scored no case${r.unscored ? ` (${r.unscored} unscored)` : ""}`; row.why = row.failed; break; }
      if (version && r.version !== version) { row.why = `the env reported two versions on the unchanged base (${version}, ${r.version}): it is not stable enough to climb on`; break; }
      version = r.version;
      runs.push(r.cases);
      if (r.attempt) { row.base_attempts.push(r.attempt); reported = Math.max(reported, v.read.get(r.attempt)?.aa_sd ?? 0); }
    }
    if (row.why) { save(dir, s); continue; }
    // A scoring level is compared paired, case by case: its floor rests on how many cases one change moves and by how much.
    const paired = cl.level === "L0" ? undefined : pairedTerms(cl, await movedHistory(v.io.post, s.card.goal, cl.env, version!));
    const noise = levelNoise(cl.level, runs, reported || undefined, decl.mde, paired);
    if ("error" in noise) { row.why = noise.error; save(dir, s); continue; }
    const see = levelCanSee(cl.level, noise, cl.plausible_effect);
    Object.assign(row, { noise, version, kept: see.ok, why: see.why });
    save(dir, s);
  }
  const scoring = s.levels.filter((l) => l.level !== "L0");
  if (!scoring.some((l) => l.kept)) {
    const failed = scoring.filter((l) => l.failed);
    const words = failed.map((l) => `${l.env}: ${l.failed}`).join("; ");
    s.stopped = failed.length === scoring.length
      ? `the environment failed to run, so nothing was measured or proposed (${words}); fix the env and rerun: this says nothing about the change's size`
      : failed.length
        ? `no level that ran can see one change, and ${failed.length === 1 ? "one" : failed.length} failed to run (${words}); nothing was proposed`
        : "no level the card names can see one change; nothing was proposed";
    save(dir, s);
    throw new ClimbStop(s.stopped, STOP.none);
  }
}

/** Thrown when the installed packages the grading files import are not what the climb measured its base on. */
class PackagesMoved extends Error {}

/**
 * Run a station; when the grader's packages moved under it (a reinstall, an
 * upgrade), measure the base again on the new state and run it once more.
 * Every run made before the change keeps its cost on the ledger and is never
 * read again, so no comparison mixes the two states.
 */
async function withRegauge(v: View, fn: () => Promise<void>): Promise<void> {
  try { return await fn(); } catch (err) { if (!(err instanceof PackagesMoved)) throw err; }
  const s = v.s;
  const now = packagesPrint(v.io.root, graderPackageDirs(v.io.root, s.base, v.globs));
  const n = Object.keys(s.ledger.failed ?? {}).filter((k) => k.startsWith("stale")).length;
  for (const [key, d] of Object.entries(s.ledger.done)) {
    if (!d.reused) (s.ledger.failed ??= {})[`stale${n}|${key}`] = { usd: d.usd ?? 0, why: "run before the grader's installed packages changed; measured again" };
    delete s.ledger.done[key];
  }
  s.levels = [];
  s.gates = {};
  s.guard_rounds = {};
  s.packages = now;
  s.notes = [...s.notes, `the grader's installed packages changed during the climb; its base was measured again on the new state`];
  v.read.clear();
  save(v.dir, s);
  v.io.log("the grader's installed packages changed: measuring the base again on the new state");
  await measureLevels(v);
  await fn();
}

/**
 * Why the card's levels cannot run as chosen, one line each, read from git at
 * the base and the goal's standings and nothing else, so it answers in
 * seconds. Each level: declared at the base at its level, with a dev split
 * and the paths that grade it named in `protects` (a runner imports the
 * product it scores, so only the env's author can say what grades). A dev
 * set in codecast is optional: an env with none runs on its own cases, as
 * every env did before sets existed. A scoring level Confirm runs needs a
 * held set in codecast, and at least one such level must exist. A scoring
 * level must be a score: an env declared `role = "check"` is never climbed.
 * The goal's checks, which the guard runs on every survivor, are held to the
 * same terms.
 */
export function preflight(card: ClimbCard, decls: EnvDeclaration[], standings: readonly EnvStanding[]): string[] {
  const out: string[] = [];
  const terms = (key: string, level: EnvLevel, what: string): EnvDeclaration | null => {
    const d = declOf(decls, key);
    if (!d) { out.push(`${key} (${what}) is not declared in .codecast/envs.toml at the base`); return null; }
    if (d.level !== level) out.push(`${key} (${what}) is declared at ${d.level} at the base, and the goal names it at ${level}`);
    if (!d.splits.includes("dev")) out.push(`${key} (${what}) declares no dev split`);
    if (!d.protects?.length) out.push(`${key} (${what}) declares no protects: name its grader, cases and checks in envs.toml so the climb can hold them still`);
    return d;
  };
  let confirmable = 0;
  for (const l of card.levels) {
    const d = terms(l.env, l.level, l.level === "L0" ? "an L0 check on the card" : `the card's ${l.level} level`);
    if (d && l.level !== "L0" && d.role === "check") { out.push(`${l.env} is a check (role = "check"), not a climb target: climbing it alone trades the score for it. Guard runs it on every survivor; pick a score level`); continue; }
    if (!d || l.level === "L0" || !d.splits.includes("held")) continue;
    if (standings.find((x) => x.env === l.env)?.held) confirmable++;
    else out.push(`${l.env} declares a held split but has no held set in codecast, so Confirm cannot run it (the product's runner puts one with cast env cases put ${l.env} --split held)`);
  }
  if (!confirmable && card.levels.some((l) => l.level !== "L0")) out.push("no scoring level the card names has a held set in codecast, so no gain could be confirmed");
  for (const key of goalChecks(standings, decls)) if (!card.levels.some((l) => l.env === key)) terms(key, standings.find((x) => x.env === key)!.level, "the goal's check, which the guard runs on every survivor");
  return out;
}

/**
 * Base attempts already filed for this env at this base sha on dev, reused
 * instead of run again (the newest env_version's, up to `k`). Only attempts
 * finished before the climb's task was created count, so no station of the
 * climb can file a few quiet base runs to make a noisy level look sharp.
 */
async function reuseBaseRuns(v: View, env: string, k: number): Promise<void> {
  const s = v.s;
  if (!s.reuse_before || Object.keys(s.ledger.done).some((key) => key.startsWith(`base|${env}|dev|`))) return;
  const rows: any[] = await v.io.post("/cli/envs/list", { goal: s.card.goal, env, limit: 50 }, true).catch(() => []);
  const same = (rows ?? []).filter((a) => a?.candidate?.label === "base" && a?.candidate?.sha === s.base && a?.split === "dev" && typeof a?.finished_at === "number" && a.finished_at < s.reuse_before);
  const version = same[0]?.env_version;
  for (const [i, a] of same.filter((x) => x.env_version === version).slice(0, k).entries()) {
    s.ledger.done[`base|${env}|dev|${i}`] = { attempt: a.short_id, reused: true };
    v.io.log(`base ${env} dev: reusing ${a.short_id}`);
  }
}

/** The base cases a candidate is paired against on one level: the mean of its gauge runs, each read back and checked. */
async function baseRuns(v: View, env: string): Promise<EnvCase[][]> {
  const runs: EnvCase[][] = [];
  for (const [key, d] of Object.entries(v.s.ledger.done)) if (key.startsWith(`base|${env}|dev|`)) runs.push((await verified(v, key, d, { env, split: "dev", label: "base", sha: v.s.base })).cases);
  return runs;
}

// ── admit: the candidates Propose made, checked against the diff rules ──

export async function admit(io: ClimbIo, dir: string, proposed: unknown): Promise<ClimbState> {
  const v = await load(io, dir);
  const s = v.s;
  if (!s.candidates.length) {
    const list = Array.isArray(proposed) ? proposed : (proposed as any)?.candidates;
    if (!Array.isArray(list) || !list.length) throw new ClimbStop("Propose made no candidates", STOP.none);
    const seen = new Set<string>();
    const line = (x: unknown, n: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, n);
    s.candidates = list.map((p: any, i: number): Cand => {
      const c: Cand = { id: `cand-${i + 1}`, branch: line(p?.branch, 120), hypothesis: line(p?.hypothesis, 600), status: "admitted", dev: {}, held: {} };
      if (typeof p?.predicted_delta === "number" && Number.isFinite(p.predicted_delta)) c.predicted_delta = p.predicted_delta;
      const bar = (why: string) => { c.barred = why; return c; };
      if (i >= s.card.candidates) return bar(`over the card's ${s.card.candidates} candidates`);
      if (!c.hypothesis) return bar("no hypothesis");
      if (c.predicted_delta === undefined) return bar("no predicted effect on the target");
      const sha = c.branch && tryGit(io.root, ["rev-parse", "--verify", "--quiet", `${c.branch}^{commit}`]);
      if (!sha) return bar(`branch ${c.branch || "(none)"} does not exist`);
      c.sha = sha;
      if (seen.has(sha)) return bar("the same commit as an earlier candidate");
      seen.add(sha);
      const why = inadmissible(io.root, s.base, sha, v.globs);
      return why ? bar(why) : c;
    });
  }
  for (const c of s.candidates) if (c.barred) { c.status = "refused"; c.why = c.barred; }
  save(dir, s);
  for (const c of s.candidates) io.log(`${c.id} ${c.branch}: ${c.status}${c.why ? ` (${c.why})` : ""}`);
  if (!s.candidates.some((c) => !c.barred)) { s.stopped = "every candidate was refused"; save(dir, s); throw new ClimbStop(s.stopped, STOP.none); }
  return s;
}

/** A candidate refused by the review station, with its words. */
export async function refuse(io: ClimbIo, dir: string, id: string, why: string): Promise<ClimbState> {
  const v = await load(io, dir);
  const c = v.s.candidates.find((x) => x.id === id);
  if (!c) throw new ClimbStop(`no candidate ${id}`, STOP.none);
  if (!c.barred) { c.barred = `review: ${why.replace(/\s+/g, " ").slice(0, 300)}`; c.status = "refused"; c.why = c.barred; }
  save(dir, v.s);
  return v.s;
}

// ── screen: successive halving on dev, cheapest level first ──
// Each level runs every live candidate; those that separate from base go on,
// and the better half of them when a dearer dev level follows. Statuses are
// derived afresh from the filed runs every time, never read from the state.

const LEVEL_ORDER = (a: LevelState, b: LevelState) => a.level.localeCompare(b.level) || a.cost_usd - b.cost_usd;
const live = (s: ClimbState) => s.candidates.filter((c) => c.status === "admitted" || c.status === "survivor");
const editsEnv = (k: Cut) => k.why.startsWith("changes the env");

async function cut(v: View, l: LevelState, c: Cand, split: EnvSplit, decl: EnvDeclaration, runs: EnvCase[][], baseVersion: string): Promise<Cut> {
  const base = baseMeanCases(runs);
  const r = await runOnce(v, `${c.id}|${l.env}|${split}`, decl, { label: c.id, split, sha: c.sha! });
  if ("error" in r) return { delta: 0, keep: false, why: r.error.startsWith("GRADER:") ? `changes the env itself: ${r.error.slice(8)}` : `the run failed: ${r.error}` };
  if (r.version !== baseVersion) return { attempt: r.attempt, delta: 0, keep: false, why: `changes the env itself (version ${split === "held" ? "differs" : `${r.version}, base ${baseVersion}`})` };
  const sep = separates(l.level, base, r.cases, { se: l.noise?.se ?? 0 });
  return { attempt: r.attempt, delta: sep.delta.delta, ...(sep.delta.ci95 ? { ci95: sep.delta.ci95 } : {}), keep: sep.keep, why: sep.why, ...changedCases(runs, r.cases) };
}

async function screenView(v: View): Promise<void> {
  const s = v.s;
  for (const c of s.candidates) {
    c.dev = {}; c.held = {}; delete c.guard;
    c.status = c.barred ? "refused" : "admitted";
    c.why = c.barred;
  }
  if (!live(s).length) { s.stopped = "no candidate was left to screen after review"; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
  const order = s.levels.filter((x) => x.kept).sort(LEVEL_ORDER);
  for (const [i, l] of order.entries()) {
    const decl = declOf(v.decls, l.env)!;
    const base = await baseRuns(v, l.env);
    // Halving thins the field for the dearer level above; at the last dev level every candidate that separated goes on to held.
    const ahead = order.slice(i + 1).some((x) => x.level !== "L0");
    const results: Array<{ c: Cand; delta: number }> = [];
    for (const c of live(s)) {
      const k = (c.dev[l.env] = await cut(v, l, c, "dev", decl, base, l.version!));
      save(v.dir, s);
      if (k.keep) results.push({ c, delta: k.delta });
      else { c.status = editsEnv(k) ? "refused" : "dropped"; c.why = `${l.env} dev: ${k.why}`; }
    }
    const go = l.level === "L0" || !ahead ? results : halve(results);
    for (const r of results) if (!go.includes(r)) { r.c.status = "dropped"; r.c.why = `${l.env} dev: ${r.c.dev[l.env].why}, but in the lower half this round`; }
    for (const r of go) r.c.status = "survivor";
    save(v.dir, s);
    if (!live(s).length) { s.stopped = `no candidate separated from base on ${l.env} dev`; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
  }
}

export async function screen(io: ClimbIo, dir: string): Promise<ClimbState> {
  const v = await load(io, dir);
  await withRegauge(v, () => screenView(v));
  return v.s;
}

// ── confirm: survivors on the held split, which no station reads ──

/**
 * Confirm on the held split. Held runs need not repeat (live or inline
 * regrades), so one base run read against candidates run later would count
 * the drift between them as gain. The base runs twice, before and after the
 * candidates, and each candidate is read against the mean of the two with
 * the wider of dev's and the held A/A spread. A candidate whose held change
 * moves many more of its cases than its dev change did is reading the held
 * runs' drift, not its own effect: it is not confirmed.
 */
async function confirmView(v: View): Promise<void> {
  await screenView(v);
  const s = v.s;
  const held = s.levels.filter((l) => l.kept && l.level !== "L0" && l.held).sort(LEVEL_ORDER);
  if (!held.length) { s.stopped = "no level the climb kept has a held split, so no dev gain can be confirmed"; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
  for (const l of held) {
    const decl = declOf(v.decls, l.env)!;
    const baseRun = async (i: number) => {
      const b = await runOnce(v, `base|${l.env}|held|${i}`, decl, { label: "base", split: "held", sha: s.base });
      if ("error" in b) { s.stopped = `the base could not run on ${l.env} held (${HELD_FAILED})`; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
      return b;
    };
    const b0 = await baseRun(0);
    for (const c of live(s)) await runOnce(v, `${c.id}|${l.env}|held`, decl, { label: c.id, split: "held", sha: c.sha! });
    const b1 = await baseRun(1);
    if (b1.version !== b0.version) { s.stopped = `${l.env} reported two versions on the unchanged base's held runs, so its held split cannot confirm anything`; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
    const aa = levelNoise(l.level, [b0.cases, b1.cases]);
    const drift = changedCases([b0.cases], b1.cases);
    const heldLevel: LevelState = { ...l, noise: { ...(l.noise ?? { runs: 0, se: 0, mde: 0 }), se: Math.max(l.noise?.se ?? 0, "error" in aa ? 0 : aa.se) } };
    l.held_aa = { se: "error" in aa ? 0 : aa.se, moved: drift.changed, of: drift.of };
    for (const c of live(s)) {
      const k = (c.held[l.env] = await cut(v, heldLevel, c, "held", decl, [b0.cases, b1.cases], b0.version));
      const dev = c.dev[l.env];
      const ratio = (x?: Cut) => (x?.of ? (x.changed ?? 0) / x.of : 0);
      if (k.keep && dev && ratio(k) > Math.max(3 * ratio(dev), ratio(dev) + 0.1)) {
        k.keep = false;
        k.why = `moved ${k.changed} of ${k.of} held cases against ${dev.changed} of ${dev.of} on dev: the held runs drift (the base moved ${drift.changed} of ${drift.of} between its two held runs), so this reads their noise, not the change`;
        c.status = "dropped";
        c.why = `${l.env} held unreadable: ${k.why}`;
      } else if (!k.keep) {
        c.status = editsEnv(k) ? "refused" : "overfit";
        c.why = c.status === "overfit" ? `${l.env}: dev ${dev ? sign(dev.delta) : "?"}, held ${k.why}` : `${l.env} held: ${k.why}`;
      }
      save(v.dir, s);
    }
  }
  if (!live(s).length) { s.stopped = "no dev gain held up on the held split"; save(v.dir, s); throw new ClimbStop(s.stopped, STOP.none); }
}

export async function confirm(io: ClimbIo, dir: string): Promise<ClimbState> {
  const v = await load(io, dir);
  await withRegauge(v, () => confirmView(v));
  return v.s;
}

// ── guard: the goal's checks (L0 and role = "check") and the product's eval gate on each survivor, best first ──

type CheckVerdict = { verdict: "pass" | "fail" | "void"; why: string };

/**
 * One L0 check, candidate against base, judged on the cases the base scored:
 * a check asks whether the candidate made anything worse than the base, and a
 * case the base has no score on has nothing to be worse than. So cases only
 * the candidate scored (a climb filling empty lists scores more) never hold it,
 * whatever the base's unscored count says (ct-97276). It is void on an outage,
 * a runner that could not run, or a base-scored case unscored on the candidate. A case that got worse, or
 * that the base scored and the candidate dropped with nothing unscored, fails
 * at once. A candidate whose tree changes what grades it fails, never holds.
 */
async function checkVerdict(v: View, c: Cand, d: EnvDeclaration, round: number): Promise<CheckVerdict> {
  const tag = round ? `|r${round}` : "";
  const b = await runOnce(v, `base|${d.key}|dev|${round ? `r${round}` : 0}`, d, { label: "base", split: "dev", sha: v.s.base });
  const k = await runOnce(v, `${c.id}|${d.key}|dev${tag}`, d, { label: c.id, split: "dev", sha: c.sha! });
  if ("error" in k && k.error.startsWith("GRADER:")) return { verdict: "fail", why: `${d.key}: changes the env itself: ${k.error.slice(8)}` };
  if ("error" in b) return { verdict: "void", why: `${d.key}: the base could not run (${b.error})` };
  if ("error" in k) return { verdict: "void", why: `${d.key}: the candidate's run could not run (${k.error})` };
  if (k.version !== b.version) return { verdict: "fail", why: `${d.key}: changes the env itself (version ${k.version}, base ${b.version})` };
  const base = new Map(b.cases.map((x) => [x.id, x.score]));
  const cand = new Map(k.cases.map((x) => [x.id, x.score]));
  const lost = [...base.keys()].filter((id) => !cand.has(id));
  const outside = b.unscored ? `; ${b.unscored} case${b.unscored === 1 ? "" : "s"} the base never scored ${b.unscored === 1 ? "is" : "are"} outside the check` : "";
  if (lost.length && !k.unscored) return { verdict: "fail", why: `${d.key}: ${lost.length} case${lost.length === 1 ? "" : "s"} the base scored and the candidate lost` };
  if (d.level !== "L0") return toleranceVerdict(d, base, cand, lost.length, outside);
  const worse = [...cand].filter(([id, sc]) => base.has(id) && sc < base.get(id)!).map(([id]) => id);
  if (worse.length) return { verdict: "fail", why: `${d.key}: ${worse.length} case${worse.length === 1 ? "" : "s"} worse (${worse.slice(0, 3).join(", ")})` };
  if (lost.length) return { verdict: "void", why: `${d.key}: ${lost.length} case${lost.length === 1 ? "" : "s"} the base scored went unscored on the candidate (${k.unscored} unscored there); the ${base.size - lost.length} both scored agree` };
  return { verdict: "pass", why: `${d.key}: no case worse over the ${base.size} the base scored${outside}` };
}

/**
 * A check above L0 (`role = "check"`): its mean over the cases both sides
 * scored may move the wrong way by at most its tolerance. One that moves
 * further fails; a base-scored case left unscored on the candidate, with no
 * failure, holds the verdict open.
 */
function toleranceVerdict(d: EnvDeclaration, base: Map<string, number>, cand: Map<string, number>, lost: number, outside: string): CheckVerdict {
  const both = [...base.keys()].filter((id) => cand.has(id));
  if (!both.length) return { verdict: "void", why: `${d.key}: no case scored on both sides` };
  const mean = (m: Map<string, number>) => both.reduce((a, id) => a + m.get(id)!, 0) / both.length;
  const delta = mean(cand) - mean(base);
  const wrong = d.direction === "lower" ? delta : -delta;
  const tol = d.tolerance ?? 0;
  const said = `${delta >= 0 ? "+" : ""}${delta.toFixed(3)} over ${both.length} cases`;
  if (wrong > tol + 1e-9) return { verdict: "fail", why: `${d.key}: ${said}, ${wrong.toFixed(3)} the wrong way, past its tolerance ${tol}` };
  if (lost) return { verdict: "void", why: `${d.key}: ${said} within its tolerance, but ${lost} case${lost === 1 ? "" : "s"} the base scored went unscored on the candidate` };
  return { verdict: "pass", why: `${d.key}: ${said}, within its tolerance ${tol}${outside}` };
}

const GATE_WORDS: Record<number, string> = {
  1: "the product's eval gate scored it worse than the base",
  [-2]: "it changes the files the product's eval command starts",
  [-3]: "the product's eval command reaches no script file the climb can hold still (through a package script or directly), so its verdict could be the candidate's own",
};
/** The eval gate's exit read as a verdict: 0 passes, 1 and the climb's own refusals fail, and an unscored gate (exit 2, or no reps written) is void. */
const gateVerdict = (code: number): CheckVerdict => (code === 0 ? { verdict: "pass", why: "the product's eval gate passed" } : GATE_WORDS[code] ? { verdict: "fail", why: GATE_WORDS[code] } : { verdict: "void", why: code === -1 ? "the product's eval command wrote no reps" : "the product's eval gate could not score it" });

async function guardView(v: View, opts: { env?: Record<string, string>; rerunVoid?: boolean }): Promise<void> {
  await confirmView(v);
  const s = v.s;
  delete s.pending;
  // Each check's round: n is current; -(n+1) means round n came back void and waits for a re-run, which moves it to n+1 and files new runs.
  const rounds = (s.guard_rounds ??= {});
  const roundOf = (key: string) => { const r = rounds[key] ?? 0; return r < 0 ? -r - 1 : r; };
  const markVoid = (key: string) => { rounds[key] = -(roundOf(key) + 1); };
  if (opts.rerunVoid) for (const [key, r] of Object.entries(rounds)) if (r < 0) rounds[key] = -r;
  const checks = s.checks.map((k) => declOf(v.decls, k)).filter((d): d is EnvDeclaration => !!d && d.splits.includes("dev"));
  const unheld = checks.filter((d) => !d.protects?.length).map((d) => d.key);
  const command = baseEvalCommand(v.io.root, s.base);
  const heldScore = (c: Cand) => { const x = Object.values(c.held); return x.reduce((a, k) => a + k.delta, 0) / (x.length || 1); };
  for (const c of live(s).sort((a, b) => heldScore(b) - heldScore(a))) {
    const verdicts: CheckVerdict[] = unheld.map((k) => ({ verdict: "fail" as const, why: `${k} declares no protects, so the check itself could be the candidate's` }));
    for (const d of checks) {
      const key = `${c.id}|${d.key}`;
      const r = await checkVerdict(v, c, d, roundOf(key));
      if (r.verdict === "void") markVoid(key);
      verdicts.push(r);
    }
    if (!verdicts.some((x) => x.verdict === "fail") && command) {
      let code = s.gates[c.sha!];
      const key = `${c.id}|gate`;
      if (code === undefined && (rounds[key] ?? 0) < 0) code = 2; // came back void, not re-run yet
      if (code === undefined) {
        // What the eval command starts grades as much as the envs do: the candidate's tree must hold those files as the base does.
        const reach = resolveCommand(v.io.root, s.base, command, { ...process.env, ...opts.env });
        const evalFiles = withDirs(reach.files);
        s.gate_unreached = reach.unresolved;
        if (reach.unresolved.length || !pinsAScript(evalFiles)) code = -3;
        else {
          await stopForBudget(v, 0, `the eval gate on ${c.id}`);
          s.gate_runs = (s.gate_runs ?? Object.keys(s.gates).length) + 1;
          const evalDigest = await v.io.tree(s.base, async (t) => protectedDigest(t, evalFiles));
          const gdir = fs.mkdtempSync(path.join((process.env.TMPDIR || "/tmp").replace(/\/$/, ""), "climb-guard-"));
          code = await v.io.tree(c.sha!, async (tree) => {
            if (protectedDigest(tree, evalFiles) !== evalDigest) return -2;
            // The gate runs the base's copies: the tree's files under $project_path, which hash as the base's.
            const project = reach.project !== undefined ? { project_path: path.join(tree, reach.project) } : {};
            const limit = gateLimitS(v.io.root, s.base, s.gate_ms ?? []);
            const g = await runGate(command, { cwd: tree, env: { ...process.env, ...opts.env, ...project, run_dir: gdir, branch: c.branch, worktree: "" }, limitS: limit.s, log: gateLog(gdir) });
            if (g.timedOut) { (s.gate_stuck ??= {})[c.sha!] = `the eval gate ran past its ${limit.s < 120 ? `${limit.s} second` : `${Math.round(limit.s / 60)} minute`} limit (${limit.from}) and was stopped: ${command}; its last output: ${g.tail}`; return -4; }
            s.gate_ms = [...(s.gate_ms ?? []), g.ms];
            if (!fs.existsSync(path.join(gdir, "reps.json"))) return -1;
            return v.io.evalResult(path.join(gdir, "reps.json"), path.join(gdir, "eval-result.json"));
          });
          fs.rmSync(gdir, { recursive: true, force: true });
        }
        if (gateVerdict(code).verdict === "void") markVoid(key);
        else s.gates[c.sha!] = code;
        save(v.dir, s);
      }
      verdicts.push(code === -4 ? { verdict: "void", why: s.gate_stuck?.[c.sha!] ?? "the eval gate ran past its limit and was stopped" } : code === -3 && s.gate_unreached?.length ? { verdict: "fail", why: `the product's eval command names ${s.gate_unreached.join(", ")}, which the climb could not find at the base under the command's own directories, so it cannot hold the gate still` } : gateVerdict(code));
    }
    const fails = verdicts.filter((x) => x.verdict === "fail").map((x) => x.why);
    const voids = verdicts.filter((x) => x.verdict === "void").map((x) => x.why);
    if (!fails.length && voids.length) {
      // Promotion waits on the best survivor's real verdict: a lesser one is never promoted past a void.
      c.guard = { pass: false, why: `void: ${voids.join("; ")}` };
      c.why = `guard pending: ${voids.join("; ")}`;
      s.pending = `${c.id}'s guard came back void, not a verdict: ${voids.join("; ")}`;
      save(v.dir, s);
      throw new ClimbStop(s.pending, STOP.pending);
    }
    c.guard = fails.length ? { pass: false, why: fails.join("; ") } : { pass: true, why: command ? "the goal's checks and the product's eval gate passed" : `the goal's checks passed${checks.length ? "" : " (none named)"}; the project names no eval command` };
    c.status = fails.length ? "guard_failed" : "promoted";
    if (fails.length) c.why = `guard: ${c.guard.why}`;
    save(v.dir, s);
    v.io.log(`${c.id} guard: ${c.guard.pass ? "pass" : "fail"} (${c.guard.why})`);
    if (c.guard.pass) return;
  }
  s.stopped = "every survivor failed the guard";
  save(v.dir, s);
  throw new ClimbStop(s.stopped, STOP.none);
}

export async function guard(io: ClimbIo, dir: string, opts: { env?: Record<string, string>; rerunVoid?: boolean } = {}): Promise<ClimbState> {
  const v = await load(io, dir);
  await withRegauge(v, () => guardView(v, opts));
  return v.s;
}

/**
 * The promoted change's task, as Promote filed it: a subtask of the climb's
 * task under the climb's goal, recorded once. It is the only task Approve and
 * Drop act on. The promotion itself is replayed from the filed runs first.
 */
export async function bindPromoted(io: ClimbIo, dir: string, task: string, opts: { env?: Record<string, string> } = {}): Promise<ClimbState> {
  const v = await load(io, dir);
  await withRegauge(v, () => guardView(v, opts));
  const s = v.s;
  if (s.promoted_task && s.promoted_task !== task) throw new ClimbStop(`the climb already promoted into ${s.promoted_task}`, STOP.none);
  const t = await io.post("/cli/work/get", { short_id: task }, true).catch(() => null);
  if (!t) throw new ClimbStop(`task ${task} not found`, STOP.none);
  const goal = String(t.goal_ref ?? "").toLowerCase().match(/^in-\d+/)?.[0];
  if (goal !== s.card.goal) throw new ClimbStop(`${task} serves ${t.goal_ref || "no goal"}, not ${s.card.goal}`, STOP.none);
  if (s.task && t.parent?.short_id !== s.task) throw new ClimbStop(`${task} is not a subtask of the climb's task ${s.task} (cast task create --parent ${s.task})`, STOP.none);
  s.promoted_task = task;
  save(dir, s);
  return s;
}

export function setOutcome(dir: string, outcome: string): ClimbState {
  const s = readState(dir) ?? (() => { throw new ClimbStop("no climb state", STOP.none); })();
  s.outcome = outcome.replace(/\s+/g, " ").trim().slice(0, 600);
  save(dir, s);
  return s;
}

const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
export { sign };
