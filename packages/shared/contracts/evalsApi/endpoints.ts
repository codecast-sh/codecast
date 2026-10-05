// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. What each endpoint takes and
// answers (section 3.4). The neutral answers live in @platform/evals/contract,
// generic over the row; codecast's are those on its own RunRow, extended
// where codecast says more (the run folder, the sim). Extension rather than an
// intersection, so a widened field (an overview's surfaces) reads as
// codecast's type alone and its array methods keep codecast's row. The run
// anatomy, file, patch, search and sim shapes are codecast's own. PURE
// isomorphic data: no Node or DOM APIs.

import type {
  ChangesResponse as CoreChangesResponse,
  CompareResponse as CoreCompareResponse,
  FreezeResponse as CoreFreezeResponse,
  MovedEvent as CoreMovedEvent,
  OverviewResponse as CoreOverviewResponse,
  RunResponse as CoreRunResponse,
  SurfaceInfo as CoreSurfaceInfo,
  SurfaceOverview as CoreSurfaceOverview,
  SurfaceResponse as CoreSurfaceResponse,
  TokenUsage,
} from "@platform/evals/contract";
import type { EvalRoute, GuardStatus, RunRow, StalenessWord } from "./core";
import type { SimEvent, SimFinal, SimGridCell, SimInvariant, SimJob, SimMinimal, SimResult, SimRunRow, SimScenario, SimSession, SimSessionSummary, SimShrinkProgress, SimWorld } from "./sim";

export type {
  AttributionQuery,
  BatchesQuery,
  BatchesResponse,
  BisectListResponse,
  BisectQuery,
  BisectResponse,
  ChangesQuery,
  CheckResultJson,
  CommitQuery,
  CommitResponse,
  CompareQuery,
  EpochQuery,
  EpochResponse,
  FreezeInfo,
  GateResultJson,
  HealthResponse,
  LedgerCell,
  LedgerRow,
  MomentMessage,
  OverviewQuery,
  RunResultJson,
  RunSendView,
  ScoreJson,
  ScoreVersion,
  SurfaceQuery,
  TokenUsage,
} from "@platform/evals/contract";

// ── Endpoints (section 3.4) ─────────────────────────────────────────────────

/** One surface's row on the wall: a call or an agent surface, its model, and where it stands against its sources. */
export interface SurfaceOverview extends CoreSurfaceOverview {
  route: EvalRoute;
  model: string;
  staleness: StalenessWord;
}

/** A "What moved" line for a multiplayer sim run that failed: codecast's own kind. */
export type SimFailureMoved = { at: string; surface: string | null } & { kind: "sim-failure"; session: string; run: string; scenario: string; invariant: string };

/** A "What moved" line. */
export type MovedEvent = CoreMovedEvent | SimFailureMoved;

export interface OverviewResponse extends CoreOverviewResponse<SimFailureMoved> {
  surfaces: SurfaceOverview[];
  sim: SimSessionSummary | null;
}

/** A surface's meta as the header shows it. */
export interface SurfaceInfo extends CoreSurfaceInfo {
  route: EvalRoute;
  model: string;
  criteria: string | null;
  freezes: { public: number; private: number };
  sources: string[];
  reps: { check: number; smoke?: number };
  maxUsdPerRep: number;
}

export interface SurfaceResponse extends CoreSurfaceResponse<RunRow> {
  surface: SurfaceInfo;
}

export type FreezeResponse = CoreFreezeResponse<RunRow>;

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

/** A rep as the run page reads it: the shared answer plus the run folder's anatomy. */
export interface RunResponse extends CoreRunResponse<RunRow> {
  run: RunJson;
  calls: CallDetail[];
  agents: AgentDetail[];
  guard: GuardEntry[];
  files: RunFileEntry[];
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

export type CompareResponse = CoreCompareResponse<RunRow>;

/** One kept tree patch: the uncommitted edits a dirty rep ran on top of its gitHead. */
export interface PatchResponse {
  sha: string;
  files: Array<{ path: string; additions: number; deletions: number }>;
  /** The patch text (`git diff --binary`), cut at 2 MiB so a huge patch cannot stall the page. */
  diff: string;
  truncated: boolean;
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
export interface ChangesResponse extends CoreChangesResponse<RunRow> {
  jobs: SimJob[];
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
