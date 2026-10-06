// Part of the shared evals wire contract (codecast docs/architecture/evals-ui.md):
// what each neutral endpoint takes and answers (section 3.4). Generic over the
// product's row, so a product keeps its own row and adds its own fields to a
// response by intersection (codecast: RunResponse<RunRow> & { calls, agents,
// guard, ... }). PURE isomorphic data: no Node or DOM APIs.

import type { EvalFlip } from "./evalResult";
import type { BatchStats, BatchVerdict, CommitRef, Epoch, EvalVisibility, FlipsResult, FootingMarker, PromptFilePair, RunDiffEntry, RunRowCore, RunRowStatus, SeparationResult, SpendDay } from "./core";
import type { BisectAnswer, BisectState, BisectStep, BisectSummary } from "./bisect";

// ── Endpoints (section 3.4) ─────────────────────────────────────────────────

/** Which panels a product's data can fill. A view whose capability is false is hidden, never shown empty. */
export interface EvalsCapabilities {
  trends: boolean;
  freezes: boolean;
  epochs: boolean;
  attribution: boolean;
  commits: boolean;
  bisect: boolean;
  changes: boolean;
  liveness: boolean;
  /** The rows name the model that answered and the judge that graded. */
  models: boolean;
  /** Two reps can be weighed side by side: their scores diffed and their replies read. */
  compare: boolean;
}

export interface HealthResponse {
  root: string;
  evalsHome: string;
  /** The eval tool's own commit. */
  gitHead: string | null;
  runsIndexed: number;
  index: { state: "cold" | "building" | "warm"; done: number; total: number | null };
  pid: number;
  startedAt: string;
  /** What the product's sources can answer; absent from a server that predates it. */
  capabilities?: EvalsCapabilities;
}

export interface OverviewQuery {
  /** A cadence name, or `all`. */
  cadence?: string;
}

/** One surface's row on the wall. */
export interface SurfaceOverview {
  id: string;
  title: string;
  route: string | null;
  model: string | null;
  freezes: { public: number; private: number };
  /** The last 30 days of batches, oldest first. */
  strip: BatchStats[];
  /** The reps behind the strip as faint dots, one per status and pixel row of score (scored reps only): the wall's resolution, not every rep. */
  dots: Array<{ batch: string; at: string; score: number | null; status: RunRowStatus }>;
  latest: BatchVerdict | null;
  /** Where the surface stands against its sources, in the product's word for it (codecast: StalenessWord). */
  staleness?: string | null;
  /** This surface's model and judge spend per day over the last 30 days; the wall sums it over its own window, as it does the total. */
  spendByDay: SpendDay[];
  epochs: Epoch[];
  footing: FootingMarker[];
  /** A batch is still landing reps. */
  landing: boolean;
}

/** A "What moved" line. A product adds its own kinds through OverviewResponse's second parameter. */
export type MovedEvent = { at: string; surface: string | null } & (
  | { kind: "epoch"; epoch: number; batch: string; changedFreezes: number }
  | { kind: "footing"; batch: string; change: "model" | "judge"; from: string | null; to: string | null }
  /** broke and fixed count the flips that say something; `noise` the ones on flapping freezes or an unchanged prompt (isNoiseFlip). */
  | { kind: "flips"; batch: string; broke: number; fixed: number; noise?: number }
  | { kind: "bisect"; id: string; outcome: BisectAnswer["kind"] | null }
);

/** The wall. `M` is a product's own "What moved" kinds (codecast: sim failures). */
export interface OverviewResponse<M = never> {
  cadence: string;
  surfaces: SurfaceOverview[];
  moved: Array<MovedEvent | M>;
  spendByDay: SpendDay[];
  bisects: BisectSummary[];
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
  model: string | null;
  route: string | null;
  /** The pass mark its reps are held to, when the product has one. */
  passMark?: number | null;
  /** A product's own gate, shown as data (union: the Jeffreys rule from its backend). */
  gate?: { rule: string; status: "green" | "red" | "unknown"; detail: string } | null;
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

export interface SurfaceResponse<R extends RunRowCore = RunRowCore> {
  surface: SurfaceInfo;
  runs: R[];
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

export interface FreezeResponse<R extends RunRowCore = RunRowCore> {
  freeze: FreezeInfo;
  /** The freeze's label, or a fixture's inline label. Its shape is the surface's own. */
  label: unknown;
  labelSource: "labels" | "inline" | null;
  moment: MomentMessage[];
  /** Where "frozen here" cuts the moment: messages before this index happened before asOf. */
  cutAt: number;
  production: { messages: MomentMessage[]; verdict: { score: number; pass: boolean; reasoning?: string | null } | null } | null;
  runs: R[];
  epochs: Epoch[];
}

/** result.json (the run layout's writeRunFolder). */
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

/** A gate a rep will be held to, before it is scored. */
export type RubricGate = Pick<GateResultJson, "id" | "title" | "decidedBy">;

/** A judged check a rep will be held to, before it is scored. */
export type RubricCheck = Pick<CheckResultJson, "id" | "ask" | "weight" | "must">;

/** What an unscored rep will be held to: the criteria in words, the pass mark, and, where the product knows them, each gate and check by name. */
export interface RunRubric {
  criteria: string | null;
  passMark: number;
  gates?: RubricGate[];
  checks?: RubricCheck[];
}

/**
 * Trouble a run recorded as it went. A fatal one stopped the run; any other
 * is a step that failed without stopping it (union: a persona whose reply
 * could not be injected), which matters most on a run that finished: the
 * behaviour being graded may never have happened.
 */
export interface RunProblem {
  id: string;
  /** Where in the run's own log it sits. */
  seq?: number | null;
  /** What was being done: "inject reply", "send email". */
  label?: string | null;
  error: string;
  fatal?: boolean;
}

/** One rep's page: the row, its result and score, and where it sits among its siblings. A product adds its own anatomy by intersection. */
export interface RunResponse<R extends RunRowCore = RunRowCore> {
  row: R;
  result: RunResultJson | null;
  score: ScoreJson | null;
  scoreVersions: ScoreVersion[];
  /** When the rep is unscored: what it will be held to. */
  rubric: RunRubric | null;
  /** What this kind of rep never has, left out of its page rather than drawn empty or guessed (union: a simulation answers nothing, and an eval result records no pass mark). */
  without?: Array<"reply" | "mark">;
  /** Trouble the run recorded, shown in its header. Codecast sends none: a crash is its log tail. */
  problems?: RunProblem[];
  sends: RunSendView[];
  /** The judge's call. A product that keeps only what the judge said sends an empty prompt, and the page shows the reply as the judge's words. */
  judge: { model: string | null; prompt: string; reply: string | null; costUsd: number | null } | null;
  /** The tail of the rep's log, shown first when the rep crashed. */
  logTail: string | null;
  /** This batch's other reps on the same freeze. */
  siblings: R[];
  /** The same freeze in the previous and next batch, by run id. */
  adjacent: { previous: string | null; next: string | null };
}

export interface CompareQuery {
  a: string;
  b: string;
}

export interface CompareResponse<R extends RunRowCore = RunRowCore> {
  a: R;
  b: R;
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
  /** Left out, Tier 0 finds the ends itself (section 5): bad is the newest red batch, good the newest earlier batch it holds still against. */
  good?: string;
  bad?: string;
  /** Search every commit in the range, not only those touching declared sources (--all-commits). */
  allCommits?: boolean;
  /** Weigh only this freeze (an id or an id prefix), as `bisect plan --freeze` does, so the free answer and the plan read the same freezes. */
  freeze?: string;
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
  /** Unified diff text, cut at 2 MiB as a patch's is. */
  diff: string;
  /** Set when the diff text was cut; the file list is always whole. */
  truncated?: boolean;
}

export interface ChangesQuery {
  since: number;
}

/** What changed since a cursor. A product adds its own changed things by intersection (codecast: sim jobs). */
export interface ChangesResponse<R extends RunRowCore = RunRowCore> {
  cursor: number;
  runs: R[];
  bisects: BisectSummary[];
}

export interface BisectListResponse {
  bisects: BisectSummary[];
  /** The bisect holding the one-bisect lock, else null: a start waits for it. */
  running: string | null;
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
  /**
   * The two controls on the flipped freezes, once either has a rep: how many
   * passed at each end, and whether the bad end separated from the good one
   * (the stats `check` uses). What every answer rests on, so the page leads
   * with it. Null before any control rep.
   */
  controls?: { good: { passed: number; reps: number }; bad: { passed: number; reps: number }; separation: SeparationResult } | null;
}
