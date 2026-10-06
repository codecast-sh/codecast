// The neutral wire contract every product's eval views share: the primitives,
// the index row (RunRowCore) and the analysis shapes. A product's own row is
// RunRowCore plus its fields (codecast: RunRow = RunRowCore & CodecastRunFields).
// PURE isomorphic data: no Node or DOM APIs, no imports outside this folder.

import type { EvalFlip, EvalRunSet, EvalSeparation } from "./evalResult";

// ── Primitives ──────────────────────────────────────────────────────────────

export type EvalRoute = "call" | "agent";

/** A freeze committed with the product (public) or kept on the machine that ran it (private). */
export type EvalVisibility = "public" | "private";

/** A rep's status in the index. `dry` ran on canned output and graded nothing; `unscored` has no score yet. */
export type RunRowStatus = "pass" | "fail" | "crash" | "dry" | "unscored";

/** What a rep is weighed on: the model it answered on and the judge's ruler. */
export interface Footing {
  model: string | null;
  ruler: string | null;
}

/** A sha the api accepts. */
export const EVALS_SHA_RE = /^[0-9a-f]{7,40}$/;
/** A batch named by when it ran, as `./evals check` names one by default: an ISO stamp, safe to carry anywhere. */
export const EVALS_STAMP_BATCH_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
/** A batch named by its hash (evalsBatchRef): `_` and 8 hex digits, none of which a query string escapes. */
export const EVALS_BATCH_TOKEN_RE = /^_[0-9a-f]{8}$/;

/** FNV-1a over the string's UTF-16 units, as 8 hex digits: stable on every party, no crypto needed to keep a name out of an address. */
function fnv8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * How an address names a batch or an endpoint (a batch or a sha). A stamp, a
 * sha or a token stands as itself; any other batch name is a label someone
 * chose, which may say what the batch was about, so the address carries its
 * hash instead (`_1a2b3c4d`). Addresses can reach places that persist and
 * sync (codecast's tab list), and only identifiers may go there.
 */
export function evalsBatchRef(batch: string): string;
export function evalsBatchRef(batch: string | null | undefined): string | null;
export function evalsBatchRef(batch: string | null | undefined): string | null {
  if (!batch) return null;
  if (EVALS_STAMP_BATCH_RE.test(batch) || EVALS_SHA_RE.test(batch) || EVALS_BATCH_TOKEN_RE.test(batch)) return batch;
  return `_${fnv8(batch)}`;
}

/** The batch an address names, among the names a reader knows: a token is looked up by its hash, anything else stands as itself. Null for a token none of them hashes to. */
export function resolveEvalsBatchRef(ref: string, names: Iterable<string>): string | null {
  if (!EVALS_BATCH_TOKEN_RE.test(ref)) return ref;
  for (const n of names) if (evalsBatchRef(n) === ref) return n;
  return null;
}

/** A tree patch's name: the sha256 of its text (always in full). */
export const EVALS_PATCH_SHA_RE = /^[0-9a-f]{64}$/;

/** The separation rule's answer (analysis/stats.ts `separate`). */
export type SeparationResult = { kind: "better" | "worse" | "not-separated"; p: number } | { kind: "too-few" };

// Every SeparationResult kind is an EvalSeparation, so the two cannot drift.
type _SeparationKinds = SeparationResult["kind"] extends EvalSeparation ? (EvalSeparation extends SeparationResult["kind"] ? true : never) : never;
const _separationKinds: _SeparationKinds = true;
void _separationKinds;

// ── The index row ───────────────────────────────────────────────────────────

/**
 * One rep as every product's index holds it: what the verdict, the epochs,
 * attribution and the views read. A product's own row adds its fields to it.
 */
export interface RunRowCore {
  /** The rep's id (codecast: the folder name, `<surface>-<freeze8>-seed<rep>-<stamp>`). */
  id: string;
  surface: string;
  freezeId: string;
  freezeName: string;
  visibility: EvalVisibility;
  seed: number;
  /** When the rep ran, as ISO time. */
  stamp: string;
  /** The run set the rep belonged to; null on reps that predate batches. */
  batch: string | null;
  /** The earliest stamp in the batch: batch names do not all sort by time. */
  batchAt: string | null;
  /** The standing run (nightly, bisect, ...), or null. */
  cadence: string | null;
  status: RunRowStatus;
  score: number | null;
  passMark: number | null;
  gatesFailed: string[];
  /** Each judged check's score by id. */
  checks: Record<string, number>;
  missedFloors: string[];
  model: string | null;
  judgeModel: string | null;
  ruler: string | null;
  gitHead: string | null;
  /** gitHead, or its main-line twin when gitHead is on no branch. */
  mainSha: string | null;
  dirty: boolean;
  offBranch: boolean;
  /** The id of the uncommitted edits the rep ran on top of gitHead, when they were kept. */
  treePatch: string | null;
  /** Declared sources hashed from disk: what the rep actually ran. */
  sourceHashDisk: string | null;
  promptSha: string | null;
  freezeSha: string | null;
  liveReads: number;
  costUsd: number;
  judgeCostUsd: number;
  realMs: number;
  /** Liveness only (a running rep's newest event); never validated, never read by verdict math. */
  lastEventAt?: string | null;
}

/** How a field of a row is checked: a kind by name, or a product's own check with the name its message uses. */
export type FieldKind = "string" | "number" | "boolean" | "string?" | "number?" | "strings" | "numbers-record";
export type FieldSpec = FieldKind | { name: string; ok: (v: unknown) => boolean };

/** Every RunRowCore field and its kind, in the order a problem list names them. */
export const RUN_ROW_CORE_FIELDS: Record<Exclude<keyof RunRowCore, "lastEventAt">, FieldKind> = {
  id: "string",
  surface: "string",
  freezeId: "string",
  freezeName: "string",
  visibility: "string",
  seed: "number",
  stamp: "string",
  batch: "string?",
  batchAt: "string?",
  cadence: "string?",
  status: "string",
  score: "number?",
  passMark: "number?",
  gatesFailed: "strings",
  checks: "numbers-record",
  missedFloors: "strings",
  model: "string?",
  judgeModel: "string?",
  ruler: "string?",
  gitHead: "string?",
  mainSha: "string?",
  dirty: "boolean",
  offBranch: "boolean",
  treePatch: "string?",
  sourceHashDisk: "string?",
  promptSha: "string?",
  freezeSha: "string?",
  liveReads: "number",
  costUsd: "number",
  judgeCostUsd: "number",
  realMs: "number",
};

const RUN_ROW_STATUSES: readonly string[] = ["pass", "fail", "crash", "dry", "unscored"] satisfies RunRowStatus[];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fieldOk(spec: FieldSpec, v: unknown): boolean {
  if (typeof spec !== "string") return spec.ok(v);
  switch (spec) {
    case "string":
      return typeof v === "string";
    case "number":
      return isNum(v);
    case "boolean":
      return typeof v === "boolean";
    case "string?":
      return v === null || typeof v === "string";
    case "number?":
      return v === null || isNum(v);
    case "strings":
      return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "numbers-record":
      return !!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isNum);
  }
}

/**
 * Why a value is not a row of the given fields, one line per field; empty
 * when it is one. A product passes its whole field map (RUN_ROW_CORE_FIELDS
 * and its own, in the order it wants them named); `status` and `visibility`
 * must hold a known value, and `extra` adds the product's own row rules.
 */
export function rowProblems(value: unknown, fields: Record<string, FieldSpec>, extra?: (row: Record<string, unknown>) => string[]): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not an object"];
  const row = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [field, spec] of Object.entries(fields)) {
    if (!(field in row)) out.push(`${field}: missing`);
    else if (!fieldOk(spec, row[field])) out.push(`${field}: expected ${typeof spec === "string" ? spec : spec.name}, got ${JSON.stringify(row[field])}`);
  }
  if (typeof row.status === "string" && !RUN_ROW_STATUSES.includes(row.status)) out.push(`status: unknown "${row.status}"`);
  if (typeof row.visibility === "string" && row.visibility !== "public" && row.visibility !== "private") out.push(`visibility: unknown "${row.visibility}"`);
  return extra ? [...out, ...extra(row)] : out;
}

/** Why a value is not a RunRowCore; empty when it is one. */
export const runRowCoreProblems = (value: unknown): string[] => rowProblems(value, RUN_ROW_CORE_FIELDS);

// ── Analysis ────────────────────────────────────────────────────────────────

/** Model and judge spend on one UTC day. */
export interface SpendDay {
  day: string;
  usd: number;
  judgeUsd: number;
}

/** Spend per UTC day over the reps stamped at or after `from`, oldest day first: the wall's total and each surface's row both come from here. */
export function spendByDayOf(rows: Iterable<{ stamp: string; costUsd: number; judgeCostUsd?: number | null }>, from: number): SpendDay[] {
  const spend = new Map<string, SpendDay>();
  for (const r of rows) {
    if (Date.parse(r.stamp) < from) continue;
    const day = r.stamp.slice(0, 10);
    const s = spend.get(day) ?? { day, usd: 0, judgeUsd: 0 };
    s.usd += r.costUsd;
    s.judgeUsd += r.judgeCostUsd ?? 0;
    spend.set(day, s);
  }
  return [...spend.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/**
 * A set the model was never asked about: nothing was spent on the model or the
 * judge, and every graded rep failed. A stub or the harness answered before any
 * call (a reply of "...", an echoed prompt), so its zeros say nothing about the
 * prompt and its missing judge says nothing about the ruler. A real prompt that
 * breaks parsing still pays for its calls, so it never reads as unasked.
 */
export function unaskedSet(set: ReadonlyArray<{ status: string; costUsd: number; judgeCostUsd?: number | null }>): boolean {
  const graded = set.filter((r) => r.status === "pass" || r.status === "fail");
  return graded.length > 0 && graded.every((r) => r.status === "fail") && set.every((r) => !r.costUsd && !r.judgeCostUsd);
}

/** A batch's reps as a set (verdict.ts batchSet): EvalRunSet plus what the strip and the verdict line show. */
export interface BatchStats extends EvalRunSet {
  batchAt: string;
  cadence: string | null;
  /** passed / scored reps, crashes left out; null when nothing scored. */
  passRate: number | null;
  /** The lowest and highest scored rep (crashes left out); null when nothing scored. */
  min: number | null;
  max: number | null;
  crashes: number;
  judgeCostUsd: number;
  /** Reps that read the live workspace, and the reads they made. */
  liveReads: { reps: number; reads: number };
  /** Every rep was dry: nothing graded. */
  dry: boolean;
  /** The model was never asked (unaskedSet): drawn as a crash, never as a median of 0. */
  unasked?: boolean;
  dirtyReps: number;
  freezes: number;
  footing: Footing;
  gitHeads: string[];
}

/** A newer batch the default baseline passed over (verdict.ts SkippedBatch). */
export interface SkippedBatch {
  batch: string;
  freezeId: string;
  why: "model" | "judge";
}

/** A freeze whose majority verdict differs between two sets on the same footing, by id. The reply text rides separately as EvalFlip examples. */
export interface VerdictFlip {
  freezeId: string;
  name: string;
  visibility: EvalVisibility;
  direction: EvalFlip["direction"];
  /** The reps behind each side's majority, by run id. */
  before: string[];
  after: string[];
  /** On a latest verdict (the wall's and the surface page's): how many of the window's graded batches this freeze flipped in, of the batches it ran. */
  history?: { flips: number; batches: number };
  /** On a latest verdict: every rep on both sides rendered one prompt (promptSha), so what the model saw did not change. */
  samePrompt?: boolean;
}

/** A freeze that flips this often is flapping: its verdict moves with the model's spread, not with a change. */
export const FLAPPING_MIN_FLIPS = 3;
export const FLAPPING_MIN_SHARE = 0.2;
export const isFlapping = (h: VerdictFlip["history"]): boolean => !!h && h.flips >= FLAPPING_MIN_FLIPS && h.flips / Math.max(1, h.batches) >= FLAPPING_MIN_SHARE;

/** A flip that says nothing about a change: the freeze flaps, or the prompt the model saw was the same on both sides. */
export const isNoiseFlip = (f: Pick<VerdictFlip, "history" | "samePrompt">): boolean => !!f.samePrompt || isFlapping(f.history);

/**
 * A verdict's flips as every page counts them: broke and fixed are the flips
 * that say something; `noise` holds the ones on a flapping freeze or under an
 * unchanged prompt (isNoiseFlip), shown but never counted as broke.
 */
export function flipCounts<F extends Pick<VerdictFlip, "direction" | "history" | "samePrompt">>(flips: readonly F[]): { broke: number; fixed: number; noise: F[] } {
  const told = flips.filter((f) => !isNoiseFlip(f));
  const broke = told.filter((f) => f.direction === "broke").length;
  return { broke, fixed: told.length - broke, noise: flips.filter(isNoiseFlip) };
}

/**
 * One batch weighed against its baseline: everything `check` prints for it
 * (verdict.ts batchVerdict), so the CLI's lines and the UI read one value.
 */
export interface BatchVerdict {
  surface: string;
  batch: string;
  footing: Footing;
  /** Every model the scored reps ran on (or the pinned one). */
  models: string[];
  /** Every rep was dry: nothing is graded or compared. */
  dry: boolean;
  set: BatchStats;
  /**
   * What the set was weighed against. Null only for a dry set; a set with no
   * earlier one has a baseline of 0 reps (a pooled one is then still building).
   */
  baseline: {
    kind: "previous" | "pooled" | "against";
    batches: string[];
    reps: number;
    /** The cadence a pooled baseline was drawn from. */
    cadence: string | null;
    skipped: SkippedBatch[];
  } | null;
  /** The scores the separation compared: the set's reps on freezes the baseline ran, and the baseline's. */
  compared: { current: number[]; previous: number[]; previousFreezes: number };
  separation: SeparationResult;
  /** For `against`: freezes weighed on another model or judge ruler than the set. */
  footingNotes: Array<{ freezeId: string; model: { then: string | null; now: string | null } | null; judge: boolean }>;
  flips: VerdictFlip[];
  gatesFailed: string[];
  /** separated worse against the baseline. */
  regression: boolean;
  /**
   * No graded rep on either side says what model answered or what judge
   * graded it (both null on every one): the product records no footing, so
   * the comparison cannot rule a model or judge change out. Absent otherwise.
   */
  unfooted?: true;
}

/**
 * A prompt epoch (analysis/epochs.ts): it begins at the first batch where any
 * freeze's rendered prompt differs from that freeze's previous appearance.
 */
export interface Epoch {
  /** 1-based, oldest first. */
  n: number;
  surface: string;
  firstBatch: string;
  firstBatchAt: string;
  lastBatch: string;
  gitHead: string | null;
  /** Freezes whose promptSha changed at this boundary (all freezes for e1). */
  changedFreezes: string[];
  /** org-review's promptSha covers only the analyzer prompt. */
  scope: "rendered" | "analyzer-only";
}

/** Where the footing moved on a surface's timeline. */
export interface FootingMarker {
  batch: string;
  batchAt: string;
  kind: "model" | "judge";
  from: string | null;
  to: string | null;
}

/** One rendered prompt file of two reps on the same freeze: what the model saw before and after. */
export interface PromptFilePair {
  freezeId: string;
  /** Relative to the rep: `call1/system.md`, `call1/prompt.md`, `agent1/prompt.md`, `agent1/then2.md`. */
  file: string;
  a: { runId: string; text: string | null };
  b: { runId: string; text: string | null };
}

/** A commit as the pages show it. */
export interface CommitRef {
  sha: string;
  subject: string;
  author: string;
  at: string;
  /** The Codecast-Session trailer: the session that wrote it. */
  session: string | null;
  /** Its main-line twin when the commit is on no branch, else itself. */
  mainSha: string | null;
  onMain: boolean;
  /** Off the main line with no twin: why none was found. */
  twinReason?: string;
  /** A main-line commit with the same author, date and subject but a different patch (amended when it landed). */
  near?: string;
}

/** flipsBetween either lists the flips or refuses, because the footing differs. */
export type FlipsResult = { ok: true; flips: VerdictFlip[] } | { ok: false; reason: string; a: Footing; b: Footing };

/** Two runs' gate flips and check moves of 0.2 or more (@platform/evals diffRuns). */
export type RunDiffEntry =
  | { kind: "gate"; id: string; before: boolean; after: boolean }
  | { kind: "check"; id: string; before: number; after: number };
