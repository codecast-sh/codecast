// Environments and attempts (pl-1049, ct-96178; design "Goals that agents
// can climb" §4, §7 item 3). A goal names an ordered set of environments at
// levels L0..L5, each a runnable world a product brings: codecast holds the
// declaration's shape (`.codecast/envs.toml` in the product repo), the
// result a runner prints, the attempt record and the goal wiring. Products
// keep their runners.
//
// The result contract is ~/.codecast/goal-envs/plan/env-result-contract.md
// (draft v0). That draft calls the level "rung"; the parser reads either
// "rung" or "level" and every record says level.
//
// Held split: a runner prints ids and scores only. Anything more on a held
// case (a note, the case's text) or an unknown field anywhere in a held
// result is refused, the CLI files each held id as a hash (heldCaseId), the
// version must be a hex hash and the label a name codecast gives, and a held
// result carries no link, so sealed content never reaches the registry.
//
// Trust: the label, sha and repo on an attempt are the filer's word. `cast
// env` only files a `base` for a clean tree at HEAD, but the registry records
// what it is sent; it does not prove it.

export const ENV_LEVELS = ["L0", "L1", "L2", "L3", "L4", "L5"] as const;
export type EnvLevel = (typeof ENV_LEVELS)[number];
export const ENV_LEVEL_NAME: Record<EnvLevel, string> = {
  L0: "Deterministic checks",
  L1: "Behaviour replay",
  L2: "Outcome-labelled replay",
  L3: "Forward simulation",
  L4: "Production experiment",
  L5: "Goal metric",
};
export const isEnvLevel = (x: unknown): x is EnvLevel => typeof x === "string" && (ENV_LEVELS as readonly string[]).includes(x);

export const ENV_SPLITS = ["dev", "held", "fresh"] as const;
export type EnvSplit = (typeof ENV_SPLITS)[number];
export const isEnvSplit = (x: unknown): x is EnvSplit => typeof x === "string" && (ENV_SPLITS as readonly string[]).includes(x);

/** `<product>/<name>`: lower case, digits, dot, dash, underscore. */
export const ENV_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._-]{0,63}$/;
export const isEnvKey = (x: unknown): x is string => typeof x === "string" && ENV_KEY_RE.test(x);
export const envProduct = (key: string): string => key.slice(0, key.indexOf("/"));

/** What a level predicts: `L5:<metric key>` or `L4:<env key>`, any level above. */
export const ENV_LINK_TO_RE = /^L[0-5]:[A-Za-z0-9][A-Za-z0-9._/:-]{0,95}$/;
export const ENV_LINK_MEASURE_RE = /^[a-z][a-z0-9_]{0,31}$/;
export const ENV_LINK_MEASURES = ["auc", "pearson", "rank", "calibration"] as const;

export const ENV_LIMITS = {
  cases_max: 5000,
  case_id_chars: 160,
  note_chars: 200,
  title_chars: 120,
  version_chars: 120,
  label_chars: 60,
  goal_envs_max: 12,
  goal_env_note_chars: 200,
  evidence_chars: 200,
} as const;

/** The short id prefix of an attempt (`ea-N`). */
export const ENV_ATTEMPT_PREFIX = "ea";

export type EnvCase = { id: string; score: number; draws?: number; pass?: boolean | null; note?: string };
export type EnvCandidate = { label: string; sha?: string; prompt_hash?: string };
export type EnvSummary = {
  n: number;
  mean: number;
  ci95?: [number, number];
  unscored?: number;
  baseline?: { label: string; mean: number };
  paired_delta?: number;
  paired_ci95?: [number, number];
};
export type EnvNoise = { aa_sd: number; aa_runs: number };
export type EnvLink = { to: string; measure: string; value: number; n: number; measured_at: number; evidence?: string };

/** One runner's result, read and checked: the contract with times as ms and the level named level. */
export type EnvResult = {
  env: string;
  env_version: string;
  level: EnvLevel;
  candidate: EnvCandidate;
  split: EnvSplit;
  cases: EnvCase[];
  summary: EnvSummary;
  noise?: EnvNoise;
  link?: EnvLink;
  cost_usd?: number;
  started_at: number;
  finished_at: number;
};

const TOP_KEYS = ["env", "env_version", "rung", "level", "candidate", "split", "cases", "summary", "noise", "link", "cost_usd", "started_at", "finished_at"];
const CASE_KEYS = ["id", "score", "draws", "pass", "note"];
const HELD_CASE_KEYS = ["id", "score"];
const SUMMARY_KEYS = ["n", "mean", "ci95", "unscored", "baseline", "paired_delta", "paired_ci95"];
const CANDIDATE_KEYS = ["label", "sha", "prompt_hash"];
const NOISE_KEYS = ["aa_sd", "aa_runs"];
const LINK_KEYS = ["to", "measure", "value", "n", "measured_at", "evidence"];

class ResultError extends Error {}
const fail = (msg: string): never => { throw new ResultError(msg); };
const isObj = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const num = (x: unknown, where: string): number => (typeof x === "number" && Number.isFinite(x) ? x : fail(`${where} must be a number`));
const unit = (x: unknown, where: string): number => { const n = num(x, where); return n >= 0 && n <= 1 ? n : fail(`${where} must be between 0 and 1 (higher is better)`); };
const count = (x: unknown, where: string): number => { const n = num(x, where); return Number.isInteger(n) && n >= 0 ? n : fail(`${where} must be a whole number`); };
const str = (x: unknown, where: string, max: number): string => (typeof x === "string" && x.trim() ? (x.trim().length <= max ? x.trim() : fail(`${where} is over ${max} characters`)) : fail(`${where} must be a non-empty string`));
/** Opaque tokens: what a version, a label, a sha or a held case id may be, so none can carry prose. */
export const ENV_TOKEN_RE = /^[A-Za-z0-9._:\/+-]{1,64}$/;
const HEX_RE = /^[0-9a-f]{4,64}$/i;
const HELD_LABEL_RE = /^(?:base|[a-z]{1,8}-\d{1,9}|[0-9a-f]{7,40})$/;
const HELD_ID_RE = /^h:[0-9a-f]{16}$/;

/**
 * A held case's id as the registry keeps it: a hash, so a sealed case cannot
 * leave in its own name. The same id hashes the same way on every run, so
 * held runs still pair by case.
 */
export async function heldCaseId(env: string, id: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env}\u0000${id}`)));
  return `h:${[...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}
const token = (x: unknown, where: string, re: RegExp = ENV_TOKEN_RE, what = "letters, digits and . _ : / + -, at most 64"): string => {
  const t = str(x, where, 200);
  return re.test(t) ? t : fail(`${where} must be an opaque token (${what}), not text`);
};
const interval = (x: unknown, where: string, lo = -Infinity, hi = Infinity): [number, number] => {
  if (!Array.isArray(x) || x.length !== 2) return fail(`${where} must be [lo, hi]`);
  const a = num(x[0], `${where}[0]`), b = num(x[1], `${where}[1]`);
  if (a < lo || b > hi) fail(`${where} must lie within [${lo}, ${hi}]`);
  return a <= b ? [a, b] : fail(`${where} has lo above hi`);
};
const when = (x: unknown, where: string): number => {
  const ms = typeof x === "number" ? x : typeof x === "string" ? Date.parse(x) : NaN;
  if (!Number.isFinite(ms)) fail(`${where} must be an ISO time`);
  // Epoch seconds read as ms land in 1970.
  return ms >= Date.UTC(2001, 0, 1) ? ms : fail(`${where} is before 2001: give an ISO time or epoch milliseconds`);
};

function keys(obj: Record<string, unknown>, known: readonly string[], where: string, strict: boolean, warnings: string[]): void {
  const bad = Object.keys(obj).filter((k) => !known.includes(k));
  if (!bad.length) return;
  const list = bad.map((k) => `"${k}"`).join(", ");
  if (strict) fail(`${where} has ${bad.length > 1 ? "fields" : "a field"} ${list} a held-split result may not carry (held results print ids and scores only)`);
  warnings.push(`${where}: ignored unknown ${bad.length > 1 ? "fields" : "field"} ${list}`);
}

/**
 * Read a runner's JSON against the contract. `expect` names what the caller
 * asked for (the declared env, its level, the split it ran), and a result that
 * disagrees is refused rather than filed under the wrong name.
 */
export function parseEnvResult(raw: unknown, expect: { env?: string; level?: EnvLevel; split?: EnvSplit; /** The registry's own check: held case ids must already be hashed (heldCaseId). */ heldIdsHashed?: boolean } = {}): { ok: true; result: EnvResult; warnings: string[] } | { ok: false; error: string } {
  const warnings: string[] = [];
  try {
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (err) { fail(`not JSON: ${err instanceof Error ? err.message : String(err)}`); }
    }
    if (!isObj(raw)) fail("the result must be one JSON object");
    const r = raw as Record<string, any>;
    const split = isEnvSplit(r.split) ? r.split : fail(`split must be one of ${ENV_SPLITS.join(", ")}`);
    const held = split === "held";
    keys(r, TOP_KEYS, "the result", held, warnings);
    const env = isEnvKey(r.env) ? r.env : fail(`env must be a key like <product>/<name>, got ${JSON.stringify(r.env)}`);
    if (r.rung !== undefined && r.level !== undefined && r.rung !== r.level) fail(`rung ${r.rung} and level ${r.level} disagree`);
    const levelRaw = r.level ?? r.rung;
    const level = isEnvLevel(levelRaw) ? levelRaw : fail(`level (or rung) must be one of ${ENV_LEVELS.join(", ")}`);
    if (expect.env && env !== expect.env) fail(`the result is for ${env}, but ${expect.env} was run`);
    if (expect.level && level !== expect.level) fail(`the result says ${level}, but ${env} is declared at ${expect.level}`);
    if (expect.split && split !== expect.split) fail(`the result is for the ${split} split, but ${expect.split} was asked for`);
    // Held: the version is a hash and the label a name codecast gives (base, a task id, a sha), so neither can carry words.
    const env_version = held ? token(r.env_version, "env_version", HEX_RE, "a hex hash, on a held split") : token(r.env_version, "env_version");

    if (!isObj(r.candidate)) fail("candidate must be an object with a label");
    keys(r.candidate, CANDIDATE_KEYS, "candidate", held, warnings);
    const candidate: EnvCandidate = { label: held ? token(r.candidate.label, "candidate.label", HELD_LABEL_RE, "base, a short id like ct-12, or a hex sha, on a held split") : token(r.candidate.label, "candidate.label") };
    if (r.candidate.sha !== undefined && r.candidate.sha !== null) candidate.sha = token(r.candidate.sha, "candidate.sha", HEX_RE, "hex").toLowerCase();
    if (r.candidate.prompt_hash !== undefined && r.candidate.prompt_hash !== null) candidate.prompt_hash = token(r.candidate.prompt_hash, "candidate.prompt_hash");

    if (!Array.isArray(r.cases)) fail("cases must be an array (empty when the level has none)");
    if (r.cases.length > ENV_LIMITS.cases_max) fail(`cases has ${r.cases.length} entries, over ${ENV_LIMITS.cases_max}`);
    const seen = new Set<string>();
    const cases: EnvCase[] = r.cases.map((c: unknown, i: number) => {
      const where = `cases[${i}]`;
      if (!isObj(c)) return fail(`${where} must be an object`);
      if (held) {
        const extra = Object.keys(c).filter((k) => !HELD_CASE_KEYS.includes(k));
        if (extra.length) fail(`${where} carries ${extra.map((k) => `"${k}"`).join(", ")}: a held-split case is its id and score only`);
      } else keys(c, CASE_KEYS, where, false, warnings);
      // A held case id is opaque, so a sealed case cannot ride out in its own name.
      const id = !held ? str(c.id, `${where}.id`, ENV_LIMITS.case_id_chars) : expect.heldIdsHashed ? token(c.id, `${where}.id`, HELD_ID_RE, "h: and 16 hex, as cast env files it") : token(c.id, `${where}.id`);
      if (seen.has(id)) fail(`${where}.id "${id}" appears twice`);
      seen.add(id);
      const out: EnvCase = { id, score: unit(c.score, `${where}.score`) };
      if (c.draws !== undefined) { out.draws = count(c.draws, `${where}.draws`); if (out.draws < 1) fail(`${where}.draws must be at least 1`); }
      if (c.pass !== undefined) out.pass = c.pass === null ? null : typeof c.pass === "boolean" ? c.pass : fail(`${where}.pass must be true, false or null`);
      if (c.note !== undefined && c.note !== null) out.note = String(c.note).slice(0, ENV_LIMITS.note_chars);
      return out;
    });

    if (!isObj(r.summary)) fail("summary must be an object with n and mean");
    keys(r.summary, SUMMARY_KEYS, "summary", held, warnings);
    const s = r.summary;
    const summary: EnvSummary = { n: count(s.n, "summary.n"), mean: unit(s.mean, "summary.mean") };
    // Levels below the experiment are scored per case; only L4 and L5 may file a summary alone.
    if (!cases.length && !["L4", "L5"].includes(level)) fail(`${level} results carry their cases; an empty case list is only for L4 and L5`);
    if (cases.length && summary.n !== cases.length) fail(`summary.n is ${summary.n} but cases has ${cases.length} (an unscored case is omitted and counted in summary.unscored)`);
    if (cases.length) {
      const m = cases.reduce((a, c) => a + c.score, 0) / cases.length;
      if (Math.abs(m - summary.mean) > 0.005) fail(`summary.mean ${summary.mean} is not the mean of the case scores (${m.toFixed(4)})`);
    }
    if (s.ci95 !== undefined && s.ci95 !== null) summary.ci95 = interval(s.ci95, "summary.ci95", 0, 1);
    // With cases, the interval is the one they imply, whatever the runner said.
    if (cases.length > 1) { const m = meanWithCi(cases.map((c) => c.score)); if (m.ci95) summary.ci95 = m.ci95; }
    if (s.unscored !== undefined && s.unscored !== null) { summary.unscored = count(s.unscored, "summary.unscored"); if (summary.unscored > ENV_LIMITS.cases_max) fail(`summary.unscored is over ${ENV_LIMITS.cases_max}`); }
    if (s.baseline !== undefined && s.baseline !== null) {
      if (!isObj(s.baseline)) fail("summary.baseline must be { label, mean }");
      keys(s.baseline, ["label", "mean"], "summary.baseline", held, warnings);
      summary.baseline = { label: token(s.baseline.label, "summary.baseline.label"), mean: unit(s.baseline.mean, "summary.baseline.mean") };
    }
    if (s.paired_delta !== undefined && s.paired_delta !== null) { summary.paired_delta = num(s.paired_delta, "summary.paired_delta"); if (Math.abs(summary.paired_delta) > 1) fail("summary.paired_delta must lie within [-1, 1]"); }
    if (s.paired_ci95 !== undefined && s.paired_ci95 !== null) summary.paired_ci95 = interval(s.paired_ci95, "summary.paired_ci95", -1, 1);

    const result: EnvResult = { env, env_version, level, candidate, split, cases, summary, started_at: when(r.started_at, "started_at"), finished_at: when(r.finished_at, "finished_at") };
    if (result.finished_at < result.started_at) fail("finished_at is before started_at");
    if (r.noise !== undefined && r.noise !== null) {
      if (!isObj(r.noise)) fail("noise must be { aa_sd, aa_runs }");
      keys(r.noise, NOISE_KEYS, "noise", held, warnings);
      result.noise = { aa_sd: num(r.noise.aa_sd, "noise.aa_sd"), aa_runs: count(r.noise.aa_runs, "noise.aa_runs") };
      if (result.noise.aa_sd < 0) fail("noise.aa_sd must not be negative");
    }
    if (r.link !== undefined && r.link !== null) {
      if (held) fail("a held-split result carries no link: record it with cast env link");
      result.link = parseEnvLink(r.link, "link", held, warnings, level);
    }
    if (!cases.length && summary.ci95 && (summary.mean < summary.ci95[0] || summary.mean > summary.ci95[1])) fail(`summary.mean ${summary.mean} lies outside its ci95 [${summary.ci95.join(", ")}]`);
    if (r.cost_usd !== undefined && r.cost_usd !== null) { result.cost_usd = num(r.cost_usd, "cost_usd"); if (result.cost_usd < 0) fail("cost_usd must not be negative"); }
    return { ok: true, result, warnings };
  } catch (err) {
    if (err instanceof ResultError) return { ok: false, error: err.message };
    throw err;
  }
}

function parseEnvLink(x: unknown, where: string, strict: boolean, warnings: string[], from?: EnvLevel): EnvLink {
  if (!isObj(x)) return fail(`${where} must be { to, measure, value, n, measured_at }`);
  keys(x, LINK_KEYS, where, strict, warnings);
  const to = typeof x.to === "string" && ENV_LINK_TO_RE.test(x.to.trim()) ? x.to.trim() : fail(`${where}.to must be <level>:<metric or env>, like L4:matched_to_opted_in`);
  if (from && Number(to[1]) <= Number(from[1])) fail(`${where}.to names ${to.slice(0, 2)}, which is not above ${from}`);
  const measure = typeof x.measure === "string" && ENV_LINK_MEASURE_RE.test(x.measure) ? x.measure : fail(`${where}.measure must be a word like ${ENV_LINK_MEASURES.join(", ")}`);
  const link: EnvLink = { to, measure, value: num(x.value, `${where}.value`), n: count(x.n, `${where}.n`), measured_at: x.measured_at === undefined ? Date.now() : when(x.measured_at, `${where}.measured_at`) };
  // Evidence names a thing (ea-N, doc:abc, a session id); it never describes it.
  if (x.evidence !== undefined && x.evidence !== null) link.evidence = token(x.evidence, `${where}.evidence`);
  return link;
}

/** A link as typed by hand (`cast env link`), checked the same way a runner's is. */
export function readEnvLink(x: unknown, from?: EnvLevel): { ok: true; link: EnvLink } | { ok: false; error: string } {
  try { return { ok: true, link: parseEnvLink(x, "link", false, [], from) }; } catch (err) {
    if (err instanceof ResultError) return { ok: false, error: err.message };
    throw err;
  }
}

// ── cases, stored compactly ──

/** Cases as stored: `[id, score]`, then draws, pass and note when present. */
export type CompactCase = [string, number, number?, (boolean | null)?, string?];
export function compactCases(cases: readonly EnvCase[]): CompactCase[] {
  return cases.map((c) => {
    const row: CompactCase = [c.id, c.score];
    if (c.draws !== undefined || c.pass !== undefined || c.note !== undefined) row.push(c.draws ?? 1);
    if (c.pass !== undefined || c.note !== undefined) row.push(c.pass ?? null);
    if (c.note !== undefined) row.push(c.note);
    return row;
  });
}
export function expandCases(rows: readonly CompactCase[]): EnvCase[] {
  return rows.map(([id, score, draws, pass, note]) => ({ id, score, ...(draws !== undefined ? { draws } : {}), ...(pass !== undefined ? { pass } : {}), ...(note !== undefined ? { note } : {}) }));
}

// ── statistics ──

// Two-sided 95% t quantiles for df 1..30; past 30 the normal 1.96.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
const t95 = (df: number): number => (df < 1 ? NaN : df <= 30 ? T95[df - 1] : 1.96);
const round = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * The mean of a set of scores with its 95% interval: Wilson when every score
 * is 0 or 1 (a pass rate, where all-pass must not read as certain), else t,
 * so small sets read wide.
 */
export function meanWithCi(values: readonly number[], bounds: [number, number] = [0, 1]): { n: number; mean: number; ci95?: [number, number] } {
  const n = values.length;
  if (!n) return { n: 0, mean: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean: round(mean) };
  if (bounds[0] === 0 && values.every((v) => v === 0 || v === 1)) {
    const z = 1.96, d = 1 + z * z / n, c = (mean + z * z / (2 * n)) / d, h = z * Math.sqrt(mean * (1 - mean) / n + z * z / (4 * n * n)) / d;
    return { n, mean: round(mean), ci95: [round(Math.max(0, c - h)), round(Math.min(1, c + h))] };
  }
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = t95(n - 1) * sd / Math.sqrt(n);
  return { n, mean: round(mean), ci95: [round(Math.max(bounds[0], mean - half)), round(Math.min(bounds[1], mean + half))] };
}

/** Candidate against base on the cases both scored, by id: the per-case difference and its interval. */
export type PairedDelta = { n: number; delta: number; ci95?: [number, number]; worse: number; better: number; only_base: number; only_candidate: number };
export function pairedDelta(base: readonly EnvCase[], cand: readonly EnvCase[]): PairedDelta {
  const b = new Map(base.map((c) => [c.id, c.score]));
  const diffs: number[] = [];
  let onlyCand = 0;
  for (const c of cand) {
    const s = b.get(c.id);
    if (s === undefined) onlyCand++;
    else diffs.push(c.score - s);
  }
  const m = meanWithCi(diffs, [-1, 1]);
  return { n: m.n, delta: m.mean, ...(m.ci95 ? { ci95: m.ci95 } : {}), worse: diffs.filter((x) => x < 0).length, better: diffs.filter((x) => x > 0).length, only_base: base.length - diffs.length, only_candidate: onlyCand };
}

/**
 * A paired delta as one phrase: "+0.031 [-0.004, +0.066] over 120 cases, within noise".
 * At L0 a run has no noise, so any case that got worse makes the change worse.
 */
export function deltaPhrase(d: { n: number; delta: number; ci95?: [number, number]; worse?: number; better?: number; only_base?: number }, noiseSd?: number, level?: EnvLevel): string {
  const sign = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
  const ci = d.ci95 ? ` [${sign(d.ci95[0])}, ${sign(d.ci95[1])}]` : "";
  const dropped = d.only_base ? `; ${d.only_base} base case${d.only_base === 1 ? "" : "s"} missing on the branch` : "";
  const moved = (d.worse !== undefined && (d.worse || d.better) ? `; ${d.worse} case${d.worse === 1 ? "" : "s"} worse, ${d.better} better` : "") + dropped;
  if (level === "L0" && d.worse !== undefined) return `${sign(d.delta)}${ci} over ${d.n} case${d.n === 1 ? "" : "s"}, ${d.worse || d.only_base ? "worse" : d.better ? "better" : "unchanged"}${moved}`;
  const word = !d.ci95 ? "too few cases to say" : d.ci95[0] > 0 ? "better" : d.ci95[1] < 0 ? "worse" : "within noise";
  const aa = noiseSd !== undefined && Math.abs(d.delta) < 2 * noiseSd && word !== "within noise" ? ` (inside 2x the A/A spread ${noiseSd.toFixed(3)})` : "";
  return `${sign(d.delta)}${ci} over ${d.n} case${d.n === 1 ? "" : "s"}, ${word}${aa}${moved}`;
}

// ── declaration (.codecast/envs.toml), shape only; the CLI loads it ──

export const ENVS_REL_PATH = ".codecast/envs.toml";
/** Placeholders a command may name; each is shell-quoted when filled. */
export const ENV_COMMAND_VARS = ["candidate", "split", "out", "sha", "root"] as const;
export type EnvDeclaration = {
  key: string;
  title: string;
  level: EnvLevel;
  command: string;
  splits: EnvSplit[];
  /** The declared cost of one run, in dollars. */
  cost_usd?: number;
  /** What it predicts: `L5:<metric key>` or `<level>:<env key>`. */
  predicts?: string;
  /** How long one run may take before it is stopped, in seconds. */
  timeout_s?: number;
};

// ── a goal's environments ──

export type GoalEnv = { env: string; level: EnvLevel; note?: string };

/** `L2=union/replay` read into one entry; a bare key takes the level from `declared`. */
export function parseGoalEnvSpec(text: string, declared?: (key: string) => EnvLevel | undefined): GoalEnv | { error: string } {
  const m = text.trim().match(/^(?:(L[0-5])=)?(\S+)$/);
  if (!m) return { error: `"${text}" is not L<n>=<env key>` };
  const level = (m[1] as EnvLevel | undefined) ?? declared?.(m[2]);
  if (!level) return { error: `"${text}" names no level: write L<n>=${m[2]}` };
  if (!isEnvKey(m[2])) return { error: `"${m[2]}" is not an env key (<product>/<name>)` };
  return { env: m[2], level };
}

/** A goal's environment list, checked and ordered by level (stable inside a level). */
export function normalizeGoalEnvs(list: readonly GoalEnv[]): GoalEnv[] | { error: string } {
  if (list.length > ENV_LIMITS.goal_envs_max) return { error: `a goal names at most ${ENV_LIMITS.goal_envs_max} environments` };
  const seen = new Set<string>();
  const out: GoalEnv[] = [];
  for (const e of list) {
    if (!isEnvKey(e.env)) return { error: `"${e.env}" is not an env key (<product>/<name>)` };
    if (!isEnvLevel(e.level)) return { error: `"${e.level}" is not a level (L0..L5)` };
    if (seen.has(e.env)) return { error: `${e.env} is named twice` };
    seen.add(e.env);
    const note = e.note?.trim().slice(0, ENV_LIMITS.goal_env_note_chars);
    out.push({ env: e.env, level: e.level, ...(note ? { note } : {}) });
  }
  return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.level.localeCompare(b.e.level) || a.i - b.i).map((x) => x.e);
}

// ── standing: an env's latest attempt and link, as the goal reads it ──

export type EnvStanding = {
  env: string;
  level: EnvLevel;
  note?: string;
  title?: string;
  attempt?: {
    short_id: string;
    candidate: EnvCandidate;
    split: EnvSplit;
    n: number;
    mean: number;
    ci95?: [number, number];
    noise?: EnvNoise;
    cost_usd?: number;
    finished_at: number;
  };
  link?: EnvLink;
};

const pct = (x: number) => x.toFixed(3);
export function standingScore(s: EnvStanding): string {
  const a = s.attempt;
  if (!a) return "no attempt yet";
  return `${pct(a.mean)}${a.ci95 ? ` [${pct(a.ci95[0])}, ${pct(a.ci95[1])}]` : ""} n=${a.n}`;
}
export const standingNoise = (s: EnvStanding): string | null => (s.attempt?.noise ? `A/A sd ${s.attempt.noise.aa_sd.toFixed(3)} over ${s.attempt.noise.aa_runs} run${s.attempt.noise.aa_runs === 1 ? "" : "s"}` : null);
export const standingLink = (s: EnvStanding, ago: (at: number) => string): string | null => (s.link ? `${s.link.measure} ${s.link.value.toFixed(2)} to ${s.link.to} (n=${s.link.n}, ${ago(s.link.measured_at)})` : null);
export const standingCost = (s: EnvStanding): string | null => (s.attempt?.cost_usd !== undefined ? `$${s.attempt.cost_usd < 1 ? s.attempt.cost_usd.toFixed(2) : s.attempt.cost_usd.toFixed(0)}` : null);
