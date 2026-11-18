// The climb (pl-1049, ct-96183; design "Goals that agents can climb" §4, and
// docs/architecture/flows.md FL10): an agent hill-climbs one goal metric
// through the goal's environments, wide and cheap at the bottom, one
// candidate at the top. This module holds the rules the climb's scripts
// enforce, so no agent station can bend them: the caps on what a card may
// ask for, which levels can see one change, what counts as separating from
// base, what a candidate may touch, and how long a production test needs.
// The flow is packages/cli/src/workflow/templates/climb.cast; the commands
// are packages/cli/src/climbCommand.ts.
import { pairedDelta, type EnvCase, type EnvLevel, type PairedDelta, isEnvLevel } from "./envs";
import { MDE_WEEKS, minimumDetectableLift, parseMetricNoise } from "./metricStanding";

/** What a climb may spend when the goal states no budget of its own. A card may ask for less, never more. */
export const CLIMB_DEFAULT_BUDGET = { usd: 25, runs: 60 } as const;
/** How many candidates one climb proposes by default, and at most. */
export const CLIMB_CANDIDATES = { default: 5, max: 8 } as const;
/**
 * The largest effect one change is taken to have on a 0..1 env score, whatever
 * a card claims: a level that cannot see a move this size cannot see any one
 * change, and a card cannot argue a level back in by claiming a bigger effect.
 */
export const CLIMB_PLAUSIBLE_MAX = 0.1;
/** Base runs per level that measure the A/A spread (L0 is deterministic and runs once). */
export const CLIMB_AA_RUNS = 3;
/** 80% power at two-sided 5%. */
const MDE_Z = 1.959964 + 0.841621;
/** A level the climb screens on: dev at L0..L3. L4 and L5 are production; they are what Promote proposes, never what a climb runs. */
export const CLIMB_LEVELS: readonly EnvLevel[] = ["L0", "L1", "L2", "L3"];
/** The longest production test Promote will propose, in weeks. */
export const CLIMB_EXPERIMENT_MAX_WEEKS = 26;

export type ClimbBudget = { usd: number; runs: number };
export type ClimbCardLevel = { env: string; level: EnvLevel; plausible_effect?: number };
export type ClimbCard = {
  goal: string;
  metric?: string;
  target: string;
  levels: ClimbCardLevel[];
  budget: ClimbBudget;
  candidates: number;
  hypotheses: string[];
};

const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const posNum = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : null);

/**
 * A card as Frame wrote it, checked and held to the climb's caps: the budget
 * is the smaller of the card's and the goal's (the default when the goal has
 * none), the candidate count at most the max, and only levels the goal names
 * at L0..L3. What the caps changed is said in `notes`.
 */
export function readClimbCard(raw: unknown, goal: { short_id: string; budget?: Partial<ClimbBudget> | null; levels: ReadonlyArray<{ env: string; level: EnvLevel }> }): { ok: true; card: ClimbCard; notes: string[] } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "the card is not a JSON object" };
  const notes: string[] = [];
  const target = typeof raw.target === "string" ? raw.target.trim() : "";
  if (!target) return { ok: false, error: "the card names no target: what the climb moves and why it has the most headroom" };
  if (!Array.isArray(raw.levels) || !raw.levels.length) return { ok: false, error: "the card names no levels" };
  const levels: ClimbCardLevel[] = [];
  for (const l of raw.levels) {
    if (!isObj(l) || typeof l.env !== "string") return { ok: false, error: "each level is {env, level, plausible_effect}" };
    const named = goal.levels.find((g) => g.env === l.env);
    if (!named) return { ok: false, error: `${l.env} is not one of ${goal.short_id}'s environments (cast goal envs ${goal.short_id})` };
    if (!CLIMB_LEVELS.includes(named.level)) return { ok: false, error: `${l.env} is at ${named.level}; a climb runs on L0..L3, and L4/L5 are what it proposes` };
    if (l.level !== undefined && (!isEnvLevel(l.level) || l.level !== named.level)) return { ok: false, error: `${l.env} is at ${named.level} on the goal, not ${l.level}` };
    if (levels.some((x) => x.env === l.env)) return { ok: false, error: `${l.env} is named twice` };
    const said = posNum(l.plausible_effect);
    if (named.level !== "L0" && said === null) return { ok: false, error: `${l.env}: say the plausible effect of one change on its score (0..1), so the climb can check the level can see it` };
    levels.push({ env: l.env, level: named.level, ...(said !== null ? { plausible_effect: said } : {}) });
  }
  if (!levels.some((l) => l.level !== "L0")) return { ok: false, error: "the card names only L0 checks; a climb needs a level that scores" };
  const goalBudget = { usd: posNum(goal.budget?.usd) ?? CLIMB_DEFAULT_BUDGET.usd, runs: posNum(goal.budget?.runs) ?? CLIMB_DEFAULT_BUDGET.runs };
  const asked = isObj(raw.budget) ? raw.budget : {};
  const budget = { usd: Math.min(posNum(asked.usd) ?? goalBudget.usd, goalBudget.usd), runs: Math.floor(Math.min(posNum(asked.runs) ?? goalBudget.runs, goalBudget.runs)) };
  if ((posNum(asked.usd) ?? 0) > goalBudget.usd || (posNum(asked.runs) ?? 0) > goalBudget.runs) notes.push(`budget held to ${goal.budget ? "the goal's ceiling" : "the default"} $${goalBudget.usd} and ${goalBudget.runs} runs`);
  const askedN = posNum(raw.candidates);
  const candidates = Math.min(Math.floor(askedN ?? CLIMB_CANDIDATES.default), CLIMB_CANDIDATES.max);
  if (askedN !== null && askedN > CLIMB_CANDIDATES.max) notes.push(`candidates held to ${CLIMB_CANDIDATES.max}`);
  const hypotheses = Array.isArray(raw.hypotheses) ? raw.hypotheses.filter((h: unknown): h is string => typeof h === "string" && !!h.trim()).map((h: string) => h.trim().slice(0, 400)) : [];
  const metric = typeof raw.metric === "string" && raw.metric.trim() ? raw.metric.trim() : undefined;
  return { ok: true, card: { goal: goal.short_id, ...(metric ? { metric } : {}), target: target.slice(0, 600), levels, budget, candidates, hypotheses }, notes };
}

// ── noise and what a level can see ──

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const sd = (xs: readonly number[]) => (xs.length < 2 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - mean(xs)) ** 2, 0) / (xs.length - 1)));

/** Each case's mean over several base runs: the base a candidate is paired against. */
export function baseMeanCases(runs: ReadonlyArray<readonly EnvCase[]>): EnvCase[] {
  const by = new Map<string, number[]>();
  for (const r of runs) for (const c of r) by.set(c.id, [...(by.get(c.id) ?? []), c.score]);
  return [...by].map(([id, s]) => ({ id, score: mean(s) }));
}

export type LevelNoise = {
  /** Base runs the spread was read from. */
  runs: number;
  /** Standard error of one candidate run's mean delta against the base mean, from run-to-run noise alone. */
  se: number;
  /** The smallest delta this level detects at 80% power, two-sided 5%. */
  mde: number;
};

/**
 * What a level can see, from base runs of the unchanged tree. Two base runs
 * paired case by case show how much a case's score moves with nothing
 * changed; the spread of the runs' means shows a shift that moves every case
 * together (a judge or a model drifting between runs), which pairing cancels.
 * One candidate run against the mean of `runs` base runs carries each spread
 * once from its side and 1/runs from the base's. The runner's own A/A spread
 * of the mean, when it reports one, is taken if larger. L0 is deterministic:
 * one run, no spread, and any case that gets worse counts.
 */
export function levelNoise(level: EnvLevel, runs: ReadonlyArray<readonly EnvCase[]>, reportedAaSd?: number): LevelNoise | { error: string } {
  if (level === "L0") return { runs: runs.length, se: 0, mde: 0 };
  if (runs.length < 2 && !(reportedAaSd && reportedAaSd > 0)) return { error: `one base run cannot show the spread; ${CLIMB_AA_RUNS} are needed` };
  const k = runs.length;
  const both = Math.sqrt(1 + 1 / Math.max(1, k));
  let fromCases = 0;
  if (k >= 2) {
    const pairSds: number[] = [];
    for (let i = 1; i < k; i++) {
      const prev = new Map(runs[i - 1].map((c) => [c.id, c.score]));
      const diffs = runs[i].flatMap((c) => (prev.has(c.id) ? [c.score - prev.get(c.id)!] : []));
      if (diffs.length) pairSds.push(sd(diffs) / Math.SQRT2);
    }
    const n = Math.max(1, mean(runs.map((r) => r.length)));
    fromCases = (mean(pairSds) * both) / Math.sqrt(n);
  }
  const fromMeans = k >= 2 ? sd(runs.map((r) => mean(r.map((c) => c.score)))) * both : 0;
  const fromRunner = (reportedAaSd ?? 0) * both;
  const se = Math.max(Math.sqrt(fromCases ** 2 + fromMeans ** 2), fromRunner);
  return { runs: k, se: round(se), mde: round(MDE_Z * se) };
}

/** Whether a level can see one change: its MDE no larger than the card's plausible effect, held to CLIMB_PLAUSIBLE_MAX. */
export function levelCanSee(level: EnvLevel, noise: LevelNoise, plausible?: number): { ok: boolean; why: string } {
  if (level === "L0") return { ok: true, why: "deterministic: any case that gets worse counts" };
  const bar = Math.min(plausible ?? CLIMB_PLAUSIBLE_MAX, CLIMB_PLAUSIBLE_MAX);
  const capped = (plausible ?? 0) > CLIMB_PLAUSIBLE_MAX ? ` (the card said ${f(plausible!)}; one change is held to ${f(CLIMB_PLAUSIBLE_MAX)})` : "";
  return noise.mde <= bar
    ? { ok: true, why: `MDE ${f(noise.mde)} over ${noise.runs} base runs, within the plausible ${f(bar)}${capped}` }
    : { ok: false, why: `MDE ${f(noise.mde)} over ${noise.runs} base runs is larger than the plausible ${f(bar)}${capped}: this level cannot see one change` };
}

// ── separating from base ──

export type Separation = { keep: boolean; delta: PairedDelta; why: string };

/**
 * A candidate against the base mean on one level. L0: no case worse and none
 * lost. Above: the paired interval's lower bound clears 0 and the delta
 * clears the level's run-to-run band (1.96 se), so neither case sampling nor
 * a lucky draw passes it. Cases the candidate lost count against it.
 */
export function separates(level: EnvLevel, base: readonly EnvCase[], cand: readonly EnvCase[], noise: Pick<LevelNoise, "se">): Separation {
  const d = pairedDelta(base, cand);
  if (level === "L0") {
    const keep = d.worse === 0 && d.only_base === 0 && d.n > 0;
    return { keep, delta: d, why: keep ? `no case worse over ${d.n}` : d.n === 0 ? "no case scored" : `${d.worse} case${d.worse === 1 ? "" : "s"} worse${d.only_base ? `, ${d.only_base} lost` : ""}` };
  }
  if (d.only_base) return { keep: false, delta: d, why: `${d.only_base} base case${d.only_base === 1 ? "" : "s"} missing from the candidate's run` };
  if (!d.ci95) return { keep: false, delta: d, why: `too few cases to say (${d.n})` };
  const band = 1.959964 * noise.se;
  if (d.ci95[0] <= 0) return { keep: false, delta: d, why: `${s(d.delta)} [${s(d.ci95[0])}, ${s(d.ci95[1])}]: lower bound does not clear 0` };
  if (d.delta <= band) return { keep: false, delta: d, why: `${s(d.delta)} is inside the A/A band ±${f(band)}` };
  return { keep: true, delta: d, why: `${s(d.delta)} [${s(d.ci95[0])}, ${s(d.ci95[1])}] over ${d.n} cases, past the A/A band ±${f(band)}` };
}

/** Successive halving: of the candidates that separated, the better half by delta go on (at least one). */
export function halve<T extends { delta: number }>(kept: readonly T[]): T[] {
  return [...kept].sort((a, b) => b.delta - a.delta).slice(0, Math.max(1, Math.ceil(kept.length / 2)));
}

// ── what a candidate may touch ──

/**
 * Paths no candidate may change in any repo: the env and line declarations,
 * checkout attributes (a filter or encoding rewrites a protected file's bytes
 * without showing in the diff), submodules, and committed node_modules (which
 * shadow the packages a grader imports).
 */
export const CLIMB_ALWAYS_PROTECTED = [".codecast/**", "**/.gitattributes", ".gitmodules", "**/node_modules/**"];

/**
 * The repo paths a command names (`bun {root}/evals/run.ts`, `scripts/env.sh`):
 * the runner a declaration or an eval command starts is as much the grader as
 * the files it protects. A package script (`bun run eval`, `npm test`) names
 * the package.json that defines it, and `make` its Makefile. `root` turns an
 * absolute path inside the repo (a `$project_path` already filled in) into a
 * repo path. Returns candidate paths; the caller keeps those that exist at
 * the base.
 */
export function commandPaths(command: string, root?: string): string[] {
  const out = new Set<string>();
  const dirs = [""];
  const inRepo = (t: string) => (root && t.startsWith(`${root.replace(/\/$/, "")}/`) ? t.slice(root.replace(/\/$/, "").length + 1) : t);
  const tokens = command.split(/[\s;|&()<>]+/).map((t) => inRepo(t.replace(/^['"]|['"]$/g, "")).replace(/^\{root\}\/?/, "").replace(/^\.\//, ""));
  const add = (t: string) => { for (const d of dirs) out.add(d ? `${d}/${t}` : t); };
  tokens.forEach((t, i) => {
    if (tokens[i - 1] === "cd" && t && !t.startsWith("/") && !/[{}$]/.test(t)) { dirs.push(t.replace(/\/$/, "")); return; }
    // `bun run <file>` runs the file (picked up below); `bun run <name>` and `npm test` run a package script.
    if (/^(npm|bun|pnpm|yarn)$/.test(tokens[i - 1] ?? "") && /^(run|test|run-script)$/.test(t)) { if (t === "test" || !/[/.]/.test(tokens[i + 1] ?? "")) add("package.json"); return; }
    if (t === "make") { add("Makefile"); return; }
    if (!t || t.startsWith("-") || t.startsWith("/") || t.startsWith("$") || /[{}=*]/.test(t)) return;
    if (!t.includes("/") && !/\.(m?[jt]sx?|py|sh|rb|json|toml|ya?ml)$/.test(t)) return;
    add(t);
  });
  return [...out];
}

/** A glob over repo paths: `**` any depth, `*` within one segment. */
export function globMatch(glob: string, file: string): boolean {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\0/g, ".*");
  return new RegExp(`^${re}$`).test(file.replace(/^\.\//, ""));
}

/** The changed files a candidate may not touch: the graders, cases, held data and checks the envs protect, and `.codecast/`. */
export function protectedTouches(files: readonly string[], protects: readonly string[]): string[] {
  const globs = [...CLIMB_ALWAYS_PROTECTED, ...protects];
  return files.filter((f) => globs.some((g) => globMatch(g, f)));
}

// ── the production step ──

/**
 * What a 50/50 production test of `weeks` detects on a goal metric, from the
 * one reading every surface shows: its window's MDE over MDE_WEEKS
 * (metricStanding readWindow), which already carries the pooling, the
 * cohort periods and the wider of the model's and the observed spread. A
 * count or a ratio reads as the Poisson count with that same MDE (the ratio
 * is read that way there too), run for longer through the same
 * minimumDetectableLift; a measured spread or a share scales with the
 * square root of the time. Null when the reading has no MDE.
 */
export function detectableAt(mde4: number | null, noise: string | undefined, weeks: number): number | null {
  if (mde4 === null || !Number.isFinite(mde4) || !(mde4 > 0) || !(weeks > 0)) return null;
  const kind = parseMetricNoise(noise)?.kind;
  if (kind !== "poisson" && kind !== "ratio") return mde4 * Math.sqrt(MDE_WEEKS / weeks);
  // The count a period whose MDE over MDE_WEEKS periods is mde4 (the lift falls as the count grows).
  let lo = 1e-9, hi = 1e12;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(lo * hi);
    if ((minimumDetectableLift(mid, { kind: "poisson" }, MDE_WEEKS) ?? Infinity) > mde4) lo = mid; else hi = mid;
  }
  return minimumDetectableLift(hi, { kind: "poisson" }, weeks);
}

/** The fewest whole weeks a 50/50 test needs to detect `lift` (0.08 = 8%), or null past CLIMB_EXPERIMENT_MAX_WEEKS or without an MDE. */
export function experimentWeeks(mde4: number | null, noise: string | undefined, lift: number): number | null {
  if (!(lift > 0)) return null;
  for (let w = 1; w <= CLIMB_EXPERIMENT_MAX_WEEKS; w++) {
    const d = detectableAt(mde4, noise, w);
    if (d === null) return null;
    if (d <= lift) return w;
  }
  return null;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const f = (x: number) => x.toFixed(3);
const s = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
