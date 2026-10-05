// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. What each endpoint takes and
// answers (section 3.4). PURE isomorphic data: no Node or DOM APIs.

import type { EvalFlip } from "../evalResult";
import type { BatchStats, BatchVerdict, CommitRef, Epoch, EvalRoute, EvalVisibility, FlipsResult, FootingMarker, GuardStatus, PromptFilePair, RunDiffEntry, RunRow, RunRowStatus, SeparationResult, SpendDay, StalenessWord } from "./core";
import type { BisectAnswer, BisectState, BisectStep, BisectSummary } from "./bisect";
import type { SimEvent, SimFinal, SimGridCell, SimInvariant, SimJob, SimMinimal, SimResult, SimRunRow, SimScenario, SimSession, SimSessionSummary, SimShrinkProgress, SimWorld } from "./sim";

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
  /** The reps behind the strip as faint dots, one per status and pixel row of score (scored reps only): the wall's resolution, not every rep. */
  dots: Array<{ batch: string; at: string; score: number | null; status: RunRowStatus }>;
  latest: BatchVerdict | null;
  staleness: StalenessWord;
  /** This surface's model and judge spend per day over the last 30 days; the wall sums it over its own window (wallSpend), as it does the total. */
  spendByDay: SpendDay[];
  epochs: Epoch[];
  footing: FootingMarker[];
  /** A batch is still landing reps. */
  landing: boolean;
}

/** A "What moved" line. */
export type MovedEvent = { at: string; surface: string | null } & (
  | { kind: "epoch"; epoch: number; batch: string; changedFreezes: number }
  | { kind: "footing"; batch: string; change: "model" | "judge"; from: string | null; to: string | null }
  /** broke and fixed count the flips that say something; `noise` the ones on flapping freezes or an unchanged prompt (isNoiseFlip). */
  | { kind: "flips"; batch: string; broke: number; fixed: number; noise?: number }
  | { kind: "bisect"; id: string; outcome: BisectAnswer["kind"] | null }
  | { kind: "sim-failure"; session: string; run: string; scenario: string; invariant: string }
);

export interface OverviewResponse {
  cadence: string;
  surfaces: SurfaceOverview[];
  moved: MovedEvent[];
  spendByDay: SpendDay[];
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

export interface SearchQuery {
  q: string;
}

/** What the nav's search finds in the index that no page has loaded yet (section 4.1): freezes and runs by id prefix. */
export interface SearchResponse {
  freezes: Array<{ id: string; name: string; surface: string }>;
  runs: Array<{ id: string; surface: string; freezeName: string | null; batch: string | null }>;
}

/** How many of each kind a search answers. */
export const EVALS_SEARCH_LIMIT = 8;

/**
 * The search rule, shared by the api child (over the index) and the fixture
 * world (over its rows): a freeze id or a run id that starts with the query,
 * at least three characters, newest runs first.
 */
export function searchRows(rows: ReadonlyArray<Pick<RunRow, "id" | "surface" | "freezeId" | "freezeName" | "batch" | "stamp">>, query: string): SearchResponse {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return { freezes: [], runs: [] };
  const freezes = new Map<string, SearchResponse["freezes"][number]>();
  const runs: Array<SearchResponse["runs"][number] & { stamp: string }> = [];
  for (const r of rows) {
    if (freezes.size < EVALS_SEARCH_LIMIT && r.freezeId.toLowerCase().startsWith(q) && !freezes.has(r.freezeId)) freezes.set(r.freezeId, { id: r.freezeId, name: r.freezeName ?? r.freezeId.slice(0, 8), surface: r.surface });
    if (r.id.toLowerCase().startsWith(q)) runs.push({ id: r.id, surface: r.surface, freezeName: r.freezeName, batch: r.batch, stamp: r.stamp });
  }
  runs.sort((a, b) => b.stamp.localeCompare(a.stamp));
  return { freezes: [...freezes.values()], runs: runs.slice(0, EVALS_SEARCH_LIMIT).map(({ stamp: _stamp, ...r }) => r) };
}

export interface ChangesResponse {
  cursor: number;
  runs: RunRow[];
  bisects: BisectSummary[];
  jobs: SimJob[];
}

export interface BisectListResponse {
  bisects: BisectSummary[];
  /** The bisect holding the one-bisect lock (bisects/running.json, its process alive), else null: a start waits for it. */
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
  /** The newest sweep job started from the catalog page, with its outcome and last lines once it ended. */
  lastSweep?: SimJob | null;
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
  /** The newest shrink job started on this run from the page, with its outcome and last lines once it ended. */
  lastShrink?: SimJob | null;
  invariant: SimInvariant | null;
  /** The copyable lines: trace, full order, and the minimal order once shrunk. */
  replay: {
    trace: string;
    order: string;
    minimal: string | null;
    /** `./evals bisect start --sim <artifact folder>`: the free sim bisect that names the commit that broke the run. Null for a passing run. */
    bisect: string | null;
  };
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
