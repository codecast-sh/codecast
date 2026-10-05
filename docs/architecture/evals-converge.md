# Spec: converging evals on `@platform/evals` (ct-57097, pl-810)

I checked the key facts against the code on 2026-10-05. Union origin/main is now `5e4e4ea97b`; every union file:line cited in the surveys has to be rechecked when work starts. The codecast check programs already include `evals` (`.codecast/check.toml`).

## 0. Basis

The spec starts from Design 1: one layered package, a single isomorphic query handler, and a headless client under thin React views. It takes these safety grafts from Design 0 and the judges:

- **RunRow wire shape.** Codecast's `RunRow` keeps the exact shape it has today. Platform owns a neutral `RunRowCore`, and codecast defines `RunRow = RunRowCore & CodecastRunFields`. There is no `ext` slot.
- **Run status.** `RunRowStatus` stays `pass|fail|crash|dry|unscored`. Liveness is a separate optional `lastEventAt` field.
- **Naming.** The run-set result stays `BatchVerdict`. The platform judge grade `Verdict` (`model.ts:193`) is not renamed, because eaiden's `adapters/freeze.ts:5` imports it.
- **Boot path.** On the cast boot path, type-only re-exports land first. The runtime switch is its own commit, followed by a boot smoke test and `cut-cli-release.yml -f dry_run=true`.
- **Commit granularity.** Views move one group per commit, each with a screenshot diff. Union mounts on a parallel route first.
- **`./html` stays.** `packages/evals/src/commands/publish.ts:8` and eaiden both use it. No guard bans it.

Two design ideas are dropped:

- **Porting union's Jeffreys gate, eras and INFRA voiding into platform.** Each rule should have exactly one implementation. Union's gate already has one, in its backend, so the shared views show the gate's result as data (a `gate` field). Platform implements only the codecast run-set verdict. This removes a second union mirror for the backend.
- **Moving the bisect runner and state store into `./fs`.** No second product runs bisects. The pure bisect math moves; the runner and store stay in codecast.

## 1. Goal and done bar

The goal is one evals package that analyses, serves and renders runs, so every product shares one verdict implementation and one look. Done means all four of these hold:

1. **Codecast `/evals` behaves exactly as today.**
   - The parity harness output (section 7, C0) is byte-identical before and after each analysis or query move. The only allowed diff is the new `capabilities` field on `/health`.
   - The 7 web mount tests pass, and `cast check` is green.
   - cast browser screenshots match before and after for every listed page, in light, dark and minimal, using the fixture transport.
   - One manual pass on real daemon data. Those screenshots stay in `/tmp` and are never uploaded.
2. **Union admin renders its runs through the shared views** at `/admin/evals/v2`. This covers eval runs and simulations as surfaces, with a run list, run detail, compare, and trends (score strip, seismograph, batch verdicts and flips) where the data allows. Panels whose data union lacks are hidden by capabilities, never shown empty.
3. **Eaiden `xrun` still works.** After `bun install`, `bun run typecheck`, `bun run test` and a `xrun runs --help` smoke all pass in `tools/xrun`.
4. **One verdict implementation.** `batchVerdict`, `separate`, flips and footing live only in `@platform/evals/analysis`. Codecast's CLI, the codecast api child, union's browser adapter and eaiden all call that code. Union's gate rule stays union's single implementation and is displayed, not recomputed.

## 2. Package boundary

### Layers

`~/src/platform/packages/evals/src` gets five new subpaths. A layer imports only the layers listed above it; `src/layers.test.ts` enforces that rule and the purity rules below.

| Subpath | Purity | Contents |
|---|---|---|
| `./contract` | Pure, zero deps | Neutral types, `RunRowCore` plus its validator, the route table and `matchRoute`, the bridge protocol, `evalsBatchRef`, `unaskedSet`, `flipCounts`, `spendByDayOf` |
| `./analysis` | Pure, isomorphic | rng, stats, verdict, flips, epochs walk, attribution, bisect math, evalResult |
| `./query` | Pure | `createEvalsHandler(sources, policy)` and the row view builders |
| `./client` | Framework-free | Transports, memory-only resource cache, polling, liveness, `evalsPaths(basePath)`, view models |
| `./react` | `'use client'` | Provider, hooks, views, pages, `styles.css`, `tokens.css` |

Purity rules:
- `./contract`, `./analysis`, `./query` and `./client` import no `node:*`, `react`, `commander` or DOM.
- `./react` imports nothing node-side.
- The existing `.`, `./render`, `./html`, `./cli`, `./fs`, `./fixture` and `./snippet` are unchanged.

### File moves: codecast to platform

| From (codecast) | To (`platform/packages/evals/src`) | Seam left behind in codecast |
|---|---|---|
| `packages/shared/random/index.ts` (makeRng, imported as `@codecast/shared/random`) | `analysis/rng.ts` | File deleted; 3 importers repointed |
| `packages/evals/src/stats.ts` + `stats.test.ts` | `analysis/stats.ts` + test | Deleted; importers repointed |
| `packages/evals/src/evalResult.ts` + test | `analysis/evalResult.ts` + test | Deleted; `cli/src/lineProfileCommand.ts:12` and `cli/src/cardCommand.ts:25` repointed |
| `packages/shared/contracts/evalResult.ts` | `contract/evalResult.ts` | Becomes a re-export |
| `contracts/evalsApi/core.ts`, neutral part (primitives, `RunRowCore`, field validator, `evalsBatchRef`/`resolveEvalsBatchRef`, the RE constants, `SeparationResult`, `Footing`, `BatchStats`, `BatchVerdict`, `VerdictFlip`, `SkippedBatch`, `Epoch`, `FootingMarker`, `PromptFilePair`, `CommitRef`, `FlipsResult`, `RunDiffEntry`, `spendByDayOf`, `unaskedSet`, `flipCounts`) | `contract/core.ts` | `core.ts` keeps `GuardCounts`/`GUARD_STATUSES`, `StalenessWord`, `CodecastRunFields` (`sourceHash`, `guard`, `scoreVersions`), `RunRow = RunRowCore & CodecastRunFields`, and `runRowProblems` over the combined field map in today's field order (`guard` as a `{ name: 'guard', ok }` field spec, so its messages stay as they are) |
| `contracts/evalsApi/bisect.ts` (whole) | `contract/bisect.ts` | Becomes a re-export |
| `contracts/evalsApi/endpoints.ts`, neutral responses (Health, Overview, Surface, Freeze, Run core, Compare, Batches, Epoch, Attribution query, Commit, Changes, BisectList, Bisect), generic over `R extends RunRowCore` | `contract/views.ts` | Codecast keeps RunJson, CallDetail, AgentDetail, GuardEntry, RunFile, Patch, Search and Sim*. It adds its fields by intersection: `RunResponse<RunRow> & { run, calls, agents, guard, files, extra }`, `SurfaceInfo & { route: EvalRoute; model: string; criteria, freezes, sources, reps, maxUsdPerRep }`, `SurfaceOverview & { route, model, staleness: StalenessWord }`, `OverviewResponse<SimFailure> & { surfaces, sim }` and `ChangesResponse<RunRow> & { jobs }` |
| `contracts/evalsApi/routes.ts`: `matchEvalsRoute` logic and the bridge types | `contract/routes.ts` as `matchRoute(keys, method, path)`, `Route<P, Q, Res, B>`, `None`, `EvalsViewRoutes<R, M>`, `EVALS_VIEW_ROUTE_KEYS`, `EvalsBridgeRequest`/`Response` and `EvalsErrorBody` | Codecast `EvalsRoutes = EvalsViewRoutes<RunRow, SimFailure> & extras`, where the extras re-key overview, surface, run and changes with codecast's wider answers (a plain intersection; checked type for type against today's table) and add `/run/:id/file`, `/patch/:sha`, `/search`, POST bisect routes and `/sim/*`. `EVALS_ROUTE_KEYS` and `matchEvalsRoute` keep their names and their order (`matchEvalsRoute = (m, p) => matchRoute(EVALS_ROUTE_KEYS, m, p)`). Its bridge types add `id`, the `GET`/`POST` method and a required `query` by intersection, and its error body narrows `reason` to `EvalsUnavailableReason` and its three words |
| `packages/evals/src/core/verdict.ts` (created by C1 from `commands/verdict.ts`) | `analysis/verdict.ts` | `commands/verdict.ts` keeps `positiveNumber`, `verdictLinesOf`, `setVerdict`, and the policy-bound instance |
| `core/flips.ts` (`flipsBetween`) | `analysis/flips.ts` | `history/flips.ts` keeps `flipExamples` |
| `core/epochs.ts` (walk, `timeline`, `promptPairs`, `sortPromptFiles`, `footingMarkers`; texts are hashed by the reader's `hash`) | `analysis/epochs.ts` | `history/epochs.ts` keeps `folderPromptReader` (sha256 moves into it as `hash`), re-exports `sortPromptFiles`, and binds the reader and ruler defaults |
| `core/attribution.ts` (`attribute`, `freezeFileChange`, `largestDrops`) | `analysis/attribution.ts` | `history/attribution.ts` keeps `repoGit`, `declaredPaths`, `ATTRIBUTION_EXTRA_PATHS` and `codecastAttributionMeta` |
| `core/bisect.ts` (pure parts of `reading.ts`; `plan.ts`'s `planFrom`/`renderPlan` over `PlanDeps`; and from `probe.ts`: `ProbeEnv`, treeLabel, treeOf, candidateKey, renderBatch, renderKeys, renderClasses, mapToClass, probeSet, missingReps) | `analysis/bisect.ts` | `bisect/{runner,state,simProbe}.ts`, `probe.ts` `treeEnv`/`folderParams` and the `gitHead()` defaults, `plan.ts` `PlanWorld`, `planDeps` (cost/state reads, tool head) and `buildPlan` |
| `history/analysis.test.ts`, pure cases of `bisect/bisect.test.ts` | `analysis/*.test.ts` | |
| `core/query.ts` (created by C3 from `api/views.ts`: ledgerOf, compareView, epochView, onRows, overview strip, batches, plus route dispatch for the neutral routes) | `query/handler.ts`, `query/views.ts` | `api/handlers.ts` answers codecast's own routes and hands the rest to the neutral handler. `api/sources.ts` holds the index load, `/health` and the `EvalsSources` object. `api/views.ts` keeps codecast's own reads (freeze page, run folder, run pair, freeze counts, the staleness worker, the sim overview). `files.ts`, `git.ts`, `simHistory.ts`, `spawn.ts`, `staleWorker.ts` and `bisects.ts` stay |
| `web/lib/evals/client.ts`, minus `loopbackTransport` | `client/transport.ts` | `loopbackTransport` stays (vault discovery) |
| neutral part of `web/store/evalsStore.ts` (cache shape) | `client/cache.ts` (`EvalsResourceCache`, `memoryResourceCache`) | evalsStore keeps discovery, unavailable reasons and zustand, and implements `EvalsResourceCache` |
| `web/lib/evals/hooks.ts` (`useEvalsResource`, `useEvalsChanges`) | `react/hooks.ts` | `useEvalsConnection` stays |
| `components/evals/evalsPaths.ts` + test | `client/paths.ts` (`evalsPaths(basePath)`) | `lib/tabSafePath.ts` imports `evalsPaths('/evals')` |
| `verdictModel`, `surfaceModel`, `seismographModel`, `freezeModel`, `runModel`(+test), `wallModel`(+test), neutral `bisectModel`, `charts/scale.ts`, `format.ts` | `client/models/*` | |
| Views: `charts/Well`, `charts/ScoreStrip`, `parts.tsx`, `EvalsNav`, `EvalsShell`, `GateList`, `JudgeChecks`, `CostTrack`, `RunView`, `SurfaceView`, `SurfaceWallView`, `WhatMoved`, `Seismograph`, `FreezeView`, `FreezeLedger`, `CompareView`, `ComparePanel`, `EpochDiffSheet`, `AttributionView`, `CommitPanel`, `BisectRuler`, `BisectView`, `BisectListView`, `BisectPlanPanel`, pages `Home/Surface/Run/Freeze/Compare/Code/Bisect*` | `react/{shell,run,surface,freeze,bisect}/*` and `react/EvalsApp.tsx` | |
| `evals.css`, `run.css`, `surface.css`, `wall.css`, `bisect.css` | `react/{shell,run,surface,freeze,bisect}/*.css`, composed by `react/styles.css` | |

Stays in codecast for good:
- All of `packages/evals/src/adapters`, `surfaces`, `registry.ts`, `surface.ts`, `paths.ts`, `models.ts`, `state.ts`, `provenance.ts`, `layout.ts`, `served.ts`, `labels.ts`, `signals.ts`, `snippet.ts`, `main.ts`, `index.ts`, `git.ts`, `history/runIndex.ts` and `commands/*`.
- The run-anatomy views `AgentTranscript`, `CallPane`, `GuardLog` and `RunFiles`, their helpers (`guardCounts`/`GUARD_WORDS` in GuardLog, `fileTree`/`fileLanguage` in RunFiles), `runPanels.tsx` and `runPanels.css`, which render through the `useRunPanels` slot.
- All sim views: `SimCatalogView`, `SimRunView`, `DeliveryTimeline`, `OrderStrip`, `simLanes`, `simModel`, `simJobState`, `pages/Sim*` and `sim.css`.
- `evalsApi/sim.ts`, `__fixtures__/*` and `shortcuts/registry.ts:473-500`.

## 3. Interfaces (TypeScript)

```ts
// ── @platform/evals/contract ─────────────────────────────────────────
export type RunRowStatus = 'pass' | 'fail' | 'crash' | 'dry' | 'unscored';
export interface RunRowCore {
  id: string; surface: string; freezeId: string; freezeName: string;
  seed: number; stamp: string; batch: string | null; batchAt: string | null; cadence: string | null;
  status: RunRowStatus; score: number | null; passMark: number | null;
  gatesFailed: string[]; checks: Record<string, number>; missedFloors: string[];
  model: string | null; judgeModel: string | null; ruler: string | null;
  gitHead: string | null; dirty: boolean; promptSha: string | null;
  // Promoted by P1: attribution reads them (endpoints, freeze identity, live reads, what the rep ran).
  visibility: EvalVisibility; mainSha: string | null; offBranch: boolean; treePatch: string | null;
  sourceHashDisk: string | null; freezeSha: string | null; liveReads: number;
  costUsd: number; judgeCostUsd: number; realMs: number;
  /** Liveness only; never validated, never read by verdict math. */
  lastEventAt?: string | null;
}
// As built by P1: every moving module is typed against RunRowCore. A product
// without git provenance fills the promoted fields with null, false, 0 and
// 'private' (union's mapRows). CodecastRunFields is sourceHash, guard, scoreVersions.
export type FieldKind = 'string'|'number'|'boolean'|'string?'|'number?'|'strings'|'numbers-record';
/** A kind by name, or a product's own check with the name its message uses (codecast: guard). */
export type FieldSpec = FieldKind | { name: string; ok(v: unknown): boolean };
export const RUN_ROW_CORE_FIELDS: Record<Exclude<keyof RunRowCore,'lastEventAt'>, FieldKind>;
/** Field lines in the map's order, then unknown status and visibility, then `extra`'s lines. */
export function rowProblems(value: unknown, fields: Record<string, FieldSpec>, extra?: (row: Record<string, unknown>) => string[]): string[];
export const runRowCoreProblems: (value: unknown) => string[];   // rowProblems over RUN_ROW_CORE_FIELDS

export interface EvalsCapabilities {
  trends: boolean; freezes: boolean; epochs: boolean; attribution: boolean;
  commits: boolean; bisect: boolean; changes: boolean; liveness: boolean;
}
export interface SurfaceInfo {
  id: string; title: string; model: string | null; route: string | null;
  passMark?: number | null;   // optional: codecast's SurfaceInfo has none, and its wire shape stays as it is
  /** A product's own gate, shown as data (union: Jeffreys rule from its backend). */
  gate?: { rule: string; status: 'green' | 'red' | 'unknown'; detail: string } | null;
}
export interface HealthResponse { /* existing fields */ capabilities?: EvalsCapabilities }
export interface Route<P, Q, Res, B = never> { params: P; query: Q; body: B; response: Res }
/** M: a product's own "What moved" kinds. A list can only widen through a parameter: an intersection would narrow it. */
export interface OverviewResponse<M = never> { cadence; surfaces: SurfaceOverview[]; moved: Array<MovedEvent | M>; spendByDay; bisects }
export interface EvalsViewRoutes<R extends RunRowCore = RunRowCore, M = never> {
  'GET /health': Route<None, None, HealthResponse>;
  'GET /overview': Route<None, OverviewQuery, OverviewResponse<M>>;
  'GET /surface/:id': Route<{ id: string }, SurfaceQuery, SurfaceResponse<R>>;
  'GET /freeze/:id': Route<{ id: string }, None, FreezeResponse<R>>;
  'GET /run/:id': Route<{ id: string }, None, RunResponse<R>>;
  'GET /compare': Route<None, CompareQuery, CompareResponse<R>>;
  'GET /batches': Route<None, BatchesQuery, BatchesResponse>;
  'GET /epoch': Route<None, EpochQuery, EpochResponse>;
  'GET /attribution': Route<None, AttributionQuery, Attribution>;
  'GET /commit/:sha': Route<{ sha: string }, CommitQuery, CommitResponse>;
  'GET /changes': Route<None, ChangesQuery, ChangesResponse<R>>;
  'GET /bisects': Route<None, None, BisectListResponse>;
  'GET /bisect/:id': Route<{ id: string }, BisectQuery, BisectResponse>;
}
export function matchRoute<K extends string>(keys: readonly K[], method: string, path: string): { key: K; params: Record<string, string> } | null;
export interface EvalsBridgeRequest { method: string; path: string; query?: Record<string, string>; body?: unknown }
export interface EvalsBridgeResponse { status: number; body: unknown }
export interface EvalsErrorBody { error: string; reason?: string; stderr?: string[] }
// The neutral RunResponse<R> is { row, result, score, scoreVersions, rubric, sends, judge, logTail, siblings, adjacent }:
// what the Run views read. SurfaceOverview's route and model are string | null and its staleness an optional string.

// ── @platform/evals/analysis ─────────────────────────────────────────
// As P1 built it from C1's codecast core/, typed against RunRowCore.
export type VerdictRun = Pick<RunRowCore, 'id'|'seed'|'score'|'gatesFailed'|'missedFloors'|'costUsd'|'batch'|'cadence'>
  & { status: RunStatus /* model.ts, includes 'running' */; freezeId?: string | null; model?: string | null; liveReads?: number; createdAt?: string; visibility?: EvalVisibility }
  & Partial<Pick<RunRowCore, 'freezeName'|'judgeCostUsd'|'judgeModel'|'dirty'|'gitHead'|'batchAt'|'stamp'|'ruler'>>;
export type RulerOf<R extends VerdictRun = VerdictRun> = (r: R) => string | null;
export interface VerdictPolicy<R extends VerdictRun = VerdictRun> {
  passed(rep: R): boolean;          // codecast: repPassed = statusPassRule(PASS_AT)
  ruler(rep: R): string | null;     // codecast: defaultRuler (index value, else folder read)
}
/** The pass rule at a mark: every gate held, no check under its floor, score >= passAt. Codecast's passesAt. */
export function passMarkRule(passAt: number): (score: number, gatesFailed: number, missedFloors: number) => boolean;
/** Codecast's repPassed: status pass, or dry with passMarkRule holding. adapters/replay.ts now defines repPassed from it. */
export function statusPassRule(passAt: number): (r: Pick<VerdictRun,'status'|'score'|'gatesFailed'|'missedFloors'>) => boolean;
/** Every function that reads whether a rep passed, or its ruler. Same signatures as before; a ruler left out is the policy's. */
export function makeVerdict<P extends VerdictRun = VerdictRun>(policy: VerdictPolicy<P>): {
  policy; passed; majority; footingOf; previousRuns; previousRunSet; pooledRuns; verdictFlips; batchStats; batchFlips; batchVerdict;
};
export type VerdictKit<P extends VerdictRun = VerdictRun> = ReturnType<typeof makeVerdict<P>>;
// Policy-free, exported directly:
export { onePerSeed, batchSet, gradedSet, askedSet, majorityBy /* (runs, passed) */, footingWith /* (rep, ruler) */, footingChange,
         nightStrata, batchStarts, upTo, scoreOrZero, BISECT_CADENCE, CADENCE_BASELINE_BATCHES };
// BatchVerdict gains `unfooted?: true` in P1: set only when every graded (pass or fail) rep on both sides has model and
// judgeModel strictly null (unfootedReps). A run summary that leaves judgeModel out never counts, and no graded codecast
// rep has a null model (checked on the 8,347-row index), so codecast's answers do not change.

// A function outside verdict.ts that needs the policy takes the kit as its first argument:
export function flipsBetween(v: VerdictKit, rows, a: string, b: string, ruler?: RulerOf): FlipsResult;
export function readProbe(v: VerdictKit, set, focus, mode, goodControl): ProbeReading;
export function failedControls(v: VerdictKit, set, controls): string[];

export interface PromptReader {
  files(runId: string): string[];
  text(runId: string, file: string): string | null;
  size(runId: string, file: string): number | null;
  /** A short identity for a text (codecast: sha256). Optional: without it the text is its own identity. No node:crypto in the walk. */
  hash?(text: string): string;
}
export function epochsOf(rows, surface: string, reader: PromptReader): Epoch[];           // reader is required here
export function epochPromptDiffs(rows, surface: string, n: number, reader: PromptReader): PromptFilePair[];
export function footingMarkers(rows, ruler: RulerOf): FootingMarker[];                    // ruler is required here
export interface AttributionGit { /* unchanged, now core/attribution.ts */ }
export interface AttributionHeads { heads: Record<string, { mainSha: string | null; reason?: string; near?: string }> }
export interface AttributionMeta {
  declaredPaths(surface: string, shas: string[], git: AttributionGit): string[];
  surfaceInfo(surface: string): { model: string; route: string; sources: string[] } | null;
  readHeads(): AttributionHeads | null;
  freezeSnapshotPath(freezeId: string): string | null;
}
/** input.git and input.reader are required; codecast's history/attribution.ts fills repoGit() and folderPromptReader(). */
export function attribute(input: AttributionInput, meta: AttributionMeta, v: VerdictKit): Attribution;
export interface PlanDeps<W extends { rows: RunRowCore[] }> {
  verdict: VerdictKit; meta: Pick<AttributionMeta, 'surfaceInfo'>;
  perRepUsd(surface: string, model: string, world: W): number;   // codecast: state.ts perRepUsd over EVALS_HOME's spend
  toolHead(): string;                                            // codecast: gitHead(); keys Tier 1's render batches
}
/** The attribution is a value or a thunk (read after the surface is known); the product computes it, so bisect never imports attribution. */
export function planFrom<W>(args: PlanArgs, world: W, deps: PlanDeps<W>, attribution: Attribution | (() => Attribution), tier1?: Tier1 | null): BisectPlan;
export function renderPlan<W>(plan: BisectPlan, args: PlanArgs, world: W, env: ProbeEnv, deps: PlanDeps<W>, o?): Promise<{ plan; legacy }>;
export function liveness(lastEventAt: string | null | undefined, now: number, stallAfterMs: number): 'live' | 'stalled' | null;  // new in P1
// The barrel exports bisect's renderKeys under its name and epochs' as epochRenderKeys (the two key renders differently).
// probeSet is generic (<R extends RunRowCore>(rows: R[], batch) => R[]) so a product gets its own rows back.

// ── @platform/evals/query ────────────────────────────────────────────
// The target below. As C3 built it in codecast's core/query.ts (typed against codecast's RunRow and contract),
// every source is required and the view code reads what codecast's answers need, so P3 starts from that file:
//   health(); rows() (no filter: the same array until the rows change, which keys onRows); surfaces() (sync);
//   prompts: PromptReader; freezeCounts(); freeze(id, rows) (the page without epochs; the query adds them);
//   staleness(); run(row) (the folder's detail; the query adds row, siblings and adjacent); pair(a, b) (compare's
//   diff and replies); flipExamples(surface, freezeIds, a, b); git { verify, touching, between, commit,
//   attribution, meta }; bisects { summaries (no settle, for the wall), settle, running, get }; sim(); jobs().
// The row-change cursor behind /changes lives in the handler, not in a source. The handler takes a VerdictPolicy
// and builds its own kit; it adds no capabilities yet (P3 derives them once sources are optional, and C9's
// parity allows that one diff). EVALS_VIEW_ROUTE_KEYS, the request checks (need, flag, posInt, posNum,
// endpointRef, ranFreezes) and the error answer (answer, noRoute) live in core/query.ts until P3 places them (P1 placed
// EVALS_VIEW_ROUTE_KEYS in contract/routes.ts, same keys in the same order),
// and codecast's own routes in api/handlers.ts reuse them.
export interface EvalsSources<R extends RunRowCore = RunRowCore> {
  rows(filter: { surface?: string; batch?: string; since?: string }): Promise<R[]>;
  surfaces(): Promise<SurfaceInfo[]>;
  run?(id: string): Promise<RunResponse<R> | null>;
  freezes?: { get(id: string): Promise<FreezeResponse<R> | null> };
  prompts?: PromptReader;
  git?: { attribution: AttributionGit; meta: AttributionMeta; commit(sha: string, q: CommitQuery): Promise<CommitResponse | null> };
  changes?(q: ChangesQuery): Promise<ChangesResponse>;
  bisects?: { list(): Promise<BisectListResponse>; get(id: string, q: BisectQuery): Promise<BisectResponse | null> };
}
export interface HandlerPolicy<R extends RunRowCore> extends VerdictPolicy<R> { stallAfterMs?: number }
export function capabilitiesOf(sources: EvalsSources<any>): EvalsCapabilities; // derived from which sources exist
export function createEvalsHandler<R extends RunRowCore>(sources: EvalsSources<R>, policy: HandlerPolicy<R>):
  (req: EvalsBridgeRequest) => Promise<EvalsBridgeResponse>;   // 404 body for unknown keys so hosts can chain extras first

// ── @platform/evals/client ───────────────────────────────────────────
export interface EvalsTransport { readonly kind: string; send(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse> }
export function localTransport(handler: (r: EvalsBridgeRequest) => Promise<EvalsBridgeResponse>): EvalsTransport;
export function httpTransport(baseUrl: string, init?: { headers?: Record<string, string>; credentials?: RequestCredentials }): EvalsTransport;
export interface EvalsResourceCache {           // memory-only by contract: no persistence method exists
  get(key: string): CachedResource | undefined;
  set(key: string, value: CachedResource): void;
  subscribe(key: string, fn: () => void): () => void;
  clear(pred?: (key: string) => boolean): void;
}
export function memoryResourceCache(): EvalsResourceCache;
export interface PollPolicy { intervalMs: number; pauseWhenHidden: boolean }  // used when capabilities.changes is false
export function evalsPaths(basePath: string): EvalsPaths;   // today's grammar, base-parameterised

// ── @platform/evals/react ────────────────────────────────────────────
// As built by C2 in codecast's components/evals/host.tsx; P4a moves the
// contract half (the interface, EvalsHostProvider, useEvalsHost, useCopy) here.
export interface EvalsShortcut { keys: string; label: string; run(): boolean | void }  // false declines
export interface EvalsHost {
  basePath: string;
  // A hook, not a function: codecast's router is bound to the pane a page renders in (tab context).
  // EvalsLink is a plain anchor whose unmodified click calls it, so there is no Link slot.
  useNavigate(): (href: string, opts?: { replace?: boolean }) => void;
  useSearchParams(): URLSearchParams;
  useHash(): string;                                   // codecast: useRepoLocation (the pane's own hash)
  useLandOn(target: string | null, getRoot: () => HTMLElement | null | undefined,
    find: (root: HTMLElement, target: string) => HTMLElement | null | undefined, margin: number): void;  // codecast: landOn
  useShortcuts(map: Record<string, EvalsShortcut>, enabled?: boolean): void;  // keyed by action id; codecast binds the registry id
  keyParts(action: string, keys: string): string[];    // the caps to draw for an action
  keysBusy(target: EventTarget | null): boolean;       // a field or a dialog owns the key
  ui: { KeyCap; HoverTip; Sheet: { Root; Content; Title; Description; Close }; SegmentedToggle; ExamplePair;
        EmptyState; DiffView; SessionPill };            // plain defaults in react/defaults.tsx
  format: { duration(startMs: number, endMs?: number): string; timeAgo(at: number, now?: number): string;
            relativeTime(at: number, now?: number): string; fullTimestamp(at: number): string };
  useNow(granularityMs: number): number;
  useVisible(): boolean;                               // the pane is on screen (polling)
  useActive(): boolean;                                // the pane owns the keys
  useContainerWidth(initial?: number): { ref: RefObject<HTMLDivElement>; width: number };
  copy(text: string, label?: string): Promise<void>;
  // What the area shows while its data is out of reach (codecast: no daemon, no checkout, a crashed child);
  // `state` is stamped on the shell as data-evals-connection. A host without discovery returns { state: 'connected', screen: null }.
  useConnection(): { state: string; screen: ReactNode | null };
  parseUnifiedDiff?(patch: string): unknown;           // codecast: lib/unifiedDiffParser
  // The session that wrote a commit, read from the raw trailer value git hands over (CommitRef.session).
  // Without it a commit names no session and its message shows whole. codecast: @codecast/shared/blame.
  commitSession?: { id(trailer: string): string | null; strip(message: string): string };
  // A host's own tabs under a run, after Verdict and Moment (codecast: calls, agent, guard, files; union: sim panels).
  // A hook, so a panel keeps its state (codecast's open file and its GET /run/:id/file) while the reader moves
  // between tabs. A tab's id is its address (`#guard`); a hash naming no tab the run has opens Verdict.
  useRunPanels?(run: RunResponse<any>, ctx: RunPanelContext): RunPanel[];
}
export interface RunPanel { id: string; label: string; count?: number; flag?: string | null /* the dot's title */; body: ReactNode }
export interface RunPanelContext { previousEpoch: { id: string | null; why: string } }  // the run the prompt files diff against
// usd is not a host slot: format.ts writes dollars itself (formatUsd's rule, pinned by the foundation test),
// so the models that print money stay pure. The commit trailer parse is a slot (commitSession), not a
// contract export: its URL scheme and its full-id rule are codecast's, and union's commits carry no trailer.
export function EvalsProvider(p: { transport: EvalsTransport; cache?: EvalsResourceCache; host?: Partial<EvalsHost>;
  poll?: PollPolicy; children: ReactNode }): JSX.Element;
export function EvalsApp(p: { path: string }): JSX.Element;  // routes the evalsPaths grammar to the moved pages
```

No module in `./client` or `./react` may hold a singleton. Context and cache are created per provider, because bun keeps one copy of the package per peer set.

## 4. Theming

- The views and CSS read only `--ev-*` names:
  - Text and surfaces: `--ev-text`, `-text-dim`, `-text-muted`, `-text-secondary`, `-bg`, `-bg-alt`, `-bg-inset`, `-bg-highlight`, `-card`, `-border`.
  - Accents: `--ev-magenta`, `-cyan`, `-violet`, `-red`, `-yellow`, `-blue`, `-orange`, `-green`.
  - Fonts and derived values: `--ev-font-ui`, `--ev-font-mono`, and the existing `--ev-rule`, `--ev-grid`, `--ev-hatch`.
  - Colour meanings are unchanged: pass is cyan, fail is magenta, gate is red.
- `tokens.css` declares each token once, inside zero-specificity `:where(:root, .ev-area)`, as `--ev-text: var(--sol-text, <codecast light hex>)`, `--ev-font-ui: var(--font-ui, <codecast stack>)`, and so on.
  - These are new names that resolve against whatever `--sol-*` the element inherits. Codecast's `:root`, `.dark` and minimal blocks (`globals.css:348/403/425/494`) therefore flow through unchanged.
  - Hosts without `--sol-*` get codecast's light look from the fallbacks.
  - `:root` is in the selector because a tooltip (HoverTip) or a sheet is portaled to the body, outside the area, and must still resolve `--ev-*`. A custom property resolves where it is declared, so `.ev-area` keeps its own declaration for a host that themes a subtree.
  - `:where(:root[data-ev-theme=dark], .ev-area[data-ev-theme=dark])` carries the dark fallbacks. Codecast never sets that attribute; union and eaiden may.
- Fonts are the host's job. The package names the families and ships no font files.
- **No Tailwind in shared views.** Every utility class becomes an `ev-*` rule. `src/react/guards.test.ts` fails on any className token that does not start with `ev-`, and on React-19-only APIs (`use(`, `useActionState`, `useOptimistic`, `useFormStatus`, `ref` as a plain prop) so the `>=18` peer stays true.
- **One stylesheet import per host.** Components import no CSS. Each host imports `@platform/evals/react/styles.css` and `tokens.css` once at its mount root.
- **Drift test.** It lives in codecast, which owns `globals.css`: `packages/web/components/evals/tokens.drift.test.ts` reads the vendored `tokens.css` fallbacks and the `globals.css` `:root` and `.dark` values and fails when they differ.
- Sim CSS (`sim.css`) keeps reading `--sol-*` directly and stays in codecast.
- Union gets a written exception in `outreach/CLAUDE.md`: routes that mount the shared eval views use the codecast look, not `.paper-theme`, by founder decision. All other admin pages stay Paper.

## 5. Per-app integration

### Codecast

- **packages/evals**
  - `commands/verdict.ts` exports `codecastVerdict = makeVerdict({ passed: repPassed, ruler: defaultRuler })` and `export const { batchVerdict, ... } = codecastVerdict`, plus its CLI parts. In `adapters/replay.ts`, `repPassed` becomes `statusPassRule(PASS_AT)` and `passesAt` becomes `passMarkRule(PASS_AT)`. The seams in `history/` and `bisect/` pass `codecastVerdict` to the core functions that need the policy.
  - `api/handlers.ts` becomes: codecast extras first (file, patch, search, POST bisect, sim), then `createEvalsHandler(codecastSources, codecastPolicy)`.
  - `api/sources.ts` wraps `indexedRuns`/`refreshRunIndex`, the resolver/labels freezes, `folderPromptReader`, `repoGit` + `codecastAttributionMeta`, and `listBisects`.
- **packages/web**
  - `app/evals/page.tsx` mounts `<EvalsProvider transport={store transport} cache={evalsStoreCache} host={codecastEvalsHost}>`. It renders `<EvalsApp>` for neutral paths and codecast `pages/Sim*` for `/evals/sim/*`, and imports `styles.css` and `tokens.css`.
  - `components/evals/host.tsx` builds `codecastEvalsHost` (C2; `app/evals/page.tsx` provides it, and `useEvalsHost()` falls back to it outside a provider, so a view mounted alone in a test still renders):
    - `useNavigate` over the compat router (`next/navigation` shim, pane-bound), `useSearchParams`, `useHash` and `useLandOn` via useRepoLocation/landOn
    - KeyCap, HoverTip and useContainerWidth (ActivityHeatmap), Sheet (`ui/sheet`), SegmentedToggle, ExamplePair (ChangeCardView), EmptyState, DiffView, SessionPill (EntityIdPill)
    - `useShortcuts` binding the registry ids (`shortcuts/registry.ts`, `evalsRun.*`, `list.open`, ...) through the keys kit, with each id's context switched on while enabled; `keyParts` and `keysBusy` from the registry
    - formatters from `conversationFormat`/`messageNavigator`
    - useCoarseNow, useTabVisible and useTabActive
    - sonner copy (`useCopy` lives beside the contract in host.tsx; `useCopy.ts` is gone)
    - `useConnection`: the evalsStore connection and the LocalDaemonUnreachable screens, with the slow-daemon retry countdown
    - unifiedDiffParser
    - `commitSession` over `@codecast/shared/blame` (C7)
    - `useRunPanels` (`runPanels.tsx`, C4) returning the Calls, Agent, Guard and Files tabs (`anatomyTabs` decides which a rep has) over CallPane, AgentTranscript, GuardLog and RunFiles, with their counts and the guard's live-read flag; it holds the open file and reads `GET /run/:id/file`, so RunPage carries no codecast route
  - `lib/evals/hooks.ts` gains `useEvalsHealth` (health, connected, transport kind), `useEvalsLoaded` (the cached answers the search reads) and `useEvalsClient` (`call`, `load`, `invalidate`), so the shell and pages stop reading `useEvalsStore` directly; P3/P4a give them a provider-backed implementation with the same signatures.
- **Privacy.** `evalsStore` stays the cache, memory-only, and its guard test stays. `evalsBatchRef` stays the only address that reaches `tabSafePath`. No new path writes to Convex, IndexedDB or a published page.

### Union (`union-mobile/outreach`)

- **Backend**
  - `/api/simulations` goes into `ADMIN_PREFIXES`.
  - New admin-gated `GET /api/evals/rows?since&layer&agent&run&limit` returns flat per-result rows in union's own shape (`eval_scenario_results` joined to `eval_runs`). It avoids N+1 fetches for trends. The backend takes no `@platform` dependency.
    - As built (U1, `lib/eval/suite/queries.ts` `listEvalResultRows`): the answer is `{ rows, since, truncated }`. `since` defaults to 60 days back; `layer` is `1|2|all` with default `1`, as on `/runs`; `limit` defaults to 5000 with a cap of 20000; `truncated` says older rows were cut. Rows are ordered newest run first, then in the order they landed.
    - Each row carries `id, runId, layer, runStartedAt, runStatus, selection, gitSha, gitBranch, scenarioId, scenarioName, agent, archetype, tier, themes, status, verdict, passed, judgeScore, productionJudgeScore, productionPassed, costUsd, latencyMs, tokensIn, tokensOut, errorHead, judgeReasoningHead, createdAt`. `verdict` (`pass|fail|infra|skip`) and `status` are the run page's own reads (`summaryVerdict`, `scenarioStatus`), so the adapter maps status from `verdict` and never re-derives it from `passed`/`error`.
- **Landing**
  - Mirror at `landing/vendor/platform/packages/evals`, with dep `"@platform/evals": "file:./vendor/platform/packages/evals"` and `transpilePackages: ['@platform/evals']`.
  - `tsconfig.json` and eslint exclude `vendor/`. `package-lock.json` is regenerated with npm 10.
  - `src/components/admin/evals-shared/`:
    - `mapRows.ts`: eval result to `RunRowCore`. Surface = agent; freezeId = scenario_id; batch = eval_runs.id; batchAt = started_at; status from the row's `verdict`; score = judge_score; gitHead = git_sha; model, judgeModel and promptSha null until the columns exist.
    - `mapSim.ts`: simulation to row and `RunResponse`. `weighted` becomes checks; gates and `decidedBy` map 1:1; `lastEventAt` comes from the newest event; passMark is null pending the founder decision.
    - `unionSources.ts`: `rows`, `surfaces` (with `gate` from `eval_suite_runs`/case-rates), `run`, and no git, prompts or bisects. Capabilities are therefore trends, liveness and run.
    - `policy.ts`: `passed = r => r.status === 'pass'`, `ruler = () => null`.
    - `host.tsx`: Next router, Link and URL-state search params, plus `useRunPanels` reusing `components/admin/sim/{FunnelFlow,CaplightPanel,TeamRosterCards,EmailThreads,StoryFeed}`, one tab each.
    - `UnionEvalsMount.tsx`: `EvalsProvider` with `localTransport(createEvalsHandler(unionSources, policy))` and `memoryResourceCache()`.
  - Route `src/app/admin/evals/v2/[[...path]]/page.tsx` (`'use client'`).

### Eaiden (`tools/xrun`)

- No code change is required for the done bar. The run is: `bun install` (new dirs are invisible to the Sep 6 per-file symlink copy until then), typecheck, tests, smoke.
- Optional E2: `xrun runs ui` is a `Bun.serve` on 127.0.0.1 with `createEvalsHandler(fsSources)` over `fsRunSource({root: .sim/runs})` and `fsFreezeStore`, plus a `Bun.build` page mounting `EvalsApp` with `httpTransport`. React 18 is an xrun dep.

## 6. Vendoring and dependency steps

**Platform**
- Every unit commits in `~/src/platform`, and checks run from that repo.
- New package.json entries:
  - exports for `./contract`, `./analysis`, `./query`, `./client`, `./react`, `./react/styles.css`, `./react/tokens.css`
  - `peerDependencies` `react >=18`, `react-dom >=18`, `lucide-react >=0.500`, all optional via `peerDependenciesMeta` (the `@platform/flags` pattern)
  - devDeps `react`, `react-dom`, `@types/react`, `@types/react-dom`, `happy-dom`, `lucide-react`
- Every vendor run copies from a platform commit sha, never the live tree: `git -C ~/src/platform worktree add /tmp/pf-<sha> <sha>`, run with `PLATFORM_DIR=/tmp/pf-<sha>` (added by V1), then remove the worktree. This lets platform units and vendor units run in parallel safely.

**Codecast**
- Add `"@platform/evals": "file:../../platform/packages/evals"` to `packages/shared/package.json`, `packages/cli/package.json` and `packages/web/package.json`. `packages/evals` already has it.
- Run `scripts/vendor-platform.sh` and commit `platform/packages/**`, `platform/vendor-manifest.txt` and `bun.lock` together. The vendor commit lands before any commit that imports a new subpath.
- CI `test-platform` then installs inside the mirror and runs its React tests with no CI edit.
- A running dev server needs `depsCacheGuard`, because vendoring purges `.vite`.

**Union**
- V1 makes the vendor script generic: the canonical copy lives in `~/src/platform/scripts/vendor-platform.sh`, and each mirror carries a copy beside its manifest (`landing/vendor/platform/vendor-platform.sh`) so `--check-manifest` works on a runner.
- Union adds `outreach/scripts/vendor-platform.sh` as a thin wrapper, modeled on codecast's: `--mirror landing/vendor/platform --consumers 'landing/package.json'`, no `--copies` (npm installs `file:` deps as symlinks), then `npm i --package-lock-only`. It also adds a CI step running `--check-manifest`.
- The rsync excludes `node_modules`, because a mirror with its own react devDep install would load a second React in Next.
- Run `npm i --package-lock-only` with npm 10 after each package.json change.

**Eaiden**
- No vendoring. Run `cd ~/src/eaiden/tools/xrun && bun install` after each platform wave that adds directories.

## 7. Work units

The rules for every unit:
- Files are disjoint within a wave.
- Each unit names its repo.
- Codecast checks use `cast check` (all programs unless noted) and per-file `bun test`.
- Platform checks are `cd ~/src/platform && bun run typecheck && cd packages/evals && bun test`.

### Wave 0 (parallel)

- **U0 (union): gate `/api/simulations`.**
  - Files: `outreach/backend/src/lib/routePermissions.ts` and its existing test `outreach/backend/tests/unit/routePermissions.test.ts` (the `ADMIN_PREFIXES` snapshot, a stub route, and the admin-only matrix rows).
  - Accept: the test asserts that `/api/simulations/db` is admin-only; backend `bun run test`; `scripts/ci/typecheck.sh backend` (the root `type-check` script covers landing only) and union `type-check`.
- **C0 (codecast): parity harness.**
  - Files: new `packages/evals/scripts/parity.ts`; `packages/evals/tsconfig.json` includes `scripts/**/*` so `cast check evals` covers it.
  - `parity.ts dump <label>` dumps `./evals runs --json`, `./evals runs matrix --json`, check's verdicts, and every neutral route answered by a real `./evals api --stdio` child for ids sampled from the index (a seeded hash rank), to `/tmp/evals-parity/<label>/`. `--compare a b` diffs them and ignores `/health.capabilities`.
  - Check's verdicts are not `./evals check --dry --json`: `check` has no `--json`, and `--dry` replays every freeze and writes dry reps into EVALS_HOME, which moves the index it reads. The harness calls `setVerdict` (what `check` and `publish` print through) on each surface's newest three batches, plus the newest against the oldest of them (`--against`).
  - Inputs are pinned, because other sessions keep adding runs: `parity.ts pin` builds `/tmp/evals-parity/home` (run folders linked, index, state and bisects copied) and a copy of the sim home, and records a clock. Every child runs with the script preloaded, which pins `Date` to that clock. Each unit pins once, dumps before its change and after it, and compares. A dump records an index fingerprint, and compare warns when the inputs moved.
  - Accept: two runs on an unchanged tree compare identical; `cast check evals`.
- **P0 (platform): scaffold.**
  - Files: `packages/evals/package.json`; `src/{contract,analysis,query,client,react}/index.ts` (empty barrels); `src/layers.test.ts`; `src/react/guards.test.ts`; `src/guardKit.ts` (test-only parsing shared by both guards); root `bun.lock`.
  - `layers.test.ts` follows imports transitively, so a pure layer cannot borrow node through a shared module such as `model.ts`, and it rejects free references to DOM and node globals. `guards.test.ts` also enforces section 4's token rules (views and CSS read only `--ev-*`, nothing declares `--sol-*`, components import no CSS) and requires `'use client'` at the top of `react/index.ts`. `@types/react-dom` is pinned `~19.2.0` to match platform's locked `@types/react` 19.2.
  - Accept: platform typecheck and tests; xrun `bun install` + `bun run test` still green.

### Wave 1 (parallel)

- **C1 (codecast/packages/evals): pure analysis core.**
  - Files: new `src/core/{verdict,flips,epochs,attribution,bisect}.ts` and `src/core/core.guard.test.ts`; edits to `src/commands/verdict.ts`, `src/history/{flips,epochs,attribution}.ts`, `src/bisect/{reading,plan,probe}.ts`, and two lines of `src/adapters/replay.ts` (`repPassed` and `passesAt` are defined from core's pass rule, so the rule has one implementation).
  - `core/` may import only `../stats`, `../evalResult`, `@codecast/shared/contracts/evalsApi`, `@codecast/shared/random`, `@platform/evals` (types), `@platform/cli-kit/format` and itself. `core.guard.test.ts` walks those imports transitively and rejects host globals.
  - Policy is injected through `makeVerdict`; a core function outside `verdict.ts` that needs it takes the kit as its first argument. The epochs sha256 moves into `folderPromptReader` as the reader's optional `hash`. `AttributionMeta` replaces the direct reads.
  - `core/attribution.ts` carries a one-line `plural`, because cli-kit's lived in `@platform/cli-kit/text`, which imports `fs`. P1 moved `plural` into `cli-kit/format` (`text` re-exports it) and platform's `analysis/attribution.ts` imports it from there; codecast's copy goes when C8 deletes `core/`.
  - Accept:
    - parity compare identical
    - `bun test` on `stats.test.ts`, `history/analysis.test.ts`, `bisect/bisect.test.ts`, `commands/check.test.ts`, `commands/line.test.ts`, `api/api.test.ts`
    - `cast check evals cli`
- **C2 (codecast/packages/web): host seam, tokens, shell.**
  - Files: new `components/evals/host.tsx` and `tokens.css`; edits to `app/evals/page.tsx`, `components/evals/pages/*`, `EvalsShell.tsx`, `EvalsNav.tsx`, `parts.tsx`, `format.ts`, `evals.css`, `lib/evals/{client,hooks}.ts` (widen `kind` to string); delete `useCopy.ts`; edit `__tests__/EvalsFoundation.mount.test.tsx`.
  - Shell files switch to host slots, `ev-*` classes and `--ev-*` tokens. As built: the shell, nav, parts, format and pages import nothing of the app's (only react, lucide, the contract, `lib/evals/hooks` and the area's own files), use no utility class, and the mount root (`app/evals/page.tsx`) imports `tokens.css` and `evals.css` once. The foundation test holds those rules for the shell files (the `evb-*` bisect prefix is allowed until C7) and that `evals.css` reads only `--ev-*` tokens `tokens.css` declares. `.evb-stall-chip` is now `.ev-stall-chip`. The other groups' CSS (`run.css`, `surface.css`, `wall.css`, `bisect.css`) still reads `--sol-*` until C4 to C7.
  - Accept: mount tests; `cast check web`; screenshots before and after of Home and the three error states (`sessionStorage.EVALS_FIXTURE` = `1`, `no-daemon`, `no-checkout`, `child-crashed`) in light, dark and minimal on localhost:3200.
- **V1 (platform + codecast): generic vendor script.**
  - Files: new `~/src/platform/scripts/vendor-platform.sh`; codecast `scripts/vendor-platform.sh` becomes a wrapper that keeps its `bun install` and `.vite` steps.
  - The shared script takes `--mirror <dir>` (holding `packages/`, `vendor-manifest.txt` and the script copy), `--consumers <glob>` (repeatable), `--root <dir>` (what messages print paths relative to; default the git toplevel) and `--copies <glob>` (package manager copies of the mirrored packages, refreshed in place after a vendor run: codecast passes bun's `node_modules/.bun/@platform+*`), plus env `PLATFORM_DIR` (default `~/src/platform`; `PLATFORM_SRC` still overrides the packages directory). A dep line must point at the mirror relative to its own package.json, with or without a leading `./`.
  - A vendor run copies the script to `<mirror>/vendor-platform.sh` (codecast: `platform/vendor-platform.sh`), which must be committed with the wrapper: a runner has no canonical repo, so the wrapper runs that copy for every mode (a tree with no copy yet starts from the canonical script). For vendor and `--check` the shared script itself hands over to the canonical script of the repo it resolved from `PLATFORM_DIR` or `PLATFORM_SRC`, so the wrapper never works out which repo that is; a `PLATFORM_DIR` at a commit from before V1 has no script and the copy serves it. `--check` also reports a copy that differs from the canonical script. `scripts/ci/vendor-manifest.test.ts` builds its fixture from both files.
  - Accept: in codecast, `--check`, `--check-manifest`, `--list` and `--list-with-tests` print identical output before and after; a real vendor run leaves `git diff platform/` unchanged.

### Wave 2 (parallel)

- **C3 (codecast/packages/evals): query split.**
  - Files: new `src/core/query.ts` and `src/api/sources.ts`; edits to `src/api/views.ts` and `src/api/handlers.ts`.
  - Accept: parity identical; `api/api.test.ts`; `cast check evals`; daemon `/evals/health` responds.
- **C4 (codecast/web): Run group.**
  - Files: `RunView.tsx`, `GateList.tsx`, `JudgeChecks.tsx`, `CostTrack.tsx`, `run.css`, `runModel.ts`, new `components/evals/runPanels.tsx` (composes RunFiles, CallPane, AgentTranscript, GuardLog), `__tests__/RunView.mount.test.tsx`.
  - As built: the host slot is the `useRunPanels` hook (section 3), wired in `host.tsx`. RunView draws Verdict and Moment and then the host's panels; `runModel.ts` keeps only the run page's own tabs (`RUN_TABS`) and `tabOfHash(hash)`, and its anatomy helpers moved beside their views. `Caret`, `CopyButton` and `TextPane` moved from CallPane into `parts.tsx`, with a host-drawn `KeyHint({ action, keys })` that replaces `changes/useChangesKeys` KeyHint for every group. `run.css` reads only `--ev-*`; its anatomy rules moved to new `runPanels.css`; `app/evals/page.tsx` imports both. `pages/RunPage.tsx` lost its open-file state. The foundation test holds the run group to the shell's rules and adds one for every group: no shared view imports the anatomy files.
  - Accept: mount test; screenshot of a Run page with calls and an agent run, three themes.
- **C5 (codecast/web): Surface group.**
  - Files: `SurfaceView.tsx`, `SurfaceWallView.tsx`, `WhatMoved.tsx`, `charts/{ScoreStrip,Well,scale}`, `Seismograph.tsx`, `seismographModel.ts`, `surfaceModel.ts`, `wallModel.ts`, `verdictModel.ts`, `surface.css`, `wall.css`, the Surface and SurfaceWall mount tests.
  - Accept: mount tests; screenshots of the wall and one surface.
- **C6 (codecast/web): Freeze and Compare group.**
  - Files: `FreezeView.tsx`, `FreezeLedger.tsx`, `freezeModel.ts`, `CompareView.tsx`, `ComparePanel.tsx`, `EpochDiffSheet.tsx`, the FreezeView mount test.
  - Accept: mount test; screenshots of the Freeze page, the Compare page and an open epoch diff sheet.
- **C7 (codecast/web): Attribution and Bisect group.**
  - Files: `AttributionView.tsx`, `CommitPanel.tsx`, `BisectRuler.tsx`, `BisectView.tsx`, `BisectListView.tsx`, `BisectPlanPanel.tsx`, `bisectModel.ts`, `bisect.css`, the Bisect mount test.
  - As built, the group also touched five shared files: `host.tsx` gained the `commitSession` slot (section 3), so `commitSessionId` left `bisectModel.ts` and the views read a commit's session through `useCommitSession` (CommitPanel); `app/evals/page.tsx` imports `bisect.css` once, beside `evals.css`; `pages/BisectNewPage.tsx` follows the class rename and binds Start through `START_KEY` (BisectPlanPanel), the one place the action and its key are named; `evals.css` gives `.ev-btn--go` the solid finish `.sol-btn-solid` added (only the shadow, hover and press: `.ev-btn`'s own background and transition already won), so `sol-btn-solid` can leave every view; the foundation test holds the group's sources to the shell's rules and checks `bisect.css`'s tokens. `evb-*` is now `ev-b-*` (classes and the ruler's `--ev-b-*` geometry); `data-evb-*` attributes are unchanged.
  - Accept: mount test; screenshots of the Code/commit page and the bisect list, new and detail pages.
- **P1 (platform): contract and analysis.**
  - Files: `src/contract/*` and `src/analysis/*` plus tests. Content is copied from C1's `core/` and the codecast contract per section 2; tests are moved byte for byte.
  - Accept: platform checks; `layers.test.ts` green.
  - As built (in the platform working tree):
    - `contract/{evalResult,core,bisect,views,routes,index}.ts`; `analysis/{rng,stats,evalResult,verdict,flips,epochs,attribution,bisect,liveness,index}.ts`; `cli-kit/src/{format,text}.ts` for `plural`.
    - `evalResult.ts` and its test are copied from codecast's working tree, which carries another session's uncommitted `clipSentences` change; C8 repoints to this copy, so that change must land in codecast first or travel with C8.
    - Tests: `stats.test.ts` and `evalResult.test.ts` byte for byte. `analysis.test.ts` (from `history/analysis.test.ts`) and `bisect.test.ts` (the plan, Tier 1 and probe-reading cases of `bisect/bisect.test.ts`) keep their case bodies; a prelude binds the names they call to codecast's policy (`statusPassRule(0.7)`, the rep's ruler) and to a row that is the core plus codecast's fields. The `contract.test.ts` cases come from `shared/contracts/evalsApi.test.ts`. Codecast's CLI text stays tested in codecast and was not moved: `verdictLinesOf`'s printed lines (platform asserts each case's regression flag), `startRefusal`'s words (platform asserts `planSearchable`, the rule it reads), the runner, its state and `searchRows`. New: `verdict.test.ts` (`unfooted`), `liveness.test.ts`.
    - Codecast keeps its own tests of these modules (through its seams) until C8 deletes `core/`; C8 then keeps the CLI-text and runner cases in codecast.
    - Proof beyond the checks: a scratch type test rebuilt every codecast contract type and every neutral route from the platform types and found them mutually assignable (two planted mismatches fail). On the real 8,347-row index, C1's functions and the platform copies agree on 1,080 verdict, flip, epoch and footing comparisons and on attribution for all 14 surfaces.
- **U1 (union backend): flat rows endpoint.**
  - Files: `outreach/backend/src/routes/evals.ts`, `outreach/backend/src/lib/eval/suite/queries.ts` (paths rechecked 2026-10-05), `tests/unit/evalResultRows.test.ts` (the admin gate and validation, no DB read) and `tests/integration/evalResultRows.test.ts` (the query against a loopback DB).
  - Accept: backend tests; the route is admin-gated; a local curl returns rows.

C1 must merge before P1 copies from it. If needed, P1 starts once C1 lands.

### Wave 3 (parallel)

- **P3 (platform): query and client.**
  - Files: `src/query/*` and `src/client/*` plus tests. Content comes from C3's `core/query.ts`, web `lib/evals/client.ts`, the models, `evalsPaths` (+test), `runModel.test`, `wallModel.test`, and union's `api.ts` polling ideas (visibility pause, seq cursor, id dedupe).
  - Accept: platform checks; a cache test proves there is no persistence path.
- **C8 (codecast): adopt contract and analysis.** Three commits:
  1. Dep lines, then vendor at P1's sha.
  2. Type-only re-exports in `packages/shared/contracts/evalsApi.ts`, `evalsApi/{core,bisect,routes,endpoints}.ts` and `contracts/evalResult.ts`.
  3. The runtime switch: `matchEvalsRoute` and the runtime helpers come from platform; `packages/evals/src/{stats,evalResult}.ts` and `core/{verdict,flips,epochs,attribution,bisect}.ts` are deleted and their importers repointed; `cli/src/lineProfileCommand.ts` and `cardCommand.ts` are repointed; `packages/shared/random/index.ts` is deleted and `__fixtures__/world.ts` and `world/{model,multiplayer}.ts` are repointed.
  - Files: the ones named above, plus `packages/{shared,cli,web}/package.json`, `bun.lock`, `platform/packages/**` and `platform/vendor-manifest.txt`.
  - Accept:
    - `cast check` on all programs after each commit
    - parity identical
    - from a fresh shell: `cast --version`, `cast task ls`, `cast line profile --help`
    - restart the daemon, then GET `/evals/health`
    - `gh workflow run cut-cli-release.yml -R codecast-sh/codecast -f dry_run=true` green
    - `scripts/vendor-platform.sh --check-manifest`
- **U2 (union landing): mirror and build plumbing.**
  - Files: `outreach/scripts/vendor-platform.sh`, `landing/vendor/platform/**`, `landing/package.json`, `landing/package-lock.json`, `landing/next.config.ts`, `landing/tsconfig.json`, `landing/eslint.config.mjs`, the union CI workflow step, and `outreach/CLAUDE.md` (theme exception).
  - Accept:
    - `bun run type-check`, `bun run lint` and `bun test src`
    - a local Railway-equivalent build: a clean copy made the way `outreach/deploy.sh` makes it, then `npm ci && npm run build` in landing
    - `find landing/vendor -name node_modules` is empty

### Wave 4 (parallel)

- **P4a (platform): React foundation.**
  - Files: `src/react/{index.ts,EvalsProvider.tsx,hooks.ts,defaults.tsx,EvalsApp.tsx,styles.css,tokens.css}`, `src/react/shell/*` (EvalsShell, EvalsNav, parts, Well, liveness StallChip); empty group barrels and CSS in `src/react/{run,surface,freeze,bisect}/`.
  - Accept: platform checks; happy-dom mount tests of the shell over `localTransport` with a fixture handler.
- **C9 (codecast): adopt query and client.**
  - Vendor at P3's sha. Then: `api/handlers.ts` and `api/sources.ts` use `createEvalsHandler`, and `core/query.ts` is deleted; `lib/evals/client.ts` keeps only `loopbackTransport`; `lib/evals/hooks.ts` and `fixtureTransport.ts` are repointed; `store/evalsStore.ts` implements `EvalsResourceCache`; the models and `evalsPaths` are deleted and repointed (`lib/tabSafePath.ts`).
  - Files: those named above plus the mirror, manifest and lockfile.
  - Accept: parity identical apart from `capabilities`; mount tests; `store/__tests__/evalsStore.guard.test.ts`; `cast check`; screenshot spot check of Home and Run.
- **U3 (union landing): adapter, no UI.**
  - Vendor at P3's sha.
  - Files: `src/components/admin/evals-shared/{mapRows,mapSim,unionSources,policy}.ts` and `mapRows.test.ts`.
  - Accept: the mapping tests read recorded `/api/evals/rows`, `/api/simulations/db/:id` and `/score` JSON fixtures; the tests assert `batchVerdict` returns `unfooted` and that capabilities exclude epochs, attribution and bisect; type-check.

### Wave 5 (parallel, platform)

- **P4b Run, P4c Surface, P4d Freeze/Compare, P4e Bisect/Attribution.**
  - Each copies its codecast group (as converted in C4 to C7) into `src/react/<group>/`, with its pages and CSS.
  - Union's ideas land here as optional parts:
    - P4b: rubric preview in GateList/JudgeChecks before a score exists, run `problems[]` in the run header, and a `Timeline` (StoryFeed generalised, with `calibrateOffsetMs`).
    - P4c: the gate chip from `SurfaceInfo.gate`.
  - Accept: platform checks, including `guards.test.ts` and a happy-dom mount test per group.

### Wave 6 (parallel)

- **C10 (codecast/web): switch to platform views.**
  - One vendor commit (at the P4 sha), then one commit per group that imports from `@platform/evals/react`, deletes the local copies, and adds `components/evals/tokens.drift.test.ts`.
  - The sim views (`SimCatalogView`, `SimRunView`, `DeliveryTimeline`, `OrderStrip`) switch to the platform primitives.
  - Accept per commit:
    - the screenshot set for that group in three themes against the wave 2 baseline
    - the 7 mount tests (including `Sim.mount.test.tsx`)
    - `cast check web`
    - after the last commit: the full screenshot set, plus a manual real-data pass kept in `/tmp`
- **U4 (union landing): mount.**
  - Vendor at the P4 sha.
  - Files: `src/components/admin/evals-shared/{host.tsx,UnionEvalsMount.tsx}` and `src/app/admin/evals/v2/[[...path]]/page.tsx`.
  - Accept:
    - type-check, lint, tests
    - local Railway-equivalent build
    - cast browser screenshots of the v2 home, an eval surface, a sim surface, an eval run, a sim run with union panels, a compare, and a running sim showing the stalled chip
    - no "Invalid hook call" or duplicate-React warnings in the console
- **E1 (eaiden):** `cd tools/xrun && bun install && bun run typecheck && bun run test && bun src/index.ts runs --help && bun src/index.ts runs matrix --help`. Accept: all green. No files change except `bun.lock` if the install rewrites it.

### Wave 7

- **U5 (union landing): cutover.**
  - Replace `app/admin/evals/page.tsx`, `[runId]/**`, `simulations/page.tsx` and `simulations/[id]/page.tsx` with the shared mount (v2 becomes the canonical path, and old URLs redirect).
  - Delete the `components/evals/*` files and the `components/admin/sim/*` files that `runPanels` no longer uses.
  - Accept: the U4 screenshot set at the canonical paths; type-check, lint, tests; deploy through union's normal path.
- **C11 (codecast/web), recommended:** make the fixture world go through `localTransport(createEvalsHandler(fixtureSources))`, so dev fixtures run the production verdict code. Files: `lib/evals/fixtureTransport.ts` and `components/evals/__fixtures__/**`. Accept: mount tests; review the fixture screenshot diffs (expected where hand-built responses diverged).
- **E2 (eaiden), optional:** `xrun runs ui` as in section 5. Accept: a screenshot of the page served on 127.0.0.1 under React 18.

## 8. Risks

1. **Cast boot path.** `daemon.ts:322` → `evalsServer.ts:12` and `orgRoleOps.ts:8` → `lineProfileCommand.ts:12` load the contract and evalResult on every cast start. A runtime import before the vendor commit and dep lines breaks every cast command. C8 handles this with ordered commits, a boot smoke test and a release dry run.
2. **Silent verdict change.** Mitigations: the policy is codecast's own `repPassed`, moved verbatim; status stays without `running`; `unfooted` only fires when every graded rep lacks model and judge. Parity diffs gate every analysis move.
3. **Pixel drift from the Tailwind and token conversion.** About 1,206 classNames change. Only screenshots catch this. The className guard catches leftover utilities, which would render in neither host.
4. **Theme override.** Never declare `--sol-*` on `.ev-area`. Only `--ev-*` gets declared, in `:where()`. The drift test pins the fallbacks.
5. **Duplicate React or package copies.** Union: the mirror lives inside `landing/` and is rsynced without `node_modules`. Codecast: Vite dedupes react. Bun's per-peer-set copies are harmless because nothing holds a singleton.
6. **Union build blind spots.** `ignoreBuildErrors: true` means type-check and lint must run. The npm lockfile must be regenerated with npm 10. Union line references are stale at `5e4e4ea97b` and must be rechecked.
7. **Eaiden.** Its symlink install misses new directories until `bun install` runs. React 18 is guarded by `guards.test.ts`, and E2 is the only real React 18 render.
8. **Platform CI cost.** Codecast's `test-platform` job now installs react, react-dom and happy-dom for this package. Moved tests switch from JSDOM to happy-dom, and bun's shared `mock.module` can make a test pass alone and fail in the combined run.
9. **Privacy.**
   - Real-data screenshots and parity JSON stay in `/tmp` and are never uploaded.
   - The cache API cannot persist.
   - `evalsBatchRef` remains the only address that reaches the tab list.
   - The eaiden server binds 127.0.0.1.
   - The union adapter reads admin-gated REST only.
10. **Partial vendoring.** Vendoring from the live platform tree while another unit edits it would ship half a change. Every vendor run uses `PLATFORM_DIR` pointed at a commit worktree.

## 9. Founder decisions

The look itself is already decided: union admin uses codecast's look, and U2 records it in union's CLAUDE.md. Two decisions remain:

1. **Union provenance columns.** These are nullable prod Postgres columns:
   - `eval_runs`: `model`, `judge_model`, `dirty`
   - `eval_scenario_results`: `prompt_sha`, backfilled from the stored `system_prompt`
   - `simulations`: `git_sha`, `judge_model`

   Without them, union batch verdicts stay `unfooted` and union has no epoch strip. Default: add them after U5, as a separate union unit.
2. **Pass mark for union sims.** Sims have no pass mark today.

   Default: none. Sims show scores, separation and trends but no pass/fail majority. Set one if sims should get pass/fail verdicts.