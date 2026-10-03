// The Evals UI's wire contract (docs/architecture/evals-ui.md, sections 3.4
// and 3.7). Three parties read it and must agree: the eval tool's api child
// (`bun packages/evals/src/index.ts api --stdio`), the daemon's /evals bridge
// that forwards to it, and the web pages under /evals with their fixture
// transport.
//
// Everything here describes data that lives on the laptop that ran the evals
// (EVALS_HOME and the sim session folders). None of it may be stored in
// Convex, IndexedDB or a published page.
//
// The shapes mirror what is on disk: run.json, result.json and score.json in
// a run folder (packages/evals/src/layout.ts and @platform/evals' model), the
// guard's calls.log marks (packages/cli/scripts/prompt-dry-run-bin/cast), and
// the multiplayer sim's artifacts (packages/web/store/__tests__/sim/report.ts
// and dsl.ts). The platform's own types are not imported, because this
// package does not depend on @platform/evals; the api child maps them in.
//
// PURE isomorphic data: no Node or DOM APIs.

import type { EvalFlip, EvalRunSet, EvalSeparation } from "./evalResult";

export type { EvalFlip, EvalRunSet, EvalSeparation };

// ── Primitives ──────────────────────────────────────────────────────────────

export type EvalRoute = "call" | "agent";

/** A freeze committed under packages/evals (public) or kept in EVALS_HOME (private). */
export type EvalVisibility = "public" | "private";

/** A rep's status in the index. `dry` ran on canned output and graded nothing; `unscored` has no score.json yet. */
export type RunRowStatus = "pass" | "fail" | "crash" | "dry" | "unscored";

/** The marks the dry-run guard writes to calls.log, one per outcome. */
export const GUARD_STATUSES = ["SERVED", "UNSERVED", "LIVE", "REFUSED", "UNKNOWN", "HELP"] as const;
export type GuardStatus = (typeof GUARD_STATUSES)[number];

/** calls.log marks counted per rep. */
export interface GuardCounts {
  served: number;
  unserved: number;
  live: number;
  refused: number;
  unknown: number;
  help: number;
}

/**
 * Where a surface stands against its sources (commands/stale.ts staleness):
 * `fresh` ran on them, `stale` its sources changed at HEAD since, `waiting`
 * stale but the sources are dirty in the checkout, `due` a call surface
 * `check --stale` would run now, `blocked` crashed twice on these sources.
 */
export type StalenessWord = "fresh" | "stale" | "waiting" | "due" | "blocked";

/** What a rep is weighed on: the model it answered on and the judge's ruler (adapters/runs.ts rulerOf). */
export interface Footing {
  model: string | null;
  ruler: string | null;
}

/** A sha the api accepts. The child also checks `git rev-parse --verify <sha>^{commit}`. */
export const EVALS_SHA_RE = /^[0-9a-f]{7,40}$/;
/** A tree patch's name: the sha256 of its text, as EVALS_HOME/trees/<sha>.patch keeps it (always in full). */
export const EVALS_PATCH_SHA_RE = /^[0-9a-f]{64}$/;

/** The separation rule's answer (packages/evals/src/stats.ts `separate`). */
export type SeparationResult = { kind: "better" | "worse" | "not-separated"; p: number } | { kind: "too-few" };

// Every SeparationResult kind is an EvalSeparation, so the two cannot drift.
type _SeparationKinds = SeparationResult["kind"] extends EvalSeparation ? (EvalSeparation extends SeparationResult["kind"] ? true : never) : never;
const _separationKinds: _SeparationKinds = true;
void _separationKinds;

// ── The index (section 3.2) ─────────────────────────────────────────────────

/** One run folder under EVALS_HOME/runs, as EVALS_HOME/index/runs.jsonl holds it. A cache: always rebuildable from the folder. */
export interface RunRow {
  /** The folder name, `<surface>-<freeze8>-seed<rep>-<stamp>`. */
  id: string;
  surface: string;
  freezeId: string;
  freezeName: string;
  visibility: EvalVisibility;
  seed: number;
  /** The folder's stamp as ISO time. */
  stamp: string;
  /** The `check` invocation the rep belonged to (run.json.batch); null on reps that predate batches. */
  batch: string | null;
  /** The earliest stamp in the batch: batch names do not all sort by time. */
  batchAt: string | null;
  /** The standing run (check --cadence: nightly, bisect, ...), or null. */
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
  /** gitHead, or its main-line twin when gitHead is on no branch (heads.json). */
  mainSha: string | null;
  dirty: boolean;
  offBranch: boolean;
  /** sha256 of the batch's `git diff HEAD` over the surface's sources, stored at EVALS_HOME/trees/<sha>.patch. */
  treePatch: string | null;
  /** Declared sources hashed at HEAD (git ls-tree): what staleness reads. */
  sourceHash: string | null;
  /** Declared sources hashed from disk: what the rep actually ran. */
  sourceHashDisk: string | null;
  promptSha: string | null;
  freezeSha: string | null;
  liveReads: number;
  costUsd: number;
  judgeCostUsd: number;
  realMs: number;
  guard: GuardCounts;
  /** How many score versions the folder holds (score.json plus every kept rescore and rejudge). */
  scoreVersions: number;
}

type FieldKind = "string" | "number" | "boolean" | "string?" | "number?" | "strings" | "numbers-record" | "guard";

const RUN_ROW_FIELDS: Record<keyof RunRow, FieldKind> = {
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
  sourceHash: "string?",
  sourceHashDisk: "string?",
  promptSha: "string?",
  freezeSha: "string?",
  liveReads: "number",
  costUsd: "number",
  judgeCostUsd: "number",
  realMs: "number",
  guard: "guard",
  scoreVersions: "number",
};

const RUN_ROW_STATUSES: readonly string[] = ["pass", "fail", "crash", "dry", "unscored"] satisfies RunRowStatus[];
const GUARD_KEYS: readonly (keyof GuardCounts)[] = ["served", "unserved", "live", "refused", "unknown", "help"];

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function fieldOk(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
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
    case "guard":
      return !!v && typeof v === "object" && GUARD_KEYS.every((k) => isNum((v as Record<string, unknown>)[k]));
  }
}

/** Why a value is not a RunRow, one line per field; empty when it is one. The index writer and its tests hold every row to this. */
export function runRowProblems(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["not an object"];
  const row = value as Record<string, unknown>;
  const out: string[] = [];
  for (const [field, kind] of Object.entries(RUN_ROW_FIELDS) as [keyof RunRow, FieldKind][]) {
    if (!(field in row)) out.push(`${field}: missing`);
    else if (!fieldOk(kind, row[field])) out.push(`${field}: expected ${kind}, got ${JSON.stringify(row[field])}`);
  }
  if (typeof row.status === "string" && !RUN_ROW_STATUSES.includes(row.status)) out.push(`status: unknown "${row.status}"`);
  if (typeof row.visibility === "string" && row.visibility !== "public" && row.visibility !== "private") out.push(`visibility: unknown "${row.visibility}"`);
  return out;
}

// ── Analysis (section 3.3) ──────────────────────────────────────────────────

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
}

/**
 * A prompt epoch (history/epochs.ts): it begins at the first batch where any
 * freeze's promptSha differs from that freeze's previous appearance.
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
  /** Relative to the run folder: `call1/system.md`, `call1/prompt.md`, `agent1/prompt.md`, `agent1/then2.md`. */
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
  /** Its main-line twin when the commit is on no branch (heads.json), else itself. */
  mainSha: string | null;
  onMain: boolean;
}

/** flipsBetween either lists the flips or refuses, because the footing differs. */
export type FlipsResult = { ok: true; flips: VerdictFlip[] } | { ok: false; reason: string; a: Footing; b: Footing };

/** Two runs' gate flips and check moves of 0.2 or more (@platform/evals diffRuns). */
export type RunDiffEntry =
  | { kind: "gate"; id: string; before: boolean; after: boolean }
  | { kind: "check"; id: string; before: number; after: number };

// ── Attribution (section 5, Tier 0) ─────────────────────────────────────────

/** The fixed-order checklist: the first class that differs between good and bad is the answer. */
export const ATTRIBUTION_CLASSES = ["footing", "freeze", "live-reads", "source", "noise"] as const;
export type AttributionClass = (typeof ATTRIBUTION_CLASSES)[number];

/** One end of a range: a batch (or a bare sha) with what it ran on. */
export interface Endpoint {
  batch: string | null;
  sha: string;
  mainSha: string | null;
  dirty: boolean;
  treePatch: string | null;
  footing: Footing;
  at: string | null;
}

/** A place the regression can sit: a commit, or a dirty batch's uncommitted edits on top of its head. */
export type Candidate =
  | { kind: "commit"; commit: CommitRef; renderClass: number | null }
  | { kind: "patch"; base: string; treePatch: string; renderClass: number | null };

/** A recorded batch inside the range that classified for free. */
export interface RecordedProbe {
  batch: string;
  sha: string;
  verdict: ProbeVerdict;
  reps: number;
}

export type ProbeVerdict = "good" | "bad" | "unsure" | "skip" | "pending";

export type AttributionAnswer =
  | { kind: "footing"; change: "model" | "judge"; from: string | null; to: string | null }
  | { kind: "freeze"; freezeIds: string[] }
  | { kind: "live-reads"; reps: number; reads: number }
  | {
      kind: "source";
      confidence: "pinned" | "narrowed" | "unattributable";
      candidates: Candidate[];
      narrowedBy: RecordedProbe[];
      epochs: Epoch[];
      /** No declared source moved in the range: only --all-commits searches it. */
      noDeclaredSourceMoved: boolean;
      /** Why it is unattributable: an endpoint was dirty, has no patch, and Tier 1 mapped nothing. */
      reason: string | null;
    }
  | { kind: "noise"; separation: SeparationResult };

export interface Attribution {
  surface: string;
  good: Endpoint;
  bad: Endpoint;
  /** `flip` when freezes flipped; `score` when only the scores fell (the 3 largest median drops stand in). */
  mode: "flip" | "score";
  flipped: VerdictFlip[];
  /** Each class in ATTRIBUTION_CLASSES order, with whether it differs and the plain words for it. */
  checklist: Array<{ class: AttributionClass; differs: boolean; detail: string }>;
  answer: AttributionAnswer;
  /** The rendered prompt change, shown whatever the confidence. */
  promptDiffs: PromptFilePair[];
  examples: EvalFlip[];
}

// ── Bisect (section 5) ──────────────────────────────────────────────────────

/** Candidates whose dry renders match on every flipped freeze: a replay cannot tell them apart. */
export interface RenderClass {
  n: number;
  shas: string[];
  /** The newest commit in the class: the one a probe replays. */
  representative: string;
  promptShas: Record<string, string>;
  /** Set when the surface does not load at this class (baseLoadErrors). */
  skip: string | null;
}

/** C, P, F and r from the cost bound, and what they come to. */
export interface CostBound {
  classes: number;
  probes: number;
  freezes: number;
  reps: number;
  maxReps: number;
  perRepUsd: number;
  judgePerRepUsd: number;
  maxUsd: number;
}

export interface BisectPlanRequest {
  surface: string;
  /** A batch name or a sha. */
  good: string;
  bad: string;
  freezes?: string[];
  reps?: number;
  budgetUsd?: number;
  maxMinutes?: number;
  allCommits?: boolean;
}

export interface BisectPlan {
  surface: string;
  good: Endpoint;
  bad: Endpoint;
  attribution: Attribution;
  freezes: Array<{ id: string; name: string; role: "flipped" | "control" }>;
  reps: number;
  candidates: Candidate[];
  /** Null until the Tier 1 dry render finishes. */
  classes: RenderClass[] | null;
  bound: CostBound;
  /** Default 1.2 times the bound. */
  budgetUsd: number;
  maxMinutes: number;
  allCommits: boolean;
  /** An agent surface: starting needs an explicit confirm (--yes). */
  needsConfirm: boolean;
  /** The cost line in plain words. */
  summary: string;
}

export interface BisectStartRequest extends BisectPlanRequest {
  /** The agent-surface confirm, passed as --yes. */
  confirm?: boolean;
}

export interface BisectStartResponse {
  id: string;
  /** The tmux session the bisect runs in, or null when it runs detached with log.txt. */
  tmux: string | null;
}

export type BisectStatus = "planning" | "controls" | "probing" | "confirming" | "done" | "stopped" | "budget" | "failed";

export interface BisectRep {
  freezeId: string;
  runId: string | null;
  passed: boolean | null;
  score: number | null;
}

export interface BisectProbe {
  sha: string;
  kind: "control-good" | "control-bad" | "probe" | "confirm-culprit" | "confirm-parent";
  renderClass: number | null;
  /** `<id>~<sha8>` for a replay probe, or the recorded batch. */
  batch: string;
  recorded: boolean;
  reps: BisectRep[];
  verdict: ProbeVerdict;
  skipReason: string | null;
  costUsd: number;
}

export type BisectAnswer =
  | { kind: "culprit"; commit: CommitRef; separation: SeparationResult; tier: 0 | 1 | 2 }
  | { kind: "range"; candidates: Candidate[]; separation: SeparationResult | null; tier: 0 | 1 | 2 }
  /** The controls did not reproduce on today's tool and judge. */
  | { kind: "drift"; detail: string }
  /** Tier 0 answered with a non-source class. */
  | { kind: "attribution"; answer: AttributionAnswer }
  | { kind: "unreplayable"; detail: string };

/** EVALS_HOME/bisects/<id>/state.json, rewritten after each rep. */
export interface BisectState {
  id: string;
  surface: string;
  seq: number;
  status: BisectStatus;
  tier: 0 | 1 | 2;
  range: { good: string; bad: string };
  candidates: Candidate[];
  classes: RenderClass[] | null;
  probes: BisectProbe[];
  spentUsd: number;
  budgetUsd: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  tmux: string | null;
  answer: BisectAnswer | null;
  plan: BisectPlan;
}

/** One line of EVALS_HOME/bisects/<id>/steps.jsonl. */
export interface BisectStep {
  seq: number;
  at: string;
  kind: "plan" | "render" | "control" | "probe" | "rep" | "narrow" | "confirm" | "answer" | "stop" | "error";
  sha: string | null;
  text: string;
  /** The rep that landed, for kind `rep`. */
  rep?: BisectRep;
}

/** A bisect in a list or a ribbon. */
export interface BisectSummary {
  id: string;
  surface: string;
  good: string;
  bad: string;
  status: BisectStatus;
  outcome: BisectAnswer["kind"] | null;
  culprit: string | null;
  spentUsd: number;
  budgetUsd: number;
  startedAt: string;
  /** state.json's last write: a live bisect quiet for five minutes reads "stalled?". */
  updatedAt: string;
  finishedAt: string | null;
}

// ── Multiplayer sim (section 3.7) ───────────────────────────────────────────

/** report.ts SimMode. */
export type SimMode = "scripted" | "interleave" | "order";

/** A red marker: the run is expected to fail on this invariant (scenario `red`). */
export interface SimMarker {
  task: string;
  invariant: string;
  modes: string[] | null;
  seeds: number[] | null;
}

/** One row of `bun run sim --list --json`. */
export interface SimScenario {
  name: string;
  /** Relative to the sim dir: `scenarios/x.scenario.ts` or `selftests/x.selftest.ts`. */
  file: string;
  selftest: boolean;
  modes: string[];
  red: SimMarker[];
  /** Invariant ids known to fail, each with its tasks (scenario `known`). */
  known: Array<{ invariant: string; tasks: string[] }>;
}

/** One row of `bun run sim --invariants --json`. */
export interface SimInvariant {
  id: string;
  meaning: string;
  /** The store keys it compares, when the static read finds them. */
  keys: string[];
}

/** <session>/session.json. */
export interface SimSession {
  /** The folder name, a stamp. */
  id: string;
  argv: string[];
  gitHead: string | null;
  dirty: boolean;
  treePatch: string | null;
  startedAt: string;
  finishedAt: string | null;
  exit: number | null;
  /** A legacy $TMPDIR/codecast-sim folder with no session: shown read-only. */
  unsessioned?: boolean;
}

/** One line of <session>/runs.jsonl. */
export interface SimRunRow {
  scenario: string;
  mode: SimMode;
  seed: number;
  passed: boolean;
  deliveries: number;
  ms: number;
  /** The artifact folder inside the session, `<scenario>-<mode>-<seed>`, when one was written. */
  dir?: string;
}

/** A session in the history list. */
export interface SimSessionSummary extends SimSession {
  runs: number;
  failed: number;
  scenarios: number;
}

/** A row of events.jsonl: a delivery (rows written before step markers carry no kind) or a step marker from dsl.ts. */
export type SimEvent =
  | { kind?: "delivery"; seq: number; channel: string; due: number; label: string; producer: string }
  | { kind: "step"; seq: number; verb: string; actor: string; label: string };

/** world.json. */
export interface SimWorld {
  scenario: string;
  mode: SimMode;
  seed: number;
  labels: Record<string, string>;
  devices: Array<{ name: string; windows: Array<{ name: string; role: "host" | "follower"; closed: boolean }> }>;
}

/** final.json. */
export interface SimFinal {
  deliveries: number;
  writesSpent: number;
  producers: Record<string, number>;
  calls: Array<{ seq: number; name: string; kind: string; ok: boolean; error?: string }>;
  actors: Array<{ actor: string; verb: string; ok: boolean; error?: string }>;
  windowErrors: Record<string, string[]>;
}

/** Fields every result.json carries since the session history landed. */
interface SimResultCommon {
  scenario: string;
  mode: SimMode;
  seed: number;
  gitHead?: string | null;
  dirty?: boolean;
  startedAt?: string;
  realMs?: number;
}

/** result.json of a failing run (report.ts reportFailure). */
export interface SimFailureResult extends SimResultCommon {
  passed?: false;
  step: string;
  delivery: number;
  invariant: { id: string; meaning: string };
  message?: string;
  window?: { name: string; principal: string; scope: string };
  /** The row the check names, with the rendered field diff (no raw rows). */
  row?: { table: string; id: string; label: string; diff: Array<{ field: string; server: string; replica: string }> };
  /** The recorded delivery order, as `--order` takes it. */
  order: string;
  labels: Record<string, string>;
  t0?: number;
  replay?: string[];
  /** The task of the red or known marker that expected this failure. */
  expected?: string;
  /** The block printed to the terminal. */
  text: string;
  /** Set once a shrink has run: the minimal order, as `--order` takes it. */
  minimalOrder?: string;
}

/** result.json of a passing run written with --keep or SIM_OUT. */
export interface SimPassResult extends SimResultCommon {
  passed: true;
  deliveries: number;
}

export type SimResult = SimFailureResult | SimPassResult;

/** minimal.json, written by `bun run sim --shrink`. */
export interface SimMinimal {
  /** The channels of the smallest order that still fails the same way. */
  order: string[];
  /** Indexes into the recorded order that the shrink removed. */
  removed: number[];
  attempts: number;
  ms: number;
  /** ddmin finished: no single entry can be removed. False when a cap stopped it. */
  oneMinimal: boolean;
}

/** minimal.json.tmp while a shrink runs. */
export interface SimShrinkProgress {
  phase: "prefix" | "ddmin";
  attempts: number;
  /** The shortest failing order found so far. */
  best: number;
  recorded: number;
}

/** A spawned shrink or sweep, reported through /changes. */
export interface SimJob {
  id: string;
  kind: "shrink" | "sweep";
  status: "running" | "done" | "failed" | "stopped";
  startedAt: string;
  updatedAt: string;
  tmux: string | null;
  progress: { done: number; total: number | null; text: string };
  session: string | null;
  run: string | null;
}

/** One cell of the catalog grid: a scenario in one mode. */
export interface SimGridCell {
  scenario: string;
  mode: SimMode;
  latest: { session: string; run: string | null; seed: number; passed: boolean; at: string } | null;
  /** Per session, oldest first: seeds run and seeds failed. */
  history: Array<{ session: string; seeds: number; failed: number }>;
  gitHead: string | null;
  lastRunAt: string | null;
  /**
   * The newest run of this cell that failed and left an artifact folder, with
   * the invariant it broke (its result.json): what a click on the cell opens,
   * even when the latest session passed, and what the invariant filter reads.
   * null when the history holds no failing run with artifacts. The api child's
   * `simGrid` fills it.
   */
  newestFailure: { session: string; run: string; seed: number; invariant: string; at: string } | null;
}

// ── Endpoints (section 3.4) ─────────────────────────────────────────────────

export interface HealthResponse {
  root: string;
  evalsHome: string;
  /** The eval tool's own commit. */
  gitHead: string | null;
  runsIndexed: number;
  index: { state: "cold" | "building" | "warm"; done: number; total: number | null };
  pid: number;
  startedAt: string;
}

export interface OverviewQuery {
  /** A cadence name, or `all`. */
  cadence?: string;
}

/** One surface's row on the wall. */
export interface SurfaceOverview {
  id: string;
  title: string;
  route: EvalRoute;
  model: string;
  freezes: { public: number; private: number };
  /** The last 30 days of batches, oldest first. */
  strip: BatchStats[];
  /** Every rep behind the strip, for the faint dots. */
  dots: Array<{ batch: string; at: string; score: number | null; status: RunRowStatus }>;
  latest: BatchVerdict | null;
  staleness: StalenessWord;
  /** costUsd plus judgeCostUsd over the index's last 7 days. */
  spend7dUsd: number;
  epochs: Epoch[];
  footing: FootingMarker[];
  /** A batch is still landing reps. */
  landing: boolean;
}

/** A "What moved" line. */
export type MovedEvent = { at: string; surface: string | null } & (
  | { kind: "epoch"; epoch: number; batch: string; changedFreezes: number }
  | { kind: "footing"; batch: string; change: "model" | "judge"; from: string | null; to: string | null }
  | { kind: "flips"; batch: string; broke: number; fixed: number }
  | { kind: "bisect"; id: string; outcome: BisectAnswer["kind"] | null }
  | { kind: "sim-failure"; session: string; run: string; scenario: string; invariant: string }
);

export interface OverviewResponse {
  cadence: string;
  surfaces: SurfaceOverview[];
  moved: MovedEvent[];
  spendByDay: Array<{ day: string; usd: number; judgeUsd: number }>;
  bisects: BisectSummary[];
  sim: SimSessionSummary | null;
}

export interface SurfaceQuery {
  from?: string;
  to?: string;
  model?: string;
  cadence?: string;
  dry?: boolean;
  bisect?: boolean;
}

/** A surface's meta as the header shows it. */
export interface SurfaceInfo {
  id: string;
  title: string;
  route: EvalRoute;
  model: string;
  criteria: string | null;
  freezes: { public: number; private: number };
  sources: string[];
  reps: { check: number; smoke?: number };
  maxUsdPerRep: number;
}

/** One well of the freeze ledger. */
export interface LedgerCell {
  reps: number;
  passed: number;
  mean: number | null;
  /** Passed by majority; null when no rep scored. */
  majority: boolean | null;
  /** The majority flipped against this freeze's previous batch on the same footing. */
  flip: EvalFlip["direction"] | null;
}

export interface LedgerRow {
  freezeId: string;
  name: string;
  visibility: EvalVisibility;
  flips: number;
  /** By batch name. */
  cells: Record<string, LedgerCell>;
}

export interface SurfaceResponse {
  surface: SurfaceInfo;
  runs: RunRow[];
  batches: BatchStats[];
  epochs: Epoch[];
  footing: FootingMarker[];
  ledger: LedgerRow[];
  /** Commits that touched the declared sources inside the window. */
  commits: CommitRef[];
  /**
   * The newest graded batch in the window weighed the way the wall weighs it
   * (against batches that began before it), so the page can say what brought
   * the investigator here. Null when the window holds no graded batch.
   */
  latest: BatchVerdict | null;
}

/** A conversation message as a surface's describe() renders the moment (@platform/evals ConvoMessage). */
export interface MomentMessage {
  n: number;
  id: string;
  at: string;
  channel: string;
  room?: string | null;
  isGroup: boolean;
  direction: "in" | "out" | "system";
  from: string;
  to?: string | null;
  text: string;
  status?: string | null;
  meta?: Record<string, unknown>;
}

/** A freeze's own record (@platform/evals Freeze plus its meta). */
export interface FreezeInfo {
  id: string;
  name: string;
  surface: string;
  visibility: EvalVisibility;
  createdAt: string;
  asOf: string;
  anchor: { kind: "message" | "run"; id: string };
  subject: { kind: string; id: string; title: string; subtitle?: string | null };
  trigger: { type: string; data?: Record<string, unknown> } | null;
  notes: string | null;
  /** The judge's criteria. */
  judge: string | null;
  tags: string[];
  freezeSha: string | null;
}

export interface FreezeResponse {
  freeze: FreezeInfo;
  /** The label from EVALS_HOME/labels, or a fixture's inline label. Its shape is the surface's own. */
  label: unknown;
  labelSource: "labels" | "inline" | null;
  moment: MomentMessage[];
  /** Where "frozen here" cuts the moment: messages before this index happened before asOf. */
  cutAt: number;
  production: { messages: MomentMessage[]; verdict: { score: number; pass: boolean; reasoning?: string | null } | null } | null;
  runs: RunRow[];
  epochs: Epoch[];
}

/** run.json (layout.ts RunJson), with the provenance fields the writer adds. */
export interface RunJson {
  freezeId: string;
  notes: string | null;
  model: string;
  route: EvalRoute;
  sourceHash: string;
  sourceHashDisk?: string | null;
  treePatch?: string | null;
  freezeSha?: string | null;
  promptSha: string | null;
  judgeModel: string | null;
  budgetUsd: number | null;
  gitHead: string;
  dirty: boolean;
  dry?: boolean;
  temperatureProd: Array<number | "api-default">;
  temperatureReplay: "cli-default";
  liveReads?: number;
  batch: string;
  cadence?: string | null;
  title: string;
}

/** result.json (layout.ts writeRunFolder). */
export interface RunResultJson {
  scenario: string;
  seed: number;
  title: string;
  startedAt: string;
  endedBecause: "done" | "failed" | "budget";
  stopReason: string | null;
  steps: number;
  virtualElapsedMs: number;
  realElapsedMs: number;
  costUsd: number;
  captures: number;
}

export interface GateResultJson {
  id: string;
  title?: string | null;
  pass: boolean;
  decidedBy?: "mechanical" | "judge";
  evidence: {
    summary: string;
    scanned?: number;
    /** Held because there was nothing to check. */
    vacuous?: boolean;
    excerpts?: Array<{ where: string; text: string }>;
  };
}

export interface CheckResultJson {
  id: string;
  ask?: string | null;
  weight: number;
  score: number;
  reasoning?: string | null;
  evidence?: string | null;
  must?: number | null;
}

/** score.json (@platform/evals Score) as the run folder holds it. */
export interface ScoreJson {
  pass: boolean;
  score: number;
  passMark: number;
  gates: GateResultJson[];
  checks: CheckResultJson[];
  missedFloors?: Array<{ id: string; score: number; must: number }>;
  judgeCostUsd?: number | null;
  judgeModel?: string | null;
  scoredAt?: string | null;
}

/** One score version of a rep: score.json, score.<scoredAt>.json, or a legacy before-file. */
export interface ScoreVersion {
  file: string;
  scoredAt: string | null;
  judgeModel: string | null;
  score: number;
  pass: boolean;
  /** Folders from before every rejudge was kept hold only the first and latest. */
  legacy: boolean;
}

/** A send the rep made (@platform/evals RunSend). */
export interface RunSendView {
  seq: number;
  at: string;
  label: string | null;
  rail: string | null;
  to: string | null;
  audience: string;
  text: string;
  chars: number;
}

export interface TokenUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** One `callN` folder: the request, the rendered prompt and the reply. */
export interface CallDetail {
  n: number;
  dir: string;
  request: { model: string; max_tokens: number; temperature: number | null };
  system: string | null;
  prompt: string;
  reply: string;
  stopReason: string | null;
  tokens: TokenUsage;
  costUsd: number;
  realMs: number | null;
  isError: boolean;
  harnessFailure: string | null;
}

/** One item of an agent turn, read from stream.jsonl. */
export type AgentItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: string | null; isError: boolean };

/** One `agentN` folder. */
export interface AgentDetail {
  n: number;
  dir: string;
  model: string;
  prompt: string;
  /** thenN.md, in order: the later turns sent into the same session. */
  then: string[];
  turns: AgentItem[][];
  said: string[];
  brief: string | null;
  /** args.json. */
  args: { model: string; call: boolean; maxOutputTokens: number | null; tools: string[] | null; maxTurns: number | null; serve: string | null; guard: string | null };
  tokens: TokenUsage;
  costUsd: number;
}

/** One calls.log entry: the argv the agent typed and the guard's mark for it. */
export interface GuardEntry {
  seq: number;
  /** 1-based; `# turn N` lines in calls.log start turn N. */
  turn: number;
  argv: string;
  /** Null when the argv was logged with no mark after it. */
  status: GuardStatus | null;
}

export interface RunFileEntry {
  /** Relative to the run folder. */
  path: string;
  kind: "file" | "dir";
  size: number;
}

export interface RunResponse {
  row: RunRow;
  run: RunJson;
  result: RunResultJson | null;
  score: ScoreJson | null;
  scoreVersions: ScoreVersion[];
  /** When the rep is unscored: what it will be held to. */
  rubric: { criteria: string | null; passMark: number } | null;
  sends: RunSendView[];
  calls: CallDetail[];
  agents: AgentDetail[];
  judge: { model: string | null; prompt: string; reply: string | null; costUsd: number | null } | null;
  guard: GuardEntry[];
  files: RunFileEntry[];
  /** The tail of run.log, shown first when the rep crashed. */
  logTail: string | null;
  /** This batch's other reps on the same freeze. */
  siblings: RunRow[];
  /** The same freeze in the previous and next batch, by run id. */
  adjacent: { previous: string | null; next: string | null };
  /** org-review only: grade-auto.json and hashes.json. */
  extra: { gradeAuto?: unknown; hashes?: unknown } | null;
}

export interface RunFileQuery {
  path: string;
}

export interface RunFileResponse {
  path: string;
  size: number;
  /** Null when the file is binary. */
  text: string | null;
  truncated: boolean;
}

export interface CompareQuery {
  a: string;
  b: string;
}

export interface CompareResponse {
  a: RunRow;
  b: RunRow;
  diff: RunDiffEntry[];
  replies: { a: string | null; b: string | null };
  prompts: PromptFilePair[];
}

export interface BatchesQuery {
  surface: string;
  a: string;
  b: string;
}

export interface BatchesResponse {
  /** b weighed against a. */
  verdict: BatchVerdict;
  flips: FlipsResult;
  /** Per gate: failing reps in a and in b. */
  gateDeltas: Array<{ id: string; a: number; b: number }>;
  /** The flips as before/after pairs, for ExamplePair. */
  examples: EvalFlip[];
  /** The prompt files of the first flipped freeze, before and after. */
  promptDiffs: PromptFilePair[];
}

export interface EpochQuery {
  surface: string;
  n: number;
}

export interface EpochResponse {
  epoch: Epoch;
  previous: Epoch | null;
  diffs: PromptFilePair[];
  commits: CommitRef[];
}

export interface AttributionQuery {
  surface: string;
  good: string;
  bad: string;
}

export interface CommitQuery {
  surface?: string;
  /** 1 for the whole commit; else only the surface's declared sources. */
  whole?: boolean;
}

export interface CommitResponse {
  commit: CommitRef;
  parents: string[];
  body: string;
  whole: boolean;
  files: Array<{ path: string; status: string; additions: number; deletions: number }>;
  /** Unified diff text. */
  diff: string;
}

/** One kept tree patch: the uncommitted edits a dirty rep ran on top of its gitHead. */
export interface PatchResponse {
  sha: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** The patch text (`git diff --binary`), cut at 2 MiB so a huge patch cannot stall the page. */
  diff: string;
  truncated: boolean;
}

export interface ChangesQuery {
  since: number;
}

export interface ChangesResponse {
  cursor: number;
  runs: RunRow[];
  bisects: BisectSummary[];
  jobs: SimJob[];
}

export interface BisectListResponse {
  bisects: BisectSummary[];
}

export interface BisectQuery {
  since?: number;
}

export interface BisectResponse {
  state: BisectState;
  steps: BisectStep[];
  cursor: number;
  logTail: string[];
  /** No new step for 5 minutes while running. */
  stalled: boolean;
}

export interface SimCatalogResponse {
  gitHead: string | null;
  scenarios: SimScenario[];
  invariants: SimInvariant[];
  /** invariantCoverage.ts NOT_COMPARED: store keys deliberately not compared, with why. */
  notCompared: Array<{ key: string; reason: string }>;
  grid: SimGridCell[];
  /** How many failures each invariant caught across the history. */
  caught: Record<string, number>;
}

export interface SimSessionsResponse {
  sessions: SimSessionSummary[];
}

export interface SimRunResponse {
  session: SimSession;
  run: SimRunRow;
  result: SimResult;
  events: SimEvent[];
  world: SimWorld | null;
  final: SimFinal | null;
  minimal: SimMinimal | null;
  shrinking: SimShrinkProgress | null;
  invariant: SimInvariant | null;
  /** The copyable lines: trace, full order, and the minimal order once shrunk. */
  replay: { trace: string; order: string; minimal: string | null };
}

export interface SimShrinkRequest {
  session: string;
  run: string;
}

export interface SimSweepRequest {
  filter?: string;
  seeds: number;
}

export interface SimJobResponse {
  job: string;
}

/** A bisect's stop takes no body; the runner sees the stop file between reps. */
export interface BisectStopResponse {
  id: string;
  stopping: boolean;
}

// ── The route table ─────────────────────────────────────────────────────────

/** No params, or no query. */
type None = Record<string, never>;

/** Every endpoint, keyed `METHOD /path` with `:params`: what it takes and what it answers. Paths are relative to /evals. */
export interface EvalsRoutes {
  "GET /health": { params: None; query: None; body: never; response: HealthResponse };
  "GET /overview": { params: None; query: OverviewQuery; body: never; response: OverviewResponse };
  "GET /surface/:id": { params: { id: string }; query: SurfaceQuery; body: never; response: SurfaceResponse };
  "GET /freeze/:id": { params: { id: string }; query: None; body: never; response: FreezeResponse };
  "GET /run/:id": { params: { id: string }; query: None; body: never; response: RunResponse };
  "GET /run/:id/file": { params: { id: string }; query: RunFileQuery; body: never; response: RunFileResponse };
  "GET /compare": { params: None; query: CompareQuery; body: never; response: CompareResponse };
  "GET /batches": { params: None; query: BatchesQuery; body: never; response: BatchesResponse };
  "GET /epoch": { params: None; query: EpochQuery; body: never; response: EpochResponse };
  "GET /attribution": { params: None; query: AttributionQuery; body: never; response: Attribution };
  "GET /commit/:sha": { params: { sha: string }; query: CommitQuery; body: never; response: CommitResponse };
  "GET /patch/:sha": { params: { sha: string }; query: None; body: never; response: PatchResponse };
  "GET /changes": { params: None; query: ChangesQuery; body: never; response: ChangesResponse };
  "POST /bisect/plan": { params: None; query: None; body: BisectPlanRequest; response: BisectPlan };
  "POST /bisect": { params: None; query: None; body: BisectStartRequest; response: BisectStartResponse };
  "GET /bisects": { params: None; query: None; body: never; response: BisectListResponse };
  "GET /bisect/:id": { params: { id: string }; query: BisectQuery; body: never; response: BisectResponse };
  "POST /bisect/:id/stop": { params: { id: string }; query: None; body: never; response: BisectStopResponse };
  "GET /sim/catalog": { params: None; query: None; body: never; response: SimCatalogResponse };
  "GET /sim/sessions": { params: None; query: None; body: never; response: SimSessionsResponse };
  "GET /sim/run/:session/:run": { params: { session: string; run: string }; query: None; body: never; response: SimRunResponse };
  "POST /sim/shrink": { params: None; query: None; body: SimShrinkRequest; response: SimJobResponse };
  "POST /sim/sweep": { params: None; query: None; body: SimSweepRequest; response: SimJobResponse };
}

export type EvalsRouteKey = keyof EvalsRoutes;
export type EvalsResponse<K extends EvalsRouteKey> = EvalsRoutes[K]["response"];

/** Every route key, in the order of the spec's table. Typed so a key missing here or misspelled fails to compile. */
export const EVALS_ROUTE_KEYS = [
  "GET /health",
  "GET /overview",
  "GET /surface/:id",
  "GET /freeze/:id",
  "GET /run/:id",
  "GET /run/:id/file",
  "GET /compare",
  "GET /batches",
  "GET /epoch",
  "GET /attribution",
  "GET /commit/:sha",
  "GET /patch/:sha",
  "GET /changes",
  "POST /bisect/plan",
  "POST /bisect",
  "GET /bisects",
  "GET /bisect/:id",
  "POST /bisect/:id/stop",
  "GET /sim/catalog",
  "GET /sim/sessions",
  "GET /sim/run/:session/:run",
  "POST /sim/shrink",
  "POST /sim/sweep",
] as const satisfies readonly EvalsRouteKey[];

type _AllRoutesListed = Exclude<EvalsRouteKey, (typeof EVALS_ROUTE_KEYS)[number]> extends never ? true : never;
const _allRoutesListed: _AllRoutesListed = true;
void _allRoutesListed;

/**
 * The route a method and path name, with its params decoded, or null. The api
 * child dispatches on it and the web fixture transport answers through it, so
 * both read one table. `path` is relative to /evals and carries no query.
 */
export function matchEvalsRoute(method: string, path: string): { key: EvalsRouteKey; params: Record<string, string> } | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  for (const key of EVALS_ROUTE_KEYS) {
    const [m, pattern] = key.split(" ") as [string, string];
    if (m !== method.toUpperCase()) continue;
    const want = pattern.slice(1).split("/");
    if (want.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < want.length && ok; i++) {
      if (want[i]!.startsWith(":")) {
        if (!parts[i]) ok = false;
        else {
          try {
            params[want[i]!.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            ok = false;
          }
        }
      } else ok = want[i] === parts[i];
    }
    if (ok) return { key, params };
  }
  return null;
}

// ── The bridge (section 3.5) ────────────────────────────────────────────────

/** One line the daemon writes to the child's stdin. */
export interface EvalsBridgeRequest {
  id: number;
  method: "GET" | "POST";
  /** Relative to /evals, without the query. */
  path: string;
  query: Record<string, string>;
  body?: unknown;
}

/** One line the child writes back. */
export interface EvalsBridgeResponse {
  id: number;
  status: number;
  body: unknown;
}

/**
 * Why the evals cannot answer on this machine. The checkout reasons come back
 * as 503 before anything is executed; `child-crashed` is a 502 with stderr.
 */
export type EvalsUnavailableReason =
  | "no-bun"
  | "no-checkout"
  | "checkout-not-owned"
  | "checkout-bad-header"
  | "checkout-not-toplevel"
  | "checkout-no-entry"
  | "child-crashed";

/** The body of every non-2xx answer. */
export interface EvalsErrorBody {
  error: string;
  reason?: EvalsUnavailableReason | "bad-request" | "not-found" | "forbidden";
  /** The child's last stderr lines, for `child-crashed`. */
  stderr?: string[];
}
