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
2. **Union admin renders its runs through the shared views** at `/admin/evals` (mounted at `/admin/evals/v2` until U5 cut over). This covers eval runs and simulations as surfaces, with a run list, run detail, compare, and trends (score strip, seismograph, batch verdicts and flips) where the data allows. Panels whose data union lacks are hidden by capabilities, never shown empty.
3. **Eaiden `xrun` still works.** After `bun install`, `bun run typecheck`, `bun run test` and a `xrun runs --help` smoke all pass in `tools/xrun`.
4. **One verdict implementation.** `batchVerdict`, `separate`, flips and footing live only in `@platform/evals/analysis`. Codecast's CLI, the codecast api child, union's browser adapter and eaiden all call that code. Union's gate rule stays union's single implementation and is displayed, not recomputed. So does union's per-run CLI diff (`xrun evals diff`, `diffEvalRuns`): it asks a stricter question than a flip (a scenario is red on a side when any of its rated draws failed there, so 2 of 3 reads red), has no footing, and lives in the backend, which takes no `@platform` dependency. Its words say red and green, never "flipped" or "regressed", so it cannot be read as the views' flips (review fix, 2026-10-06).

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
| `packages/shared/random/index.ts` (makeRng, imported as `@codecast/shared/random`) | `analysis/rng.ts` | File deleted; its 5 importers repointed (`evals/src/stats.ts`, web `__fixtures__/world.ts` and `world/multiplayer.ts`, shared `contracts/__fixtures__/inboxProjectionGen.ts` and `changes/__fixtures__/littlebird.ts`) |
| `packages/evals/src/stats.ts` + `stats.test.ts` | `analysis/stats.ts` + test | Deleted; importers repointed |
| `packages/evals/src/evalResult.ts` + test | `analysis/evalResult.ts` + test | Deleted; `cli/src/lineProfileCommand.ts:12` and `cli/src/cardCommand.ts:25` repointed |
| `packages/shared/contracts/evalResult.ts` | `contract/evalResult.ts` | Becomes a re-export |
| `contracts/evalsApi/core.ts`, neutral part (primitives, `RunRowCore`, field validator, `evalsBatchRef`/`resolveEvalsBatchRef`, the RE constants, `SeparationResult`, `Footing`, `BatchStats`, `BatchVerdict`, `VerdictFlip`, `SkippedBatch`, `Epoch`, `FootingMarker`, `PromptFilePair`, `CommitRef`, `FlipsResult`, `RunDiffEntry`, `spendByDayOf`, `unaskedSet`, `flipCounts`) | `contract/core.ts` | `core.ts` keeps `GuardCounts`/`GUARD_STATUSES`, `StalenessWord`, `CodecastRunFields` (`sourceHash`, `guard`, `scoreVersions`), `RunRow = RunRowCore & CodecastRunFields`, and `runRowProblems` over the combined field map in today's field order (`guard` as a `{ name: 'guard', ok }` field spec, so its messages stay as they are) |
| `contracts/evalsApi/bisect.ts` (whole) | `contract/bisect.ts` | Becomes a re-export |
| `contracts/evalsApi/endpoints.ts`, neutral responses (Health, Overview, Surface, Freeze, Run core, Compare, Batches, Epoch, Attribution query, Commit, Changes, BisectList, Bisect), generic over `R extends RunRowCore` | `contract/views.ts` | Codecast keeps RunJson, CallDetail, AgentDetail, GuardEntry, RunFile, Patch, Search and Sim*. It adds its fields by interface extension: `RunResponse extends Core.RunResponse<RunRow> { run, calls, agents, guard, files, extra }`, `SurfaceInfo extends Core.SurfaceInfo { route: EvalRoute; model: string; criteria, freezes, sources, reps, maxUsdPerRep }`, `SurfaceOverview extends Core.SurfaceOverview { route, model, staleness: StalenessWord }`, `OverviewResponse extends Core.OverviewResponse<SimFailureMoved> { surfaces, sim }` and `ChangesResponse extends Core.ChangesResponse<RunRow> { jobs }`. Not an intersection: `Core.OverviewResponse & { surfaces: SurfaceOverview[] }` types `surfaces` as `Core.SurfaceOverview[] & SurfaceOverview[]`, whose `.map` takes the first array's signature, and codecast's own fixture (`__fixtures__/home.ts`) stopped typechecking. Extension is checked the same way: an override must be assignable to the neutral answer |
| `contracts/evalsApi/routes.ts`: `matchEvalsRoute` logic and the bridge types | `contract/routes.ts` as `matchRoute(keys, method, path)`, `Route<P, Q, Res, B>`, `None`, `EvalsViewRoutes<R, M>`, `EVALS_VIEW_ROUTE_KEYS`, `EvalsBridgeRequest`/`Response` and `EvalsErrorBody` | Codecast `interface EvalsRoutes extends EvalsViewRoutes<RunRow, SimFailureMoved>`, which re-keys overview, surface, run and changes with codecast's wider answers (extension, for the reason in the row above; checked type for type against today's table) and add `/run/:id/file`, `/patch/:sha`, `/search`, POST bisect routes and `/sim/*`. `EVALS_ROUTE_KEYS` and `matchEvalsRoute` keep their names and their order (`matchEvalsRoute = (m, p) => matchRoute(EVALS_ROUTE_KEYS, m, p)`). Its bridge types add `id`, the `GET`/`POST` method and a required `query` by extension, and its error body narrows `reason` to `EvalsUnavailableReason` and its three words |
| `packages/evals/src/core/verdict.ts` (created by C1 from `commands/verdict.ts`) | `analysis/verdict.ts` | `commands/verdict.ts` keeps `positiveNumber`, `verdictLinesOf`, `setVerdict`, and the policy-bound instance |
| `core/flips.ts` (`flipsBetween`) | `analysis/flips.ts` | `history/flips.ts` keeps `flipExamples` |
| `core/epochs.ts` (walk, `timeline`, `promptPairs`, `sortPromptFiles`, `footingMarkers`; texts are hashed by the reader's `hash`) | `analysis/epochs.ts` | `history/epochs.ts` keeps `folderPromptReader` (sha256 moves into it as `hash`), re-exports `sortPromptFiles`, and binds the reader and ruler defaults |
| `core/attribution.ts` (`attribute`, `freezeFileChange`, `largestDrops`) | `analysis/attribution.ts` | `history/attribution.ts` keeps `repoGit`, `declaredPaths`, `ATTRIBUTION_EXTRA_PATHS` and `codecastAttributionMeta` |
| `core/bisect.ts` (pure parts of `reading.ts`; `plan.ts`'s `planFrom`/`renderPlan` over `PlanDeps`; and from `probe.ts`: `ProbeEnv`, treeLabel, treeOf, candidateKey, renderBatch, renderKeys, renderClasses, mapToClass, probeSet, missingReps) | `analysis/bisect.ts` | `bisect/{runner,state,simProbe}.ts`, `probe.ts` `treeEnv`/`folderParams` and the `gitHead()` defaults, `plan.ts` `PlanWorld`, `planDeps` (cost/state reads, tool head) and `buildPlan` |
| `history/analysis.test.ts`, pure cases of `bisect/bisect.test.ts` | `analysis/*.test.ts` | |
| `core/query.ts` (created by C3 from `api/views.ts`: ledgerOf, compareView, epochView, onRows, overview strip, batches, plus route dispatch for the neutral routes) | `query/handler.ts`, `query/views.ts` | `api/handlers.ts` answers codecast's own routes and hands the rest to the neutral handler. `api/sources.ts` holds the index load, `/health` and the `EvalsSources` object. `api/views.ts` keeps codecast's own reads (freeze page, run folder, run pair, freeze counts, the staleness worker, the sim overview). `files.ts`, `git.ts`, `simHistory.ts`, `spawn.ts`, `staleWorker.ts` and `bisects.ts` stay |
| `web/lib/evals/client.ts`, minus `loopbackTransport` | `client/transport.ts` | `loopbackTransport` stays (vault discovery) |
| neutral part of `web/store/evalsStore.ts` (cache shape; `call`, `load`, `invalidate`; `evalsCacheKey`) | `client/cache.ts` (`EvalsResourceCache`, `memoryResourceCache`) and `client/resources.ts` (`createEvalsClient`) | evalsStore keeps discovery, unavailable reasons and zustand, and exports `evalsResourceCache` (its `resources` slice as an `EvalsResourceCache`) and `onEvalsFailure` (`classifyEvalsFailure` moving the connection). Since C10 the store has no client of its own: the area's provider makes the one client over that cache |
| `web/lib/evals/hooks.ts` (`useEvalsResource`, `useEvalsChanges`) | `react/hooks.ts` | `useEvalsConnection` stays |
| `components/evals/evalsPaths.ts` + test | `client/paths.ts` (`evalsPaths(basePath)`) | `components/evals/evalsPaths.ts` shrinks to codecast's binding, `codecastEvalsPaths = evalsPaths('/evals')` and `evalsHref`, which the host's `basePath`, `lib/tabSafePath.ts`, `lib/pathLabel.ts`, the Line page, the page and the views read |
| `verdictModel`, `surfaceModel`, `seismographModel`, `freezeModel`, `runModel`(+test), `wallModel`(+test), neutral `bisectModel`, `charts/scale.ts`, `format.ts` | `client/models/*` (same file names; `charts/scale.ts` is `models/scale.ts`) | `isJobStalled` (sim jobs) and the sim-failure line of `movedLine` stay with the sim views |
| Views: `charts/Well`, `charts/ScoreStrip`, `charts/BrushRect`, `charts/useDayBrush`, `parts.tsx`, `EvalsNav`, `EvalsShell`, `GateList`, `JudgeChecks`, `CostTrack`, `RunView`, `SurfaceView`, `SurfaceWallView`, `WhatMoved`, `Seismograph`, `FreezeView`, `FreezeLedger`, `CompareView`, `ComparePanel`, `EpochDiffSheet`, `AttributionView`, `CommitPanel`, `BisectRuler`, `BisectView`, `BisectListView`, `BisectPlanPanel`, pages `Home/Surface/Run/Freeze/Compare/Code/Bisect*` | `react/{shell,run,surface,freeze,bisect}/*` and `react/EvalsApp.tsx` | |
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
  models: boolean;    // the rows name the model that answered and the judge that graded (U4)
  compare: boolean;   // two reps can be weighed side by side: the product hands over `pair` (U4)
  marks: boolean;     // the product records the pass mark its reps are held to; off, no view draws a mark (U4)
  promptFiles: boolean; // the product keeps the prompt files a rep sent; off, an epoch is known by its hash alone and no view offers a prompt diff (U6)
}
export interface SurfaceInfo {
  id: string; title: string; model: string | null; route: string | null;
  passMark?: number | null;   // the surface's own mark, when it names one (SurfaceOverview carries the same); codecast names none, and its wire shape stays as it is
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
// The neutral RunResponse<R> is { row, result, score, scoreVersions, rubric, without?, sends, judge, logTail, siblings, adjacent }
// (`without`, U4: what this kind of rep never has, `reply`, left out of its page rather than drawn empty):
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
// As built by P3 from C3's core/query.ts: query/{request,sources,views,handler}.ts, typed against RunRowCore.
// Every source a product may lack is optional; leaving one out turns its capability off and its routes answer
// 404 not-found (/epoch finds no epoch). rows() takes no filter: the same array until the rows change, which keys
// the handler's answer memo (one memo per handler, so two policies never share an answer).
export interface QuerySurface { id: string; title: string; route: string | null; model: string | null; passMark?: number | null; gate?: SurfaceInfo['gate'] }
export type RunDetail<R> = Omit<RunResponse<R>, 'row' | 'siblings' | 'adjacent'>;
export interface EvalsSources<R extends RunRowCore = RunRowCore, S extends QuerySurface = QuerySurface, M extends { at: string } = never> {
  rows(): Promise<R[]>;
  surfaces(): readonly S[] | Promise<readonly S[]>;
  health?(): Omit<HealthResponse, 'capabilities'>;   // left out, /health counts the rows
  info?(surface: S): object;                         // the surface header's own fields (codecast: criteria, sources, reps, maxUsdPerRep)
  prompts?: PromptReader;                            // epochs, footing diffs, prompt diffs
  freezes?: { counts(): Promise<(surface: string) => { public: number; private: number }>;
              get(id: string, rows: R[]): Promise<Omit<FreezeResponse<R>, 'epochs'> | null> };   // the query adds epochs
  staleness?(): Promise<(surface: string) => string | null>;   // asked before the rows load
  run?(row: R): Promise<RunDetail<R>>;               // left out, a run page is the row, its siblings and adjacent
  pair?(a: string, b: string): Pick<CompareResponse<R>, 'diff' | 'replies'>;   // left out, `compare` is off and GET /compare answers 404
  models?: boolean;                                  // false: the rows name no model or judge, so `models` is off (U4)
  marks?: boolean;                                   // false: the product records no pass mark, so `marks` is off and none is drawn (U4)
  promptFiles?: boolean;                             // false: `prompts` knows each rep's prompt by its promptSha and keeps no files; epochs draw, prompt diffs do not (U6)
  flipExamples?(surface: string, freezeIds: string[], a: string, b: string): Promise<EvalFlip[]>;
  git?: { verify(sha): void; touching(surface, from, to): CommitRef[]; between(surface, a, b): CommitRef[];
          commit(sha, surface, whole): CommitResponse; readonly attribution: AttributionGit; meta: AttributionMeta };
  bisects?: { summaries(): BisectSummary[]; settle?(): void; running(): string | null; get(id: string, since: number): BisectResponse | null };
  changes?: { sig?(row: R): string; extra?(since: number): object };   // the /changes feed; the cursor lives in the handler
  overview?(): { moved?: M[]; fields?: object };     // a product's own "What moved" lines and wall fields
}
export interface HandlerPolicy<R extends VerdictRun = VerdictRun> extends VerdictPolicy<R> { stallAfterMs?: number }
/** trends always; freezes, epochs (prompts), attribution (git and prompts), commits (git), bisect, changes from the sources; liveness from stallAfterMs. */
export function capabilitiesOf(sources: EvalsSources<any, any, any>, policy?: Pick<HandlerPolicy, 'stallAfterMs'>): EvalsCapabilities;
/** /health adds capabilities. A request carrying a line protocol id (codecast's bridge) gets it back (EvalsReply). */
export function createEvalsHandler<R, S, M>(sources: EvalsSources<R, S, M>, policy: HandlerPolicy): EvalsHandler;
export type EvalsHandler = <Req extends EvalsBridgeRequest>(req: Req) => Promise<EvalsReply<Req>>;
// query/request.ts: NotFound, BadRequest, need, flag, posInt, posNum, rowById, endpointRef, ranFreezes, answer, noRoute,
// and RouteHandler<T, K> over any route table T, so codecast's own routes in api/handlers.ts reuse them. isViewRoute
// and rowsMemo come with the handler. The policy is typed on VerdictRun, not R: the kit's functions are
// contravariant in the rep, and attribute() takes VerdictKit<VerdictRun>.
// C9 maps codecast's sources onto this shape: freezes { counts: freezeCounts, get: freezePage }; staleness returns
// (id) => words.get(id) ?? 'fresh'; changes { sig: (r) => String(r.scoreVersions), extra: (since) => ({ jobs }) },
// because the core row signature has no score versions; overview () => ({ moved: sim failure, fields: { sim } });
// info (meta) => ({ criteria, sources, reps, maxUsdPerRep }). The freeze id check (hex with dashes) stays in the
// handler, after the freezes check, so codecast's 400 is unchanged.

// ── @platform/evals/client ───────────────────────────────────────────
// As built by P3: client/{transport,cache,resources,polling,liveness,paths}.ts and client/models/*.
export interface EvalsTransport { readonly kind: string; send(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse> }
export function localTransport(handler, kind = 'local'): EvalsTransport;   // answers with a structuredClone, as the wire would
export function httpTransport(baseUrl: string, init?: { headers?: Record<string, string>; credentials?: 'omit' | 'same-origin' | 'include' }): EvalsTransport;
// evalsCalls<T>() types request, cacheKey and call by any route table (codecast: evalsCalls<EvalsRoutes>());
// evalsRequest, evalsCacheKey and callEvals are the neutral table's. evalsUrlPath(req, basePath), evalsFetchInit and
// evalsResponseOf are what httpTransport and codecast's loopbackTransport share.
export interface EvalsResourceCache {           // memory-only by contract: no persistence method exists
  get(key: string): CachedResource | undefined;
  set(key: string, value: CachedResource): void;
  subscribe(key: string, fn: () => void): () => void;
  clear(pred?: (key: string) => boolean): void;
}
export function memoryResourceCache(): EvalsResourceCache;
/** call, load (a cached answer or a load in flight is kept unless forced; a failure keeps the last answer), invalidate: evalsStore's logic, which C9 delegates to. */
export function createEvalsClient<T = EvalsViewRoutes>(o: { transport: () => EvalsTransport | null; cache: EvalsResourceCache; onFailure?(e: unknown): void }): EvalsClient<T>;
export interface PollPolicy { intervalMs: number; pauseWhenHidden: boolean }  // EVALS_POLL = 3 s, paused while hidden
export interface Visibility { visible(): boolean; subscribe(fn: () => void): () => void }   // the React layer reads the document and the pane
export function poll(tick, policy, visibility?): () => void;           // now, every interval while visible, at once on return
export function followChanges(fetchChanges, onChanges, policy?, visibility?): () => void;   // its own cursor; hands over answers with news
// Union's ideas: mergeById (merge by id, never by seq; the same array when nothing changed) and nextSeqCursor (a full
// page steps back one). liveness.ts: EVALS_STALL_MS, quietTooLong, rowLiveness (only an unscored rep can be live).
export function evalsPaths(basePath: string): EvalsPaths;   // today's grammar, base-parameterised:
// { basePath, href, hrefFor, parse, isPath, canonicalPath, senseHref, tabLabel, searchTargets }; evalsSection and freezeRef stand alone.
// Models: a function that builds a link takes the area's hrefs first (flipFreezeHref, rowHref, attributeHref,
// movedLine; movedLine draws a product's own kinds through a callback, codecast's sim failure, and hands back the
// callback's own line, so a host's extra fields such as codecast's mark keep their type). freezeModel reads
// a product's calls and agents through the optional RunAnatomy. bisectModel's canStart takes a StartGate rather
// than the panel's props; isJobStalled (sim jobs) stays in codecast over the client's quietTooLong.

// ── @platform/evals/react ────────────────────────────────────────────
// As built by C2 in codecast's components/evals/host.tsx; P4a moved the
// contract half here (react/host.ts; useEvalsHost and useCopy in react/hooks.ts).
// P4a's additions over C2's interface: the ui slots are typed by the props the
// views pass (so codecast's wider components fit), and three optional slots
// replace the codecast-only routes the shell read directly:
//   navSections?: { key; label; href }[]   the host's nav sections after Surfaces and Bisects (codecast: the Multiplayer sim)
//   useSearchIndex?(q): { freezes; runs? } | null   what GET /search found (codecast's route stays codecast's)
//   useRunFile?(runId | null, path): { text; loading }   GET /run/:id/file, read by PromptDiff's run-id form
// P4e adds two more for codecast-only routes the bisect group reads and writes:
//   usePatch?(sha): { data: PatchView | null; loading; error }   GET /patch/:sha
//   useBisectActions?(): { plan(req); start(req); stop(id) }     POST /bisect/plan, POST /bisect, POST /bisect/:id/stop
// parseUnifiedDiff takes (patch, files) and returns DiffSection[] ({ filePath, hunks, oldContent, newContent }).
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
        EmptyState; DiffView; SessionPill };            // plain defaults in react/defaults.tsx; ExamplePair takes { ex, stack?: boolean }
  format: { duration(startMs: number, endMs?: number): string; timeAgo(at: number, now?: number): string;
            relativeTime(at: number, now?: number): string; fullTimestamp(at: number): string };
  useNow(granularityMs: number): number;
  useVisible(): boolean;                               // the pane is on screen (polling)
  useActive(): boolean;                                // the pane owns the keys
  useContainerWidth(initial?: number): { ref: RefObject<HTMLDivElement>; width: number };
  copy(text: string, label?: string): Promise<void>;
  // What the area shows while its data is out of reach (codecast: no daemon, no checkout, a crashed child);
  // `state` is stamped on the shell as data-evals-connection. The default reads the provider's GET /health:
  // 'connecting' with a wait line, 'unreachable' with the error and a retry, then 'connected' and no screen.
  useConnection(): { state: string; screen: ReactNode | null };
  parseUnifiedDiff?(patch: string): unknown;           // codecast: lib/unifiedDiffParser
  // The session that wrote a commit, read from the raw trailer value git hands over (CommitRef.session).
  // Without it a commit names no session and its message shows whole. codecast: @codecast/shared/blame.
  commitSession?: { id(trailer: string): string | null; strip(message: string): string };
  // A host's own tabs under a run, after Verdict and Moment (codecast: calls, agent, guard, files; union: sim panels).
  // A hook, so a panel keeps its state (codecast's open file and its GET /run/:id/file) while the reader moves
  // between tabs. A tab's id is its address (`#guard`); a hash naming no tab the run has opens Verdict.
  cadences?: readonly CadenceFilter[];   // the cadence filters beside "all" ({ key, label }); left out, codecast's nightly and by hand; empty draws no filter (U4)
  useRunPanels?(run: RunResponse<any>, ctx: RunPanelContext): RunPanel[];
  // A host's own parts of the surface wall (codecast: the Multiplayer sim, components/evals/wallSim.tsx; C5).
  // Without it the wall draws only what every product shares. `moved` draws a What moved event of the host's
  // own kind (OverviewResponse's M) and is the `own` that movedLine takes; movedKinds names those kinds in the
  // line that says nothing moved; Foot adds blocks after Open bisects from the host's own overview fields.
  wall?: { moved(e: MovedEvent | M): { href: string; text: string; mark: ReactNode }; movedKinds: string[];
           Foot?: ComponentType<{ overview: OverviewResponse<M>; now: number }> };
}
export interface RunPanel { id: string; label: string; count?: number; flag?: string | null /* the dot's title */; body: ReactNode }
export interface RunPanelContext { previousEpoch: { id: string | null; why: string } }  // the run the prompt files diff against
// usd is not a host slot: format.ts writes dollars itself (formatUsd's rule, pinned by the foundation test),
// so the models that print money stay pure. The commit trailer parse is a slot (commitSession), not a
// contract export: its URL scheme and its full-id rule are codecast's, and union's commits carry no trailer.
// As built by P4a: transport is null while a host still discovers it (codecast passes the store's transport only
// while connected, so a crash stops the loads); host merges ui and format part by part over the defaults;
// onFailure is handed to createEvalsClient (codecast: classifyEvalsFailure). The views load once the transport has
// answered /health. Hooks: useEvalsResource, useEvalsClient and useEvalsChanges are the neutral table's, and
// evalsHooks<T>() types the same implementation by a wider table (codecast: evalsHooks<EvalsRoutes>()).
export function EvalsProvider(p: { transport: EvalsTransport | null; cache?: EvalsResourceCache; host?: EvalsHostInput;
  poll?: PollPolicy; onFailure?(e: unknown): void; children: ReactNode }): JSX.Element;
// Routes the evalsPaths grammar: each group barrel exports its pages (runPages, surfacePages, freezePages,
// bisectPages), and `pages` adds the host's own (codecast: the sim pages). A view no page claims says so.
export function EvalsApp(p: { path: string; pages?: EvalsPages }): JSX.Element;
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
  - `:where([data-ev-theme=dark], [data-ev-theme=dark] .ev-area)` carries the dark fallbacks. The second selector is needed: `.ev-area` declares the light values on itself, which beat what it inherits from a dark root (found by P4a in the browser; the first form only themed a root with no area under it). Codecast never sets that attribute; union and eaiden may.
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
  - `api/sources.ts` wraps `indexedRuns`/`refreshRunIndex`, the resolver/labels freezes, `folderPromptReader`, `repoGit` + `codecastAttributionMeta`, and `listBisects`. Its slow reads (the freeze homes, the staleness words) are platform's `keptRead` with `staleWhileRevalidate`, the timed read every product's sources share (`@platform/evals/query`, beside `stableRows` for a source that reads its rows afresh).
- **packages/web**
  - `app/evals/page.tsx` mounts `<CodecastEvalsProvider>` (`host.tsx`: `EvalsProvider` with the store's transport while connected, `evalsResourceCache`, `codecastEvalsHost` and `onEvalsFailure`) around `<EvalsApp path pages={SIM_PAGES}>`. EvalsApp routes every view; codecast's lazy `pages/Sim*` are the `pages` it adds. The root imports `@platform/evals/react/tokens.css` and `styles.css`, then codecast's `host.css` and `runPanels.css`.
  - `components/evals/host.tsx` builds `codecastEvalsHost` (C2; since C10 the contract, `useEvalsHost` and `useCopy` are platform's, and outside a provider a view gets platform's plain defaults, so a codecast test mounts under `CodecastEvalsProvider`):
    - `useNavigate` over the compat router (`next/navigation` shim, pane-bound), `useSearchParams`, `useHash` and `useLandOn` via useRepoLocation/landOn
    - KeyCap, HoverTip and useContainerWidth (ActivityHeatmap), Sheet (`ui/sheet`), SegmentedToggle, ExamplePair (ChangeCardView), EmptyState, DiffView, SessionPill (EntityIdPill)
    - `useShortcuts` binding the registry ids (`shortcuts/registry.ts`, `evalsRun.*`, `list.open`, ...) through the keys kit, with each id's context switched on while enabled; `keyParts` and `keysBusy` from the registry
    - formatters from `conversationFormat`/`messageNavigator`
    - useCoarseNow, useTabVisible and useTabActive
    - sonner copy (`useCopy` is platform's, in `react/hooks.ts`)
    - `useConnection`: the evalsStore connection and the LocalDaemonUnreachable screens, with the slow-daemon retry countdown
    - unifiedDiffParser
    - `commitSession` over `@codecast/shared/blame` (C7)
    - `useRunPanels` (`runPanels.tsx`, C4) returning the Calls, Agent, Guard and Files tabs (`anatomyTabs` decides which a rep has) over CallPane, AgentTranscript, GuardLog and RunFiles, with their counts and the guard's live-read flag; it holds the open file and reads `GET /run/:id/file`, so RunPage carries no codecast route
    - `run` (P4b): `commands` returning the folder path, replay and rescore copies, and `VerdictFoot` drawing the "Analyzer grade" section from `extra`, so the run page reads as it does today
    - the routes only codecast serves (C10): `navSections` (the Multiplayer sim), `useSearchIndex` over `GET /search`, `useRunFile` over `GET /run/:id/file`, `usePatch` over `GET /patch/:sha`, and `useBisectActions` over the three POST routes
  - `lib/evals/hooks.ts` holds `useEvalsConnection` (daemon discovery and the slow-daemon retry) and codecast's typed copies of the provider-backed hooks, `evalsHooks<EvalsRoutes>()`'s `useEvalsResource`, `useEvalsClient` and `useEvalsChanges`, which the run anatomy, the sim pages and the host's slots read. The shell's `useEvalsHealth` and `useEvalsLoaded` are platform's.
- **Privacy.** `evalsStore` stays the cache, memory-only (the provider's client writes its answers there), and its guard test stays. `evalsBatchRef` stays the only address that reaches `tabSafePath`. No new path writes to Convex, IndexedDB or a published page.

### Union (`union-mobile/outreach`)

- **Backend**
  - `/api/simulations` goes into `ADMIN_PREFIXES`.
  - New admin-gated `GET /api/evals/rows?since&layer&agent&run&result&limit` returns flat per-result rows in union's own shape (`eval_scenario_results` joined to `eval_runs`). It avoids N+1 fetches for trends. The backend takes no `@platform` dependency.
    - As built (U1, `lib/eval/suite/queries.ts` `listEvalResultRows`): the answer is `{ rows, since, truncated }`. `since` defaults to 60 days back; `layer` is `1|2|all` with default `1`, as on `/runs`; `limit` defaults to 5000 with a cap of 20000; `truncated` says older rows were cut. Rows are ordered newest run first, then in the order they landed. Review fix: `result` narrows to the run holding that result, and a lookup of one run (`run` or `result`) reaches any age when no `since` is given, because old addresses name runs the trend window has left. `GET /api/simulations/db?id=` finds one sim at any age (it rides in `u6.patch`, beside U6's other edits to that route).
    - Each row carries `id, runId, layer, runStartedAt, runStatus, selection, gitSha, gitBranch, scenarioId, scenarioName, agent, archetype, tier, themes, status, verdict, passed, judgeScore, productionJudgeScore, productionPassed, costUsd, latencyMs, tokensIn, tokensOut, errorHead, judgeReasoningHead, createdAt`, and since U6 `model, judgeModel, dirty, promptSha`. `verdict` (`pass|fail|infra|skip`) and `status` are the run page's own reads (`summaryVerdict`, `scenarioStatus`), so the adapter maps status from `verdict` and never re-derives it from `passed`/`error`.
- **Landing**
  - Mirror at `landing/vendor/platform/packages/{evals,cli-kit}`, with deps `"@platform/evals": "file:./vendor/platform/packages/evals"` and `"@platform/cli-kit": "file:./vendor/platform/packages/cli-kit"` and `transpilePackages: ['@platform/evals', '@platform/cli-kit']`. Landing declares cli-kit itself because evals reaches it through `file:../cli-kit`, and `landing/.npmrc` sets `install-links=true` (section 6).
  - `tsconfig.json` and eslint exclude `vendor/`. `package-lock.json` is regenerated with npm 10.
  - `src/components/admin/evals-shared/`:
    - `mapRows.ts`: eval result to `RunRowCore`. Surface = agent; freezeId = scenario_id; batch = eval_runs.id; batchAt = started_at; seed = the draw's place among its scenario's results in that run; cadence = eval_runs.selection (null reads `full`, as the column's own comment says); status from the row's `verdict` (`infra` is a crash, `skip` a dry rep); score = judge_score; gitHead = git_sha; model, judgeModel and dirty from the result's run and promptSha from the result (U6; null on rows from before the columns, and on a backend that does not send them). A result's page (`evalRun`) carries its reply and the judge's words (`judge` with an empty prompt, since the call is not kept), no score sheet and `without: ['mark']`: union stores one composite score per result, and each scenario sets its own pass threshold (0 to 1 across the suite), which no route returns, so the page reads the verdict and score from the row and draws no pass mark.
    - `mapSim.ts`: simulation to row and `RunResponse`. The sim surface is `simulations`; freezeId = the scenario; batch = the sim itself (nothing groups sims); cadence = its kind, so a sim is weighed against its scenario's earlier sims. `weighted` becomes checks; gates and `decidedBy` map 1:1; `lastEventAt` is the newest event while the sim runs, and null after; passMark is null pending the founder decision, so a scored sim passes when every gate held. A sim's page says `without: ['reply']`: it is graded on what its world did.
    - `unionSources.ts`: `rows`, `surfaces` (each agent's `gate` is the case-rates verdict from `GET /api/evals/overview` on the gate cases it ran), `run`, `prompts: PROMPTS_BY_HASH` with `promptFiles: false` (U6: a reader with no files, so epochs come from each row's promptSha and no view offers a prompt diff), `marks: false`, and no git, bisects or `pair`. Capabilities are therefore trends, liveness, epochs and models; the run page needs no capability.
      - Reads (review fix): the rows are read once in full at the backend's cap (20,000 results over its 60-day window, and the newest 200 sims), then refreshed from where they can still change: six hours before the newest run, or the start of the oldest run still running, whichever is earlier. A poll never reads the whole history again, and a refresh that finds nothing hands back the same array (`stableRows`, compared over the refreshed part only). A cut read drops the run it cut through, and `historyFrom` names where the history starts, the later of the evals' and the sims' cuts; the nav shows it beside the run count. Nobody has measured production's volume (it needs a read of production), so whether 20,000 results reach the full window is open; the chip says so when they do not.
      - `runRows` looks up a run page the read did not reach: an eval result with the rest of its run (`/rows?result=`), a sim by `/db?id=`. Old addresses from Slack, the CLI and agent notes therefore open at any age.
      - A sim's run page carries its `problems`: the note events with an error, read page by page from `/db/:id/events?kinds=note` (`mapSim.simProblems`), as the deleted RunHeader showed them. A failed read of the notes shows the page without them.
    - `policy.ts`: `passed = r => r.status === 'pass'`, `ruler = r => r.judgeModel` (U6: union keeps no judge prompt or criterion version, so the judge's model is the ruler it can name).
    - `host.tsx`: Next router, Link and URL-state search params, plus `useRunPanels` reusing `components/admin/sim/{FunnelFlow,CaplightPanel,TeamRosterCards,EmailThreads}`, one tab each, and, since U5, `components/evals/ScenarioDetailBody` as an eval result's Reproduction tab. The fragment and in-page moves are the package's default hooks (`defaultEvalsHost.useHash`, `useNavigate`), with only route changes going through Next's router. The Story tab is the shared `Timeline` (review fix): `components/admin/sim/storyItems.tsx` builds its items, each message drawn in the sims' own bubbles and each team in its tone, and the run clock is platform's (`calibrateOffsetMs`, `onRunClock`, `runClockLabel`), so union's `virtualTime.ts` is a thin layer over it and `StoryFeed.tsx` is gone.
    - `addresses.ts` (U5): the base path, the suite page's address, and where each address from before the cutover lands.
    - `UnionEvalsMount.tsx`: `EvalsProvider` with `localTransport(createEvalsHandler(unionSources, policy))` and `memoryResourceCache()`.
  - Route `src/app/admin/evals/[[...path]]/page.tsx` (U4 mounted it at `v2/[[...path]]`; U5 moved it), beside union's own `src/app/admin/evals/suite/page.tsx`.

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
- Union adds `outreach/scripts/vendor-platform.sh` as a thin wrapper, modeled on codecast's: `--mirror landing/vendor/platform --consumers 'landing/package.json'`, then `npm i --package-lock-only --workspaces=false` in landing. It refuses an npm other than 10. It also adds a CI step running `--check-manifest` (the `vendored-platform` job in `.github/workflows/ci.yml`).
- Landing is a member of outreach's bun workspace, so a plain `npm i --package-lock-only` there writes `outreach/package-lock.json` instead; `--workspaces=false` keeps the lock in landing, the directory Railway builds.
- **One React.** The rsync excluding `node_modules` is not enough on its own. npm links a `file:` dep by default and then installs that package's devDependencies too, nested under `vendor/platform/packages/evals/node_modules` wherever a version differs from landing's: with evals' `react 19.1.0` devDep, Next would load a second React (reproduced with the live evals package.json). `landing/.npmrc` therefore sets `install-links=true`: npm installs each `@platform` package as a copy in `node_modules/@platform`, like a registry package, with no devDependencies, and react resolves to landing's. install-links resolves a copied package's own `file:../cli-kit` from `node_modules/@platform`, so landing must declare every package the mirror holds. No `--copies`: Railway installs fresh every build.
- Local dev is different: landing installs through outreach's bun workspace (hoisted linker), which also copies a `file:` folder dep and does install its devDependencies, nesting a conflicting version inside the copy (`landing/node_modules/@platform/evals/node_modules/react`). That nested copy is harmless: Next's app router compiles every `react` and `react-dom` import, a `node_modules` package's included, to its own vendored React (`next/dist/compiled/react*`), so it never enters a bundle (U4 checked this in `next dev` with evals' `react 19.1.0` planted there).
- Run the wrapper (or `npm i --package-lock-only --workspaces=false` in landing, npm 10) after each package.json change. `outreach/bun.lock` is refreshed by the next `bun install` at `outreach/`.

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
  - After C8: the five `core/` modules live in `@platform/evals/analysis` and codecast's seams import them from there, so `core/` holds `core.guard.test.ts` and C3's `query.ts`. `stats.test.ts` runs from platform (`packages/evals/src/analysis/stats.test.ts`, or the same file in codecast's mirror). `bisect/bisect.test.ts` drives a real runner per case and needs `--timeout` raised on a loaded machine.
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
  - As built: landed in `171830bb4` with C1 and C8's runtime switch. Verified again after C8 by dumping a scratch worktree at `5175e9d30` (the commit before) and the main tree against one pin. The CLI dumps are byte-identical. The 337 shared answers match once the inputs that commit also moved are set aside: the checkout's `root` and `gitHead`, the new `expectations` surface, two new changes-story freezes and their moments, staleness, and judge notes clipped by P1's `clipSentences`.
  - Trap for any unit that dumps an older tree: every `./evals` run rewrites `EVALS_HOME/checkout.json`, and the daemon serves `/evals` from the checkout it names. Run nothing in a scratch worktree except under the pin's `CODECAST_EVALS_HOME` (parity's children already do), or run any `./evals` from the main checkout afterwards to point the daemon back.
- **C4 (codecast/web): Run group.**
  - Files: `RunView.tsx`, `GateList.tsx`, `JudgeChecks.tsx`, `CostTrack.tsx`, `run.css`, `runModel.ts`, new `components/evals/runPanels.tsx` (composes RunFiles, CallPane, AgentTranscript, GuardLog), `__tests__/RunView.mount.test.tsx`.
  - As built: the host slot is the `useRunPanels` hook (section 3), wired in `host.tsx`. RunView draws Verdict and Moment and then the host's panels; of the tab logic, `runModel.ts` keeps only the run page's own tabs (`RUN_TABS`) and `tabOfHash(hash)` (its gate, check, compare and epoch helpers stay), and its anatomy helpers moved beside their views (`guardCounts`/`GUARD_WORDS` into GuardLog, `fileTree`/`fileLanguage` into RunFiles). RunPage reads the tab from the host's `useHash`, which codecast backs with `useRepoLocation().hash`: on the standalone page that is the router location, so any hash change moves the tab (a click, a link, or a raw `location.hash` write); inside an app tab it is the tab's own stored path, which moves through the tab's router. This predates C4. `Caret`, `CopyButton` and `TextPane` moved from CallPane into `parts.tsx`, with a host-drawn `KeyHint({ action, keys })` that replaces `changes/useChangesKeys` KeyHint for every group. `run.css` reads only `--ev-*`; its anatomy rules moved to new `runPanels.css`; `app/evals/page.tsx` imports both. `pages/RunPage.tsx` lost its open-file state. The foundation test holds the run group to the shell's rules and adds one for every group: no shared view imports the anatomy files.
  - Accept: mount test; screenshot of a Run page with calls and an agent run, three themes.
- **C5 (codecast/web): Surface group.**
  - Files: `SurfaceView.tsx`, `SurfaceWallView.tsx`, `WhatMoved.tsx`, `charts/{ScoreStrip,Well,scale}`, `Seismograph.tsx`, `seismographModel.ts`, `surfaceModel.ts`, `wallModel.ts`, `verdictModel.ts`, `surface.css`, `wall.css`, the Surface and SurfaceWall mount tests.
  - As built: the group reaches the app only through `useEvalsHost()` (KeyCap, HoverTip, SegmentedToggle, EmptyState, useContainerWidth, format, useShortcuts, keysBusy), uses only `ev-*` classes, and its sheets read only `--ev-*`; `app/evals/page.tsx` imports `surface.css` and `wall.css`. The wall's key caps use the shared `KeyHint` in `parts.tsx` (the one RunView uses). The chart primitives the group borrowed from `components/ActivityCharts.tsx` moved into the area so the views can move to platform: `timeAxisLabels` and `MONTHS` into `charts/scale.ts`, the brush into `charts/useDayBrush.ts` and `charts/BrushRect.tsx` (`ev-brush`). ActivityCharts re-exports them, so the team charts page reuses the one copy. The foundation test's guard lists the group (`SURFACE_GROUP`) and both sheets, and lets a sheet read a variable it declares itself (the wall's `--ev-wall-cols`).
  - The Multiplayer sim stays in codecast (section 2), so the wall reaches it through the host's `wall` slot (section 3), as RunView reaches the run anatomy through `useRunPanels`. New `components/evals/wallSim.tsx` holds codecast's half: the foot's "Latest Multiplayer sim session" block (`SimFoot`, with `simOutcome`) and a sim failure's What moved line and mark (`simMoved`). `wallModel.movedLine(e, own?)` draws the host's kinds through `own`, as platform's P3 copy does (C9 adds the hrefs argument), and What moved names the host's `movedKinds` in its empty line. A host without the slot shows no sim and draws such an event as a plain line home. The foundation guard's `SIM` set fails any shared view that imports a sim file or `wallSim` (the `pages/Sim*` pages are codecast's and exempt). Found on re-verification: the first pass left the wall importing `simModel`, which the guard allowed because it sits in the area.
  - Accept: mount tests; screenshots of the wall and one surface.
- **C6 (codecast/web): Freeze and Compare group.**
  - Files: `FreezeView.tsx`, `FreezeLedger.tsx`, `freezeModel.ts`, `CompareView.tsx`, `ComparePanel.tsx`, `EpochDiffSheet.tsx`, the FreezeView mount test; new `freeze.css`.
  - As built: the group reads the app only through host slots (`HoverTip`, `SegmentedToggle`, `useContainerWidth`, `KeyCap`, `ExamplePair`, `Sheet`), names only `ev-*` classes and reads only `--ev-*` tokens; `CompareView` no longer imports `run.css` (the mount root imports `run.css` and `freeze.css`). The foundation test's rules now hold the group's sources and `freeze.css`, and the FreezeView mount test renders the freeze page, the drawer and the sheet under another host's plain slots.
  - Shared pieces it needed: `.ev-btn--go` carries the solid finish itself (no `.sol-btn-solid` beside it), and `evals.css` gains `ev-sr-only`, `ev-link` and `ev-icon`. Codecast's `ExamplePair` slot draws the `cc` size container the change card's pair sizes its columns by (it stacks below 640px); `cc-inline` is gone from the view, and the list's hairline and padding are `.ev-cmp-examples`. Compare's pair fills its list, so moving the container from the list onto the pair changes nothing there. A view that keeps its pair side by side passes `stack={false}` and gets the bare pair. AttributionView does this, because before C6 its pairs had no `cc` ancestor and never stacked (C7's parity finding; the slot's `stack` prop is C7's fix, checked in the fixture world: bisect-new pairs keep two columns, and the compare drawer's 286px pairs still stack). The plate's state classes are `ev-sf-plate-pinned`, `-hovered` and `ev-sf-plate-flips--some`, and a pair flip is styled from `data-ev-pair-flip`; those rules moved from `surface.css` to `freeze.css`.
  - Still in other groups' stylesheets: the plate, drawer and sheet frames (`.ev-sf-plate*`, `.ev-sf-compare*`, `.ev-sf-set*`, `.ev-sf-sheet*`, `.ev-sf-example*`) in `surface.css`, and the compare page's (`.ev-cmp-head`, `.ev-diffrow`) in `run.css`. P4d moves them into `react/freeze/` with the group.
  - Accept: mount test; screenshots of the Freeze page, the Compare page and an open epoch diff sheet. Fixture-mode freeze pages need the fixture world to resolve a freeze's 8-character prefix as the api does (`__fixtures__/world.ts` `freezeResponse`, fixed here).
- **C7 (codecast/web): Attribution and Bisect group.**
  - Files: `AttributionView.tsx`, `CommitPanel.tsx`, `BisectRuler.tsx`, `BisectView.tsx`, `BisectListView.tsx`, `BisectPlanPanel.tsx`, `bisectModel.ts`, `bisect.css`, the Bisect mount test.
  - As built, the group also touched five shared files: `host.tsx` gained the `commitSession` slot (section 3), so `commitSessionId` left `bisectModel.ts` and the views read a commit's session through `useCommitSession` (CommitPanel); `app/evals/page.tsx` imports `bisect.css` once, beside `evals.css`; `pages/BisectNewPage.tsx` follows the class rename and binds Start through `START_KEY` (BisectPlanPanel), the one place the action and its key are named; `evals.css` gives `.ev-btn--go` the solid finish `.sol-btn-solid` added (only the shadow, hover and press: `.ev-btn`'s own background and transition already won), so `sol-btn-solid` can leave every view; the foundation test holds the group's sources to the shell's rules and checks `bisect.css`'s tokens. `evb-*` is now `ev-b-*` (classes and the ruler's `--ev-b-*` geometry); `data-evb-*` attributes are unchanged.
  - The `ExamplePair` slot stacks a pair below 640px of its own width (codecast draws the `cc` size container around every pair, as its host did at HEAD). A bisect's "What flipped" pairs sit in 380px grid cells, so they stack there; the C10 fix pass removed a `stack={false}` option that had them overflow the cell.
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
    - Rechecked 2026-10-06: `contract/`, `analysis/` and cli-kit's `format.ts`/`text.ts` are still uncommitted in `~/src/platform` and byte-identical to codecast's mirror, so codecast runs exactly this code. `@platform/evals` typecheck and its 200 tests are green. The root `bun run typecheck` is red only in `@platform/auth` and `@platform/engine` test files, which import neither evals nor cli-kit. The neutral `RunRowCore` and the section 3 analysis surface (`passMarkRule`, `statusPassRule`, `makeVerdict`, `unfootedReps`, `liveness`, `epochRenderKeys`) are exported as described.
- **U1 (union backend): flat rows endpoint.**
  - Files: `outreach/backend/src/routes/evals.ts`, `outreach/backend/src/lib/eval/suite/queries.ts` (paths rechecked 2026-10-05), `tests/unit/evalResultRows.test.ts` (the admin gate and validation, no DB read) and `tests/integration/evalResultRows.test.ts` (the query against a loopback DB).
  - Accept: backend tests; the route is admin-gated; a local curl returns rows.

C1 must merge before P1 copies from it. If needed, P1 starts once C1 lands.

### Wave 3 (parallel)

- **P3 (platform): query and client.**
  - Files: `src/query/*` and `src/client/*` plus tests. Content comes from C3's `core/query.ts`, web `lib/evals/client.ts`, the models, `evalsPaths` (+test), `runModel.test`, `wallModel.test`, and union's `api.ts` polling ideas (visibility pause, seq cursor, id dedupe).
  - Accept: platform checks; a cache test proves there is no persistence path.
  - As built (in the platform working tree; section 3 gives the shapes):
    - `query/{request,sources,views,handler,index}.ts` and `query/query.test.ts`, which runs the handler over a rows-and-surfaces product (union's shape: unfooted verdicts, capabilities, every missing source a 404) and a full one (codecast's shape: its extras, the /changes cursor and signature, id echo, per-handler answers).
    - `client/{transport,cache,resources,polling,liveness,paths,index}.ts` and `client/models/{format,scale,verdictModel,surfaceModel,seismographModel,freezeModel,runModel,wallModel,bisectModel}.ts`, copied from codecast's working tree as C4 to C7 left it.
    - Tests: `paths.test.ts` keeps every codecast case body (bound to `evalsPaths('/evals')`) and adds a second base; `runModel.test.ts` and `wallModel.test.ts` moved with only the row type renamed; new `cache.test.ts` (the cache's whole surface is get, set, subscribe and clear; a fresh cache starts empty; a load, failure and invalidate through the client touch no storage, with every storage global trapped; no client source names one) and `client.test.ts` (requests, transports, the client's load rules, polling, liveness).
    - `runModel`'s `runCommands` moved with the file: `freeze replay` and the `runs/<id>` folder are platform's own CLI and fs layout. Its `rescore` line is codecast's; P4b made the command list a host slot (`run.commands`), whose default offers the folder and the replay.
    - Rechecked 2026-10-06 against codecast's tree: the only source that moved after the copy was C5's `wallModel.movedLine`, which now hands back the line the host's `own` made (`L extends MovedLine`), so codecast's `mark` reaches What moved typed. Platform's copy does the same, keeps the hrefs argument, and `wallModel.test.ts` covers the shared kinds under another base, a host kind keeping its `mark` through inference, and the plain line home. Codecast's `BisectPlanPanelProps` satisfies `StartGate` as it is.
    - Proof beyond the checks: a scratch replay (in `/tmp`, nothing committed) sent all 365 requests of a parity dump, over all 13 neutral routes on a fresh pin of the real index, through platform's `createEvalsHandler` over codecast's `api/sources.ts` mapped as C9 will map it (above, in section 3). Against codecast's real `./evals api --stdio` child, all 368 files compare identical. A control replay through codecast's own `core/query.ts` handler in the same harness is identical too.
    - Two things C9 must know. First, platform's `answer` matches `NotFound` and `BadRequest` by class, so every codecast source that throws one (`views.ts` `freezePage`, `sources.ts` `shaChecked`) must import it from `@platform/evals/query`, or a 404 or 400 comes back as a 500. Deleting `core/query.ts` forces that. Second, the parity pin freezes the evals home and the clock but not git: `commits` lists come from `git log --since … refs/heads/main` on the live checkout, and while other sessions commit to main one ask can return 21, 27 or 29 commits for the same arguments. Rerun the dump before reading a `commits`-only diff as a regression.
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
  - As built (the three steps were checked one by one in the working tree; another session's commit sweep then landed them as `5175e9d30` (mirror, dep lines, lockfile), `171830bb4` (contract, analysis switch) and `5cb376a95` (shared/random), on origin/main at `5122a28a4`):
    - P1 had no platform commit, so "vendor at P1's sha" vendored a frozen copy of the platform tree (`/tmp/pf-c8`, `query/` and `client/` still P0's empty barrels) through `PLATFORM_DIR`, and only `evals` and `cli-kit` (`scripts/vendor-platform.sh vendor evals cli-kit`), so other sessions' staged mirror changes stayed put. P1's `clipSentences` change to `evalResult.ts` travels with it.
    - The widened answers, the bridge types and `EvalsRoutes` use interface extension rather than an intersection (section 2 says why). `RunRow` stays `RunRowCore & CodecastRunFields`; `runRowProblems` is `rowProblems` over the combined map in today's order.
    - Two importers the list above missed: shared's `inboxProjectionGen.ts` and `littlebird.ts` (makeRng), and root `scripts/line.ts` (majorityOf), which sits outside any package and now reads it through `adapters/replay.ts` beside `repPassed`. Codecast's `ProbeEnv` extends platform's with `rows(): Promise<RunRow[]>`, so the runner keeps its own rows.
    - `core/` holds only C3's `query.ts` until C9; `core.guard.test.ts` allows `@platform/evals/{contract,analysis}`. `stats.test.ts` and `evalResult.test.ts` moved with their modules; `history/analysis.test.ts` and `bisect/bisect.test.ts` stay whole, because they also assert the CLI text (verdict lines, `startRefusal`) and the runner through codecast's seams.
    - The dispatch on `5122a28a4` was a real release, not a dry run, and it failed: C8 moved files in the daemon's import closure, so `daemonBuildId.ts` was stale. `42fa12d94` restamped it, and v1.1.171 shipped from `a0ee5d5c9`, which carries all of C8. The `dry_run=true` run on `bab1e582c` (37443271991) is green. Its first attempt failed in the agent browser branding e2e, which no change since `a0ee5d5c9` touches, and the rerun passed.
    - The sweep put one step 3 line into step 1: `5175e9d30` already drops shared's `"./random"` export, while `shared/random` and its importers stay until `5cb376a95` and `171830bb4`. At that commit the evals runtime cannot load (`Cannot find module '@codecast/shared/random'`), so a bisect or a parity baseline there needs the export line restored. Main is not affected.
    - Re-verified 2026-10-06 against a fresh pin. Two dumps of main are identical (368 files). Against `5175e9d30` with the export line restored, 332 files are identical, 16 differ and 20 are new. Every difference comes from inputs that moved since then, as C3 found, and the 52 check verdicts both trees share are identical.
- **U2 (union landing): mirror and build plumbing.**
  - Files: `outreach/scripts/vendor-platform.sh`, `landing/vendor/platform/**`, `landing/package.json`, `landing/package-lock.json`, `landing/next.config.ts`, `landing/tsconfig.json`, `landing/eslint.config.mjs`, the union CI workflow step, and `outreach/CLAUDE.md` (theme exception).
  - Accept:
    - `scripts/ci/typecheck.sh landing` (the bare `bun run type-check` runs tsc on node's default heap and aborts; CI's script gives it 6 GB), `bun run lint` in a tree installed by outreach's `bun install` (an `npm ci` copy resolves another `eslint-plugin-react-hooks` from landing's npm lock and reports errors CI never sees), and `bun test src` with no file from `vendor/` in it. Landing's suite in CI is `bun run test` (`test-isolated.sh`, one process per file); `bun test src` runs every file in one process, where landing's own Happy DOM tests already fail with or without U2
    - a local Railway-equivalent build: `deploy.sh` no longer makes a copy (it dispatches `deploy.yml`, and Railway builds `outreach/landing/**` by itself on a push to main), so the equivalent is `git archive origin/main outreach/landing` into an empty directory, the unit's files laid over it, then `npm ci && npm run build` in landing
    - `find landing/vendor -name node_modules` is empty, in the tree and in the build copy after `npm ci`
  - As built:
    - Vendored from a worktree of platform `08be468`, the newest platform commit (P0 and P1 are uncommitted in `~/src/platform`, and the shared script V1 made is too, so the first run started from the live canonical script, which serves a `PLATFORM_DIR` that has none). The mirror holds evals and cli-kit at that commit; U3 re-vendors at P3's sha.
    - Files beyond the list: `landing/.npmrc` (`install-links=true`, section 6) and `landing/src/app/globals.css` (`@source not "../../vendor"`: Tailwind v4 scans every directory git does not ignore, and without it 75 mirror files were class sources). The CI step is a `vendored-platform` job in `.github/workflows/ci.yml`. `outreach/CLAUDE.md` gains the theme exception and a "Vendored platform packages" section.
    - The build copy carried a scratch probe route (a server page using `@platform/evals/render` and cli-kit, and a `'use client'` child using cli-kit). It prerendered with both values, so `transpilePackages` and the install-links copies work on both sides. The probe never entered the repo.
    - `outreach/bun.lock` is untouched: union's main checkout carries other sessions' dirty `package.json` files, which a `bun install` there would bake into it. CI runs a plain `bun install`, so nothing fails; the next `bun install` at `outreach/` (U3 needs one to import the package locally) records the two deps.
    - Landed in union `6a8ddc0d0b` (another session's commit sweep), on origin/main. The `vendored-platform` CI job is green on every run since. Union's `test` job is red on those runs for an unrelated agent tripwire (`tipContext.render.is-production-composed`). The `globals.css` line is still uncommitted in union's main checkout, beside another session's font hunk in the same file.
    - Found on recheck (2026-10-06): `bun test src` takes `src` as a path substring, not a directory, so it also ran 10 of the mirror's test files, and 7 cases in evals' `evals.test.ts` failed: from `vendor/`, `commander` resolves to landing's 4.1.1 instead of evals' 12.1. The installed copy (`node_modules/@platform/evals`, which nests 12.1) passes all 19. New `landing/bunfig.toml` sets `[test] pathIgnorePatterns = ["vendor/**"]`, so `bun test src` runs the 141 files `bun test ./src` runs and nothing from the mirror; CLAUDE.md's vendored section says why.
    - Rechecked results on origin/main `46e5ff72df` plus the `globals.css` line and `bunfig.toml`: CI typecheck green; lint 0 errors and 332 warnings (cap 345), no `vendor/` file linted; `bun run test` 141 files, 1262 pass, 0 fail. The `git archive` build copy: `npm ci` added 759 packages, `npm run build` green, `find vendor -name node_modules` empty before and after, `@platform/*` installed as copies with only `commander` nested, and the probe route prerendered `$1.50` on the server and `1.1m` in the client child. The wrapper's `npm i --package-lock-only --workspaces=false` warns that it ignores `landing/.npmrc` inside the outreach workspace, but regenerating the `@platform` lock entries from scratch writes them byte for byte as committed (copies, no `link`).

### Wave 4 (parallel)

- **P4a (platform): React foundation.**
  - Files: `src/react/{index.ts,EvalsProvider.tsx,hooks.ts,defaults.tsx,EvalsApp.tsx,styles.css,tokens.css}`, `src/react/shell/*` (EvalsShell, EvalsNav, parts, Well, liveness StallChip); empty group barrels and CSS in `src/react/{run,surface,freeze,bisect}/`.
  - Accept: platform checks; happy-dom mount tests of the shell over `localTransport` with a fixture handler.
  - As built (in `~/src/platform`'s working tree, uncommitted like P1 and P3):
    - Files: `react/{index.ts,host.ts,context.ts,EvalsProvider.tsx,hooks.ts,defaults.tsx,EvalsApp.tsx,styles.css,tokens.css,react.mount.test.tsx}`, `react/shell/{EvalsShell,EvalsNav,parts,Well,StallChip}.tsx`, `shell/{index.ts,shell.css,defaults.css}`, and `react/{run,surface,freeze,bisect}/{index.ts,<group>.css}`. `host.ts` holds the contract (section 3) and `context.ts` the per-provider context value, so the provider, hooks and defaults import neither each other's state nor a singleton.
    - The provider owns a client over a tracked cache (the memory cache unless the host hands its own); the tracking is how `useEvalsLoaded` lists answers, since `EvalsResourceCache` has no enumeration. `useEvalsChanges` runs one `followChanges` for the view's life and gates it through a Visibility built from live, connected, the document and the host's pane, so the cursor survives a hidden pane as codecast's does. One difference from codecast's hook: a provider whose transport object changes restarts the cursor.
    - The shell is codecast's C2 shell over host slots. The nav's sections are Surfaces, Bisects unless `capabilities.bisect` is false, then `host.navSections`; the search drops the sha target and its words where `capabilities.commits` is false; the status line's tool head shows when known, or as "none" only where commits are read. With no capabilities on `/health` (codecast today) every one of these draws exactly as now. The fixture chip's tooltip is neutral wording. `StallChip` moved to `shell/StallChip.tsx` beside the new `LivenessChip` (a rep's `rowLiveness`: "running", then "stalled?").
    - `shell.css` is codecast's `evals.css` plus a zero-specificity reset under `:where(.ev-area, .ev-sheet-layer, .ev-tip)` that reproduces what Tailwind's preflight gave the views (no link underline, no heading or list margins, inherited button fonts, block svgs, solid zero borders); in codecast it changes nothing. Codecast's `[data-ev-flip] .cc-*` rules became the same rules on the default pair's `.ev-pair-*` classes: C10 must keep the `.cc-*` versions in a codecast stylesheet, since codecast's ExamplePair slot draws the change card's classes.
    - Defaults (`defaults.tsx`, `shell/defaults.css`): the browser's own location (pushState plus a popstate event, no module state), a keydown binding of `keys` that stands down for fields and open modals, KeyCap, a portaled tooltip and sheet (Escape and the scrim close it), a segmented toggle, the before and after pair (stacking under 640px of its own width), an empty state, a line diff with folded context, timers and formatters matching codecast's words, ResizeObserver width, clipboard copy, and the health-based connection screen.
    - Proof: `react.mount.test.tsx` (14 cases, happy-dom, `localTransport(createEvalsHandler(...))` over a rows-only product and a full one): connection states and retry, a host's own connection screen, capabilities hiding Bisects and the sha search, host nav sections and base path, index progress, live changes delivered only while on screen with the cursor kept, links, search and keys through the host, no cache shared between providers, host merge, every default slot. Evals typecheck and 217 tests green (layers and guards included); root typecheck red only in the known auth and engine test files. A static Bun rig (in `/tmp`, fixture data) rendered the default host in Chrome light and dark, which is where the reset and the dark selector were found.
- **C9 (codecast): adopt query and client.**
  - Vendor at P3's sha. Then: `api/handlers.ts` and `api/sources.ts` use `createEvalsHandler`, and `core/query.ts` is deleted; `lib/evals/client.ts` keeps only `loopbackTransport`; `lib/evals/hooks.ts` and `fixtureTransport.ts` are repointed; `store/evalsStore.ts` implements `EvalsResourceCache`; the models and `evalsPaths` are deleted and repointed (`lib/tabSafePath.ts`).
  - Files: those named above plus the mirror, manifest and lockfile.
  - Accept: parity identical apart from `capabilities`; mount tests; `store/__tests__/evalsStore.guard.test.ts`; `cast check`; screenshot spot check of Home and Run.
  - As built (in the working tree, 2026-10-06):
    - P3 had no platform commit and P4a was already writing `react/`, so the vendor ran from a frozen copy of the platform tree (`/tmp/pf-c9`, taken while `react/` still held P0's barrels) through `PLATFORM_DIR`, for `evals` and `cli-kit` only.
    - Three platform models handed back `RunRowCore` (or the core `SurfaceOverview`) where they return the rows they were given, which lost codecast's row type in FreezeView, RunView and the wall: `batchColumns`, `seedNeighbours` and `wallOrder` are now generic over the row (`<R extends RunRowCore>`, `<S extends SurfaceOverview>`), in `~/src/platform` and the vendored copy alike. Platform typecheck and its client and query tests stay green.
    - `api/sources.ts` maps codecast's homes onto the platform `EvalsSources` exactly as section 3 says and `satisfies EvalsSources<RunRow, SurfaceMeta, SimFailureMoved>`; `simOverview`'s failure is typed `SimFailureMoved`. `api/views.ts` throws the platform's `NotFound` and `BadRequest` and keeps `RunDetail` beside `runFolder`, its one user. `core/` is gone whole: with `query.ts` deleted, `core.guard.test.ts` walked nothing, and platform's `layers.test.ts` holds the same purity rule for the code that moved.
    - The surface header's keys now come out as id, title, route, model, freezes, then codecast's info (criteria first), where codecast put criteria before freezes. Parity compares values, not key order, and no reader depends on the order.
    - Web: `lib/evals/client.ts` is `loopbackTransport` alone, over the client's `evalsUrlPath`, `evalsFetchInit` and `evalsResponseOf`. `store/evalsStore.ts` backs `EvalsResourceCache` with its `resources` slice, delegates `call`, `load` and `invalidate` to `createEvalsClient<EvalsRoutes>` with `classifyEvalsFailure` as `onFailure`, and exports codecast's typed `evalsRequest`, `evalsCacheKey` and `callEvals` from `evalsCalls<EvalsRoutes>()`. `fixtureTransport.ts` answers through `localTransport(handler, 'fixture')`, which does the copy it did by hand. `useEvalsChanges` runs the client's `followChanges` with a `Visibility` built from the document and the pane, so a hidden pane keeps its cursor and asks at once on return; the hooks' `EVALS_POLL_MS` and `EVALS_STALL_MS` are the client's `EVALS_POLL` and `EVALS_STALL_MS`. One change of detail: the cursor now restarts when a view stops and starts being live, where before it outlived that.
    - The models, `format.ts`, `charts/scale.ts`, `evalsPaths.test.ts`, `runModel.test.ts` and `wallModel.test.ts` are deleted; every importer reads `@platform/evals/client`, and the link builders get `evalsHref` as their first argument. `isJobStalled` moved to `simJobState.ts` beside the sim views. The foundation guard allows `@platform/evals/client` as an outside import of the shared views.
    - Mobile reaches `tabSafePath`, so its bundle now carries the whole client barrel (about 256 KB of source with analysis, against the contract's 72 KB before) for the address grammar alone; Metro does not tree-shake. A narrow `./client/paths` export in platform would bring that back; nothing breaks without it.
    - Checks: parity on one pin, `before` against `after` and `final` (after the re-vendor), identical over 368 files, with `capabilities` on `/health` the one addition; two baseline dumps compared identical first. `cast check`: cli, web, convex, sim, evals 0 errors, mobile at its known 349 (none in evals). The 7 mount tests, the store guard, `api/api.test.ts`, the path, tab and Line tests and the mirror's 203 evals tests pass. Fixture screenshots of Home and a Run; a real-data pass over the daemon (loopback, `capabilities` served by the live child) kept in `/tmp`.
- **U3 (union landing): adapter, no UI.**
  - Vendor at P3's sha.
  - Files: `src/components/admin/evals-shared/{mapRows,mapSim,unionSources,policy}.ts` and `mapRows.test.ts`.
  - Accept: the mapping tests read recorded `/api/evals/rows`, `/api/simulations/db/:id` and `/score` JSON fixtures; the tests assert `batchVerdict` returns `unfooted` and that capabilities exclude epochs, attribution and bisect; type-check.
  - As built (in union's working tree, 2026-10-06):
    - Vendored from a frozen copy of platform's tree (`/tmp/pf-u3`, base `08be468` plus the uncommitted P0, P1 and P3), for `evals` and `cli-kit` only. P4a wrote `react/host.ts` the second the copy was taken, so that one file was dropped and `react/` holds P0's barrels; C9's later generic models are not in it either, and U4 re-vendors. `--check` against the copy and `--check-manifest` pass.
    - Two fixes to union's wrapper (`outreach/scripts/vendor-platform.sh`). Its `npm i --package-lock-only` kept the old `@platform/evals` lock entry, because npm keeps a `file:` package's entry while its version stands, so evals' new optional peers never reached `landing/package-lock.json`. The wrapper now drops the mirrored packages' entries first, and the lock matches a from-scratch regeneration. It also passes `--copies landing/node_modules/@platform/*`, so the local copies outreach's bun install made are refreshed in place, and no `bun install` at `outreach/` (which would bake other sessions' dirty package.json files into `bun.lock`) is needed to import the new subpaths.
    - Files beyond the list: `__fixtures__/*.json`, recorded from union's own `evalsRouter` and `simulationsRouter`, mounted bare over a loopback database seeded with synthetic runs (`/api/evals/rows?layer=all`, `/api/evals/overview`, one scenario page, `/api/simulations/db`, three `/db/:id` and two `/score`). The sim routes answer raw SQL times (`2026-10-06 05:02:45.392-04`), so the adapter writes every stamp as ISO: the views compare stamps as text.
    - The rows read both layers; a layer 2 run's selection (`sims:...`) keeps its batches apart from layer 1's. A scored sim's row needs its `/score` (the list carries only the failed-gate count), read once per sim and score. Rows are read at most every 10 s and the same array comes back while nothing changed; the case rates at most every 5 minutes, and a failed read of them shows no gate rather than no page. A result's run page reads `GET /api/evals/runs/:id/scenarios/:resultId` (reply, judge reasoning, error).
    - `mapRows.test.ts` (24 cases) runs the recordings through `createEvalsHandler(unionSources, unionPolicy)`: `batchVerdict` and `/surface` and `/batches` answer `unfooted`; `capabilitiesOf` and `/health` give trends and liveness only, and `/epoch`, `/attribution`, `/bisects`, `/commit`, `/freeze` and `/changes` answer 404; the gates come out green, red, unknown and none; the running sim is stalled 12 minutes after its newest event, as the backend's `live` says. Landing type-check (CI's script) green; eslint clean on the new files.

### Wave 5 (parallel, platform)

- **P4b Run, P4c Surface, P4d Freeze/Compare, P4e Bisect/Attribution.**
  - Each copies its codecast group (as converted in C4 to C7) into `src/react/<group>/`, with its pages and CSS.
  - Union's ideas land here as optional parts:
    - P4b: rubric preview in GateList/JudgeChecks before a score exists, run `problems[]` in the run header, and a `Timeline` (StoryFeed generalised, with `calibrateOffsetMs`).
    - P4c: the gate chip from `SurfaceInfo.gate`.
  - Accept: platform checks, including `guards.test.ts` and a happy-dom mount test per group.
  - P4b as built (in `~/src/platform`'s working tree, uncommitted like P4a):
    - Files: `react/run/{RunView,GateList,JudgeChecks,CostTrack,Timeline,RunPage}.tsx`, `run.css`, `index.ts` (`runPages`: run) and `run.mount.test.tsx`; `client/models/timelineModel.ts` and its test (one export line in `client/index.ts`); `RubricGate`, `RubricCheck`, `RunRubric` and `RunProblem` in `contract/views.ts`; the `run` slot and `RunCommand` in `react/host.ts`; and `src/mountKit.ts`. The views are C4's copies with imports retargeted: rows are `RunRowCore`, links are the host's `useEvalsPaths().href`, the moment and production reply come from `freeze/FreezeView` (P4d), and CostTrack sits here because C4 gave it to the Run group (SurfaceView imports it by file; its `.ev-sf-cost*` rules are in `surface.css`). RunViewProps extends GateList's `AnchorProps` rather than restating the target and anchor fields.
    - Rubric preview: the neutral `rubric` may name its gates (`RubricGate`: id, title, decidedBy) and judged checks (`RubricCheck`: id, ask, weight, must). RubricCard draws them after the criteria as "Gates it will be held to" and "Judged checks it will be held to", through the same row markup the scored GateList and JudgeChecks use (`GateRow`, `CheckRow`), pending (`data-ev-gate-pending`, the unscored glyph, no score bar), each with its own `#gate-`/`#check-` address. A rubric of words alone draws exactly as before. Union's `mapSim` sends its resolved rubric as `gates` (id, statement as title) and `checks` (id, ask, weight), with no criteria text (U4).
    - Problems: `RunResponse.problems?: RunProblem[]` (id, seq, label, error, fatal). A fatal problem stands at the top with the crash ("The run failed: <label>"), unless a log tail already tells it; the others are "N steps failed without stopping the run" under the header, six shown and the rest counted. Codecast sends none.
    - Timeline: union's StoryFeed generalised. `client/models/timelineModel.ts` holds the pure half: `calibrateOffsetMs(fallbackMs, pins)` (the median residual of rows whose true instant is known, else the fallback; a pin is `{ stored, actual }`, so union passes `slack_ts * 1000`), `onRunClock`, `runClockLabel` ("D+3 14:00", "D-1 17:00"), `dayIn`, `orderTimeline` (a marker reads before the line it provoked within 2 s) and `laneCounts`. `react/run/Timeline.tsx` draws `TimelineItem`s (when, lane, an optional marker, where, context, a `--ev-*` accent, the host-drawn body and its length) with day rules, a lane filter through the host's SegmentedToggle (empty lanes not offered), and long bodies folded behind "show more". A host shows it as one of its `useRunPanels` tabs. U4 reuses union's own StoryFeed instead (section 5), because StoryFeed builds its rows inside the component and a second mapping onto Timeline would duplicate that; moving union onto Timeline means exporting StoryFeed's row building first.
    - Host slot `run?: { commands?(row, evalsHome): RunCommand[]; VerdictFoot? }`, beside `wall`. Without `commands` the page offers the run folder and the freeze replay (platform's own layout and CLI); `rescore` is codecast's, so C10 passes all three. `run.extra` (the analyzer grade) is not a neutral field: the Verdict tab ends with the host's `VerdictFoot`, where C10 draws codecast's "Analyzer grade" section (grade-auto.json open, hashes.json) over `extra`.
    - Capabilities: without `freezes`, RunPage asks for no freeze, RunView draws no Moment tab (`#moment` opens Verdict) and the freeze chip is plain text, and an unscored rep with no rubric says "No score and no rubric on record" instead of waiting on the freeze. A landing rep follows `/changes` only where `capabilities.changes` holds, so union's running sims never ask a 404ing feed; they fill in on the next visit (no product polls a run page yet).
    - `src/mountKit.ts` is the shared happy-dom harness (`installDom`, `rep`, `NIGHT`), test-only like `guardKit.ts`; P4a's `react.mount.test.tsx` now uses it, and it adds `CSS` to the globals (RunPage's landing reads `CSS.escape`).
    - Proof: `run.mount.test.tsx` (7 cases over `localTransport(createEvalsHandler(...))`): a scored rep (failing gate first, landing on `#gate-no-leak`, checks, floors, history, judge, reply, links under the base path, the default copies), the host's tabs, commands and verdict foot with tab moves through the address and the Moment tab's moment, sends and production overlay, the rubric preview and eight problems, a words-only rubric and the fatal rules, a rows-only product (no Moment tab, no freeze link, no `/freeze` or `/changes` request), and the Timeline (order, days, labels, tones, lanes, fold). `timelineModel.test.ts` (4 cases). Evals typecheck clean; all 259 evals tests green (a CLI case times out at load 54 and passes with `--timeout 30000`); root typecheck red only in the known auth and engine files. A static Bun rig in `/tmp` (synthetic data, base `/lab`) rendered a scored rep, an unscored rep with its rubric and problems, the Story tab and a stalled run, light and dark.
  - P4c as built (in `~/src/platform`'s working tree, uncommitted like P4a):
    - Files: `react/surface/{SurfaceWallView,SurfaceView,WhatMoved,Seismograph,ScoreStrip,BrushRect,GateChip,HomePage,SurfacePage}.tsx`, `useDayBrush.ts`, `surface.css`, `index.ts` (`surfacePages`: home, surface) and `surface.mount.test.tsx`; plus `useEvalsCapabilities()` in `react/hooks.ts` (only an explicit false turns a capability off, so a server from before capabilities draws everything), which `EvalsNav` now reads for its three checks and P4e's `EvalsApp` gate reads too. The views are C5's copies over `useEvalsPaths().href`; charts sit flat in the group (`Well` was already P4a's `shell/Well.tsx`). SurfaceView draws `CostTrack` from `../run` and `FreezeLedger`, `ComparePanel` and `EpochDiffSheet` from `../freeze`; FreezeView imports `Seismograph` and `ScoreStrip` from this group by file.
    - The header reads what the product's surface carries. The neutral `SurfaceInfo` has no freeze counts or codecast fields, so the view reads them as an optional `SurfaceHeaderInfo` (`freezes`, which the query adds only for a product that keeps freezes, and codecast's `criteria`, `sources`, `reps`, `maxUsdPerRep` from its `info`); each chip shows only when present, and the route and model chips only when not null. The wall's route chip, model and staleness glyph follow the same rule (staleness words other than codecast's five show as the word alone).
    - The gate chip (`GateChip`) leads the header chips: a filled cyan disc and "gate holds", a red ring and "gate failed", or a dotted ring and "gate not read yet", with the backend's `detail` after a hairline and its `rule` as the tooltip. Nothing recomputes it. A verdict whose reps record no model or judge (`unfooted`) says "model and judge not on record" on its line.
    - The seismograph takes the surface's `passMark`: left out (codecast) it rules 0.7 as before, null (union) rules none.
    - Hidden by capabilities: the wall's Open bisects block (and the foot itself when the host adds no `wall.Foot`), the `b` attribute key on the wall and the surface, the surface's bisect probes toggle, and its `e` epoch key.
    - CSS: `surface.css` is C5's `surface.css` and `wall.css` minus what other groups own: the plate, drawer, sheet, icon button and pair-flip rules are in P4d's `freeze.css` (with `.ev-sf-ylabel--halo`, which only FreezeView draws), and `.ev-wall-simline*` stays with codecast's `wallSim.tsx`, so C10 keeps those rules in a codecast stylesheet. It carries the three `.ev-sf-cost*` rules, because only the surface page draws CostTrack and `run.css` has none. `has-compare` is now `ev-sf--compare` (the class guard).
    - Two visible words changed for neutrality, both on states codecast rarely shows: the empty wall says "The wall fills in as the product's runs land." (was "Run ./evals check from the checkout..."), and an unknown surface says "The wall lists every surface this product knows." The public and private chips' tooltips no longer name `packages/evals` and EVALS_HOME.
    - Proof: `surface.mount.test.tsx` (6 cases, happy-dom, `localTransport(createEvalsHandler(...))`): a rows-only product with gates (worse first, nothing it cannot answer, keys through the host, What moved under the base path) and a full one (open bisects, the host's foot and own What moved kind, route and model, codecast's header chips, criteria, 0.7 mark, every key, `b` attributing the pinned pair). Evals typecheck and all 259 tests green; root typecheck red only in the known auth and engine test files. A static Bun rig in `/tmp` (synthetic data) rendered both products' wall and surface in Chrome, light and dark.
  - P4e as built (in `~/src/platform`'s working tree, uncommitted like P4a):
    - Files: `react/bisect/{AttributionView,CommitPanel,BisectRuler,BisectView,BisectListView,BisectPlanPanel}.tsx`, `react/bisect/pages/{CodePage,BisectListPage,BisectPage,BisectNewPage}.tsx`, `bisect.css`, `index.ts` (`bisectPages`: commit, patch, bisect-list, bisect-new, bisect) and `bisect.mount.test.tsx`; plus two slots in `react/host.ts` and a capability gate in `react/EvalsApp.tsx`. The views are codecast's C7 copies; every `evalsHref` link is the host's `useEvalsPaths().href`, so links follow the base path.
    - The group called four codecast-only routes. They are now optional host slots, in the style of `useRunFile`: `usePatch(sha)` (`GET /patch/:sha`; it returns a `PatchView`, which codecast's `PatchResponse` already satisfies) and `useBisectActions()` returning `BisectActions` `{ plan, start, stop }` (`POST /bisect/plan`, `POST /bisect`, `POST /bisect/:id/stop`). Without `usePatch` a patch says the product keeps none. Without `useBisectActions` the pages only read: the attribution page shows the free answer and no plan, and a live bisect has no Stop. The plan's pricing effect reads the actions through a ref, so a host that hands over a new object each render does not price again.
    - `EvalsApp` gates a view on the capability its page reads (`bisect-list` and `bisect` on `bisect`, `bisect-new` on `attribution`, `commit` and `patch` on `commits`), through the shared `useEvalsCapabilities` (only an explicit false turns one off). A product without them gets the "not shown here" state, as P4a's rows-only test expects for `/bisect`, rather than a page that reads a 404. Codecast's `/health` answers all three true, so nothing changes there. Other groups add their own views to the same `NEEDS` map.
    - Two rules in `bisect.css` named codecast's own markup, and now name the default slots' classes: the tile's session pill ellipsis is `.ev-b-tile-session .ev-chip` (was `.entity-ref > span:last-child`, EntityIdPill), and the evidence card is `.ev-b-examples .ev-pair` (was `.cc-example`, the change card). C10 must keep both codecast versions in a codecast stylesheet, as with P4a's `.cc-*` rules.
    - C10 wires the slots in `host.tsx`: `usePatch` over `useEvalsResource("GET /patch/:sha")` and `useBisectActions` over the client's `call` on the three POST routes, memoized. BisectPlanPanel keeps codecast's words for a lock holder the pages cannot open (`./evals bisect status|stop`); only a host with bisect actions reaches that panel.
  - P4d as built (in `~/src/platform`'s working tree, uncommitted like P4a):
    - Files: `react/freeze/{FreezeView,FreezeLedger,CompareView,ComparePanel,EpochDiffSheet}.tsx`, `react/freeze/pages/{FreezePage,ComparePage}.tsx` (the `pages/` layout P4e uses), `freeze.css`, `index.ts` (`freezePages`: freeze, compare; the views and their prop types) and `freeze.mount.test.tsx`; plus one line in `react/EvalsApp.tsx`'s `NEEDS` map (`freeze: 'freezes'`). The views are codecast's C6 copies with imports retargeted: rows are `RunRowCore`, every `evalsHref` link is the host's `useEvalsPaths().href`, and ComparePanel's `route` is `string | null` (the neutral `SurfaceInfo.route`). The group reads the Surface group's `EpochBands`, `RepHatch`, `RepMark`, `RepTip` (`surface/Seismograph.tsx`) and `FootingGlyph` (`surface/ScoreStrip.tsx`), the Bisect group's `CommitMarks` (`bisect/CommitPanel.tsx`) and the shell's `Well`. SurfaceView imports FreezeLedger, ComparePanel and EpochDiffSheet from the `../freeze` barrel, and RunView imports `MomentPane` and `ProductionCard` from `freeze/FreezeView`.
    - Capabilities: a product without `freezes` gets EvalsApp's "not shown here" state for a freeze address (the shared `NEEDS` gate, not a check inside the page). Without `attribution`, the freeze page's "Attribute this freeze" and the drawer's "Attribute this" launcher are not drawn (`useEvalsCapabilities`). Codecast serves both, so its pages draw as before. One wording change: ComparePage's 404 says a run id "names no run" rather than "no run folder", since a product's runs need not be folders.
    - `freeze.css` holds every rule only this group's views use: codecast's `freeze.css`; from `surface.css`, the assay plate, compare drawer and epoch sheet sections (`.ev-sf-ledger`, `-plate*`, `-well-link`, `-pairflip`, `-compare*`, `-sets`, `-set*`, `-pinmark`, `-verdict`, `-section`, `-gates`, `-gate-words`, `-examples`, `-example-*`, `-select`, `-sheet*`, `-epoch-chip`, `-commits`, `-commit-subject`) plus `.ev-sf-iconbtn` and `.ev-sf-ylabel--halo`; from `run.css`, the compare block (`.ev-cmp-*`, `.ev-diffrow*`, `.ev-arrow`, `.ev-broke`, `.ev-fixed`). The seismograph marks the rep strip borrows (`.ev-sf-seis`, `-pin`, `-passmark`, `-median`, `-axis`, `-xlabel`, `-ylabel`, `-ylabel--mark`), Seismograph's commit and footing marks (`.ev-sf-commit`, `.ev-sf-footing-rule`), `.ev-sf-note` (SurfaceView too) and run.css's shared rows (`.ev-rows`, `.ev-row-id`, `.ev-section`, `.ev-split`, `.ev-empty-note`) stay with their groups. Checked against P4b's and P4c's sheets: none of the moved rules is declared twice. No other sheet targets these classes, so loading them after `run.css` (platform's `styles.css` order) changes no cascade.
    - Proof: `freeze.mount.test.tsx` (13 cases, happy-dom, `localTransport(createEvalsHandler(...))` over a product with freezes, run anatomy, pair diffs, prompt files and git, under base path `/lab`): the default pair either side of the newest break, the label, production and the moment cut, every rep, the break notch, epoch bands, A and B rings, the prompt change between the cards, repicking and swapping through the default slots, a flip link opening on its two reps, the launcher and every link under the base path, the 404s, the compare page, the plate, the drawer and the epoch sheet from the handler's own answers, and both capability gates. Evals typecheck clean; the evals suite green except a CLI case that times out at load 63 and passes with `--timeout 60000`; root typecheck red only in the known auth and engine files. A static Bun rig (in `/tmp`, synthetic data) rendered the freeze, compare and surface-with-drawer pages in Chrome, light and dark, beside codecast's fixture freeze page.
    - For U4: a host that sets no `--font-ui` gets mono (tokens.css), and in mono the drawer's "Attribute anyway: this pair did not separate" button (330px of text) overflows the drawer at its 400px clamp by about 40px. With codecast's UI font the label is 248px and fits. Union should set `--font-ui` at its mount root (U4 does: codecast's UI stack, and JetBrains Mono for `--font-mono`).

### Wave 6 (parallel)

- **C10 (codecast/web): switch to platform views.**
  - One vendor commit (at the P4 sha), then one commit per group that imports from `@platform/evals/react`, deletes the local copies, and adds `components/evals/tokens.drift.test.ts`.
  - The sim views (`SimCatalogView`, `SimRunView`, `DeliveryTimeline`, `OrderStrip`) switch to the platform primitives.
  - Accept per commit:
    - the screenshot set for that group in three themes against the wave 2 baseline
    - the 7 mount tests (including `Sim.mount.test.tsx`)
    - `cast check web`
    - after the last commit: the full screenshot set, plus a manual real-data pass kept in `/tmp`
  - As built (in the working tree, 2026-10-06; nothing committed, so the per-group commits became one pass checked group by group):
    - Vendor: P4 had no platform commit, so the run took a frozen copy of platform's tree (`/tmp/pf-c10`) through `PLATFORM_DIR`, for `evals` and `cli-kit` only. The copy was taken twice: U4 changed `react/` while the first was in use (`.ev-host`, a `display: contents` wrapper around what a host draws in a run tab, the verdict foot and the wall foot, kept out of the reset; and the run ruler reading the rubric's pass mark), and the mirror now equals platform's tree with those in.
    - `app/evals/page.tsx` is `CodecastEvalsProvider` around `EvalsApp`, with the two lazy sim pages as `pages`. All 33 local view, page, chart and sheet files are deleted, with `tokens.css`. What is left in `components/evals`: `host.tsx`, `host.css`, `evalsPaths.ts`, the run anatomy (`runPanels`, `CallPane`, `AgentTranscript`, `GuardLog`, `RunFiles`, `runPanels.css`), `wallSim.tsx`, the sim views and pages, the fixtures and the tests.
    - `host.tsx` is codecast's host alone, checked with `satisfies EvalsHost`. New in it: `navSections`, `useSearchIndex`, `useRunFile`, `usePatch`, `useBisectActions` (memoized over the client's `call`), `run.commands` (path, replay, rescore) and `run.VerdictFoot` (the Analyzer grade). Two slots hand a codecast component the neutral answer type while the wire carries codecast's wider one (`extra`, `sim`); a `Slot<C>` type names that one boundary.
    - `store/evalsStore.ts` lost `call`, `load`, `invalidate`, `refreshHealth` and `health`. It exports `evalsResourceCache` and `onEvalsFailure`, and `connect` writes the `/health` answer that proved the connection into the cache, where the views read it. One client per mount, the provider's.
    - `host.css` keeps the rules that name codecast's own markup: the `[data-ev-flip] .cc-*` tints, `.ev-b-tile-session .entity-ref`, `.ev-b-examples .cc-example` and `.ev-wall-simline*`.
    - Sim views on the platform primitives: `EvalsLink`, `VerdictGlyph`, `LogTail`, `StallChip`, `CopyCommand` and `KeyHint` from `@platform/evals/react`; SimRunView binds its five keys through `host.useShortcuts` (which switches the `evalsSim` context on, as its own `useShortcutContext` did) and draws them with `KeyHint`, so its `ActionKeys` copy is gone; the clock, the pane's focus and the lanes' width are `host.useNow`, `useActive` and `useContainerWidth`. `ActivityCharts` takes the day brush from `@platform/evals/react`.
    - `vite.config.ts` pre-bundles `@platform/evals/react` (`optimizeDeps.include`). Without it the first visit to the lazy `/evals` route re-optimized mid-session and the page ran two Reacts ("Invalid hook call"), the failure the list's own comment describes for other lazy routes.
    - Tests: the 7 mount tests import the views from `@platform/evals/react` and mount under `CodecastEvalsProvider` (a test's other host is its `host` prop). The foundation test's source rules moved with the views to platform's `guards.test.ts`; codecast's now hold that no file in `components/evals` shares a name with a platform view or sheet, and that `host.css` and `runPanels.css` read only `--ev-*` tokens the vendored `tokens.css` declares. New `tokens.drift.test.ts` compares each fallback in the vendored `tokens.css` with `globals.css` (`:root` and `.dark`); a planted one-digit change to `--sol-cyan` fails it.
    - Three wordings changed here, all platform's neutral text: the page for an address that names no view ("links to every surface and run", was "every surface, bisect and Multiplayer sim run"), and P4c's two (the empty wall and the unknown surface). The fix pass below gives them back to codecast through the host's `words`.
    - Checks: RunView 24, FreezeView 18, SurfaceView 16, SurfaceWallView 16, Bisect 41, Sim 16 and Foundation 20 cases pass; the store guard, path, tab and mobile bundle guards pass; `cast check` web, evals, cli, convex and sim at 0 errors; a production `vite build` succeeds, with the evals page in its own 226 KB chunk and the brush ActivityCharts shares in a 32 KB one. `lib/__tests__/fastRefreshBoundaries.guard.test.ts` is red on main for dozens of files outside this unit, and lists the area's `host.tsx`, `runPanels.tsx`, `wallSim.tsx`, `GuardLog.tsx` and `RunFiles.tsx` as it did before.
    - Screenshots (fixture transport, cropped to the area, 18 pages in light, dark and minimal, before and after): 49 of the 54 pairs compare. 40 are pixel-identical; the other 9 differ by under 0.5% in the wall's strips, one line of a surface, the bisect list's live glyph, a live bisect and the sim catalog, and a same-code control captured minutes apart differs by the same amounts in the same boxes (the charts' x scale runs to the present). Five baseline shots were unusable (two light error screens caught in Minimal, dark home and surface at another pane width, dark freeze showing a transient "No freeze with this id"); each of those pages is pixel-identical in the other two themes. The theme was set by the root's classes, because the app pins Minimal in the hosted lane and reads the theme from synced state. A sibling unit shares the session's browser tab and navigated it mid-capture several times; every kept shot recorded its URL.
    - Real-data pass over the daemon (8,757 runs), kept in `/tmp/c10/real`: wall, surface, freeze, run with its Calls and Files tabs (a file read through `GET /run/:id/file`), compare, commit, bisect list, a bisect, attribution, sim catalog and a sim run. The search box found a freeze by id prefix through `GET /search` from a page that had not loaded it.
  - Fix pass (2026-10-06, after U4's fix passes and U6; platform and the mirror, in the working trees). The C10 screenshots predated about 25 view changes, so the proof was retaken, and five review findings were fixed at their root:
    - Words. `EvalsHost.words` (`EvalsWords` in `react/host.ts`) holds the sentences that name where a product keeps its runs: the not-found page's tail, the empty wall, an unknown surface, the surface's public and private freeze counts, a freeze's lock badge, the compare page's missing run, and the fixture chip. The defaults are neutral, merged by `resolveEvalsHost` like `ui` and `format`, so union passes none. Codecast's host passes its own words from before the shared views, so the three wordings above, P4c's chip tooltips and P4d's "names no run" read as they did at HEAD, and section 1's bar needs no recorded deviation.
    - Flip pairs. P4e's AttributionView passed `stack={false}`, so codecast's slot drew the change card's pair with no `cc` container around it, and the pair laid out against the whole page: side by side in a 380px grid cell, with After spilling out of the cell. HEAD wrapped every pair. The option is gone (`ExamplePair` takes `ex` only, and every pair stacks when its own width is narrow), and both the platform and codecast tests now hold that the pair sits in its container.
    - Keys in the test directory. `@platform/keys` bound its capture listener to the window that existed when the module first loaded, and each mount test file brings its own jsdom window, so every file after the first to load it got no shortcuts (`bun test components/evals/` failed the wall's `j`/`k` and Sim's arrows). `setShortcutHandler` now writes the current window's slot, as `claimKeys` already did; in an app the window never changes. `listener.test.ts` has the case. The directory runs 166 pass, 0 fail.
    - One bisect read. The api child's `STALL_MS`, `controlsOf` and `summaryOf`, the client model's `BISECT_LIVE` and `bisectOutcomeOf`, and the fixture world's own stall rule and summary were five copies of three rules. They are now `@platform/evals/analysis` (`analysis/bisect.ts`: `BISECT_LIVE`, `isBisectLive`, `bisectOutcomeOf`, `bisectSummaryOf`, `bisectControls`, `bisectStalled`, `bisectResponseOf`; `EVALS_STALL_MS` in `analysis/liveness.ts`, re-exported by the client). `api/bisects.ts` reads its files and hands them to `bisectResponseOf`; the fixture world hands over its records the same way, so its bisect pages show production's stall rule and controls. The parity dump is identical (368 files).
    - Bundle. `@platform/evals` declares `"sideEffects": ["*.css"]`. An entry importing only `BrushRect` and `useDayBrush` (what `ActivityCharts` takes) bundled with web's vite to 17,288 bytes over six modules (context, hooks, parts, defaults among them) without the field, and to 946 bytes over the two it needs with it.
    - Screenshots. C10's fixture world changed under C11, so new shots cannot be laid over C10's sets, and C10's web side was never kept, so its views cannot be run again under today's host. The comparison that answers "does today's tree draw what HEAD drew" is C10's own, retaken: HEAD's fixture world on both sides, HEAD's views in one scratch tree and today's views (the mirror and host after this pass) in another, each served by vite on its own port and mounted the way `app/evals/page.tsx` mounts it, at one width, through one cast browser tab. All 18 pages in light, dark and minimal: 54 of 54 pairs compare, including the five C10 could not use. 31 are pixel-identical; 23 differ by under 0.2% (the wall's strips, a bisect's step times, the sim catalog's "17h ago", the bisect list's live glyph and sub-pixel antialiasing in a run's chips), all the clock moving between the two captures. The first retake, before this pass's last fix, found the flip pairs above (1.2% on the finished bisect and the attribution page), and a run chip reading "in 2m" for 137 seconds while another session's change to the chip was mid-edit; that session's final version reads "in 137s" as HEAD did. Kept in `/tmp/pl810-fix/shots`.
    - Real-data pass on today's tree over the daemon (8,757 runs), kept in `/tmp/pl810-fix/real` and never uploaded: wall, surface, freeze, run with its Calls tab, compare, commit, bisect list, a finished bisect, attribution, sim catalog and a sim run, all drawn and connected.
- **U4 (union landing): mount.**
  - Vendor at the P4 sha.
  - Files: `src/components/admin/evals-shared/{host.tsx,UnionEvalsMount.tsx}` and `src/app/admin/evals/v2/[[...path]]/page.tsx`.
  - Accept:
    - type-check, lint, tests
    - local Railway-equivalent build
    - cast browser screenshots of the v2 home, an eval surface, a sim surface, an eval run, a sim run with union panels, a compare, and a running sim showing the stalled chip
    - no "Invalid hook call" or duplicate-React warnings in the console. Outreach's bun install (hoisted) installs evals' devDependencies and can nest its `react 19.1.0` inside `landing/node_modules/@platform/evals/node_modules`. That needs no config: Next's app router compiles every `react` import to its vendored copy (section 6). Railway's npm build is safe through install-links as well.
  - As built (in union's and platform's working trees, 2026-10-06):
    - Vendored twice more from a frozen copy of platform's tree (`/tmp/pf-u4`: `08be468` plus the uncommitted P0 to P4e and the platform edits below), `evals` and `cli-kit` only; `--check` against the copy and `--check-manifest` pass, and the local copies in `landing/node_modules/@platform` match it.
    - `host.tsx` (`unionEvalsHost`): links through Next's router (`router.push`/`replace`, no scroll); a move that changes only the fragment (a run's tab) goes through `history.pushState`, which Next folds into its router, plus an event the hash store listens to. `useHash` is a `useSyncExternalStore` over hashchange, popstate and that event, re-read on every route change. `copy` toasts through sonner. `run.commands` is empty: union's reps have no folder or replay to copy. `useRunPanels` gives a sim its Story (StoryFeed, which reads the event log while open), Funnel, Cast (TeamRosterCards), Email (EmailThreads) and Caplight tabs, read through the sim pages' own polling hooks (`components/admin/sim/api.ts`) and polled while the sim waits on its grade; an eval result gets none. Every other slot is the package default.
    - `UnionEvalsMount.tsx`: `EvalsProvider` over `localTransport(createEvalsHandler(unionSources(), unionPolicy))` and `memoryResourceCache()`, `EvalsApp` at the pathname, the two stylesheets imported once, and `--font-ui`/`--font-mono` set on its root. The route is `app/admin/evals/v2/[[...path]]/page.tsx` in a Suspense boundary (Next's `useSearchParams`).
    - Beyond the listed files: `mapSim.ts` sends the rubric as gates and checks (P4b's rubric preview), and its test follows.
    - Platform edits the browser pass needed (in `~/src/platform`, with mount tests): RunView draws `LivenessChip` beside "not scored yet", since no view drew it; RunView's ruler reads `run.rubric.passMark` before the row's, so a sim held to its gates alone shows a mark of 0 as its rubric says, not 0.7; and `shell.css`'s reset now skips host-drawn parts. Those sit in `.ev-host` (`display: contents`) around `useRunPanels` bodies, `run.VerdictFoot` and `wall.Foot`. The reset is unlayered, and Tailwind v4 puts union's utilities in `@layer utilities`, so the reset beat every utility in union's own panels (unsized buttons, lost borders). Codecast's Tailwind v3 compiles unlayered, so codecast's panels get its preflight as they did before the reset existed. C10 picks these up on its next vendor.
    - Proof: a scratch stub of union's API in `/tmp` (U3's recorded fixtures plus synthetic sim world, funnel, email, Caplight and event data, a synthetic admin session; nothing real, nothing in production) behind landing's `next dev`, with Convex and PostHog pointed at nothing. Fixture screenshots of the wall, an eval surface (gate chip), the sims surface, an eval run, a sim run with its Story, Cast, Funnel and Caplight tabs, a compare, and the running sim with "stalled?". The console holds only the admin shell's Twilio init failing against the stub. Landing typecheck (CI's script) green; eslint on the unit's files clean at `--max-warnings 0`; `bun run test` runs the adapter's 24 cases among 1304 passing, with failures only in `callCapture.test.ts`, whose source another session has uncommitted edits in.
    - Fix pass after verification (2026-10-06, platform, union and both mirrors, still in the working trees):
      - A graded result drew as unscored ("not judged yet", "No score and no rubric") under a head that said "0.72 passed". The run page took "judged" from the score sheet alone. It now reads it from the row too (`isGraded`), and a product that keeps the judge's words without the call (an empty `judge.prompt`) gets them as "What the judge said". `evalRun` sends no score sheet on purpose: union keeps one composite score, and each scenario sets its own threshold (0 to 1), which no route returns, so a sheet would invent a pass mark. It sends `without: ['mark']`, and the ruler and seed strip draw no mark.
      - Two capabilities were missing, so two were added: `models` (a product says `models: false` when its rows name no model or judge) and `compare` (on when the product hands over `pair`). Without `models`: no model or judge chip on a run, a reply card or a compare side, no model in a rep's tooltip or a batch column, and no "facet by model". Without `compare`: no "compare with", no `c` key, no compare page, and `GET /compare` answers 404. Codecast has both, so it draws as before.
      - Existing capabilities now reach the places that ignored them, through two shared parts: `PageLink` (a link where the capability holds, the same words where it does not) and `LockBadge` (nothing without `freezes`). Without `freezes` the ledger's names and wells and the drawer's flips are not links. Without `commits` a rep's head is plain text, and a rep with no head draws no chip. Without `epochs` (no prompt files) the drawer's "What the model saw" and the compare page's "Both prompts" are not drawn.
      - `RunResponse.without` (`reply`, `mark`): a sim's page says `without: ['reply']` and draws no reply section.
      - The drawer named a flip count and nothing under it for a product with no flip examples. It now names each flipped case with its before and after runs.
      - `components/admin/sim/api.ts` `usePolled` keeps an answer with the path it was read from, so moving between two sims never draws the last sim's panels, and a late answer for the old path is dropped. This also covers union's own sim pages.
      - Checks ran on a clean worktree of origin/main with the unit's files laid over it (landing is identical at union's stale HEAD and at origin/main; the 460 dirty paths in the main checkout are other sessions'). Results are in the task thread.
    - Second fix pass (2026-10-06, platform, union and both mirrors, in the working trees). Verification found two pass marks on one sim page (the ruler at 0, the seed strip at codecast's 0.7) and a 0.7 line on every strip of union's wall.
      - The cause was that each part chose its own mark: three call sites fell back to `PASS_MARK` on their own, and the wall's strip hardcoded it. Every drawn mark now comes from one hook, `usePassMark()` (`react/hooks.ts`): the mark a score, rubric, row or surface names, else the default, and null for a product that records none. The ruler, seed strip, rubric card, checks' total, every `ScoreBar`, the wall's `ScoreStrip`, the seismograph and the freeze strip all draw through it, so two parts of a page cannot disagree. `PASS_MARK` is read by nothing else in `react/`.
      - "Records none" is a capability, `marks`, from `EvalsSources.marks` (false turns it off, as `models` does). Union says `marks: false`: an eval scenario's threshold is returned by no route, and a sim is held to its gates alone. So no union page draws a mark, a sim's rubric card reads "It passes when every gate holds.", and a bar with no mark takes its colour from the verdict on record. This replaces `without: ['mark']` (removed; `without` is `reply` only) and the null `passMark` on union's surfaces, which covered the run page and the seismograph and nothing else. `SurfaceOverview` carries the surface's own `passMark` when it names one, as `SurfaceInfo` does.
      - Codecast's words that reached union are now the product's. The cadence filter is a host slot, `EvalsHost.cadences` (`cadenceItems` in `wallModel.ts`); left out it is codecast's nightly and by hand, and union passes none, so no filter is drawn. A cadence baseline is counted in its own cadence: a nightly's in nights, as before, any other's in its batches ("vs 2 scenario batches", "the scenario baseline has no graded reps yet"). The dirty toggle and legend need `commits`. With `models` off the spend has no model and judge key and the verdict line does not call them missing. A crashed rep of a kind that answers nothing reads "A rep that finishes is held to this."
      - Codecast draws as before: it has every capability and names no cadences. Its seven mount tests pass against the new mirror, and the parity dump is identical (343 files) to the one taken before this pass.
- **E1 (eaiden):** `cd tools/xrun && bun install && bun run typecheck && bun run test && bun src/index.ts runs --help && bun src/index.ts runs matrix --help`. Accept: all green. No files change except `bun.lock` if the install rewrites it.
  - As built (2026-10-06, against `~/src/platform`'s working tree with P4a to P4e uncommitted): before the install, xrun's per-file symlink copy of `@platform/evals` lacked 17 entries (all of `react/` past P0's barrels, `client/models/timelineModel*`, `mountKit.ts`), as section 6 predicts. `bun install` (bun 1.3.14) refreshed all three `@platform` copies to match the live tree and left `bun.lock` byte-identical, so no file in eaiden changed. Typecheck exit 0, `bun run test` 4 pass and 0 fail, both `--help` smokes exit 0, and a read-only `runs matrix -n 20` drew its table through the refreshed package.

### Wave 7

- **U5 (union landing): cutover.**
  - Replace `app/admin/evals/page.tsx`, `[runId]/**`, `simulations/page.tsx` and `simulations/[id]/page.tsx` with the shared mount (the v2 mount becomes the canonical `/admin/evals`, and old URLs redirect).
  - Delete the `components/evals/*` and `components/admin/sim/*` files that nothing uses after it. Not all of `components/evals` goes: see "As built".
  - Accept: the U4 screenshot set at the canonical paths; type-check, lint, tests, all on union's ship set (below) laid over a clean origin/main; then deploy through union's normal path, in the ship order below. The deploy belongs to pl-810's ship phase, which the founder's go (2026-10-06) puts after this build passes its gate: it cannot run inside the build, because union's mirror must be re-vendored from a platform commit first (section 6), and platform is committed in that phase.
  - As built (in union's working tree, 2026-10-06; nothing committed or deployed). The unit as first written would have deleted three things the shared views do not draw, so it was narrowed to the rule "what the shared sources read moves, what they do not read stays":
    - The mount is `app/admin/evals/[[...path]]/page.tsx`, and `app/admin/simulations/[[...path]]/page.tsx` is the same component (`evals-shared/UnionEvalsRoute.tsx`). The `v2` route is gone from the U5 set; it never shipped, so it has no redirect. It returns for one landing push, beside the old pages (ship order 4a).
    - `evals-shared/addresses.ts` holds the base path and one pure mapping, `legacyAddress`, for every address from before the cutover; Slack digests, CLI output (`open /admin/evals/<run>`) and the Line's links still carry them. `/admin/simulations` opens the sims' surface and `/admin/simulations/<id>` the sim's run page. `/admin/evals/<run>/scenarios/<result>` opens that result's run page. `/admin/evals/<run>` and `/admin/evals/<run>/diff/<baseline>` need the run's rows (`GET /api/evals/rows?run=`), because a run covers several agents and a batch is read on one agent's surface: they open the run as a batch on the agent it failed most on, beside its baseline for a diff, and a `?scenario=` opens that result (by result id, or by the scenario id the Line's links carry, which the old page never resolved). A run with no rows in reach opens the wall. The redirect runs in the browser.
    - Kept as union's own page, in union's look, at `/admin/evals/suite`: the tier wallets and cost, the regression register, the case rates and the suite trend (`eval_suite_runs`). None of that is in `unionSources`, and the old page was the only place it showed. It is the old `page.tsx` without its runs table; `?view=tiers|cases` on the old address redirects to it and `?view=runs` opens the wall. The shared nav links to its three views through `EvalsHost.navSections`, and the page links back with "Runs".
    - An eval result's run page gains a Reproduction tab: union's `ScenarioDetailBody` (thread, critical inbound, regenerated and production reply, rubric, traces) through `useRunPanels`, as a sim gets its world. `evalRun` hands the result over as `scenario`, by intersection, so the tab reads nothing twice. Without it the cutover would have dropped "the web reproduction view" that the CLI and the agents link to.
    - Deleted: the old run, diff and scenario pages, the old sim pages, `components/evals/{JudgeScoreBar,RunStatusBadge,ScenarioDetailDrawer,VerdictMark,index}`, `components/admin/sim/{ChannelThreads,EventStream,PlainSimView,RunHeader,ScenarioView,ScorePanel,SimStatusChip,palette}`, and the types and helpers only they used. Kept in `components/evals`: `TierOverview`, `CaseRates`, `SuiteTrend` (the suite page), `ScenarioDetailBody` with its transcripts and `useReproduction` (the tab), and `types`.
    - Lost on purpose: the one-page summary of a run across all its agents (the wall and each agent's batch replace it), the per-channel thread view and the raw event stream of a sim (the Story tab merges them).
    - The admin nav's Simulations entry points at the sims' surface and is active on any sims address: the surface, or a sim's run page (`/admin/evals/r/simrun-…`). Its Evals entry is active on everything else under `/admin/evals`. One pure rule decides both, `isSimsAddress` in `addresses.ts`: a sim's id is `simrun-<yyyymmdd>-<slug>` (`simulations.id`), an eval result's a uuid. A freeze page is filed under Evals: a sim's freeze id is its scenario, which says nothing about sims.
    - **Union's ship set.** U5 does not land alone, and it cannot be landed as whole files. Union's main checkout carries other sessions' work in the same files: the Agreements nav entry and `/api/admin/agreements` prefix (pl-843), a signature font in `globals.css`, a `.next-ct57334` include in `tsconfig.json`, and unrelated `CLAUDE.md` sections. What lands is pl-810's hunks only, against origin/main:
      - U0: the `/api/simulations` lines of `backend/src/lib/routePermissions.ts` and its test.
      - U1: `backend/src/routes/evals.ts`, `backend/src/lib/eval/suite/queries.ts`, `tests/{unit,integration}/evalResultRows.test.ts`.
      - U2 to U4 leftovers: the refreshed `landing/vendor/platform/**`, `landing/package-lock.json`, `landing/bunfig.toml`, the `@source not` line of `globals.css`, `scripts/vendor-platform.sh`, and `CLAUDE.md`'s eval-views exception and vendored section.
      - U5: `evals-shared/**`, the three routes, the deletions, `components/admin/sim/{api,types}.ts`, `components/evals/{types,useReproduction,SwimlaneTranscript}.ts(x)`, the Evals and Simulations hunks of `lib/navigationConfig.tsx`, and the sims line of `docs/state/features/simulation-harness.md`.
      - Carried: `components/evals/TierOverview.tsx`'s `CostWarming`. Union session 54fb8ebe wrote it as one finished display fix across the old `page.tsx` and `TierOverview.tsx` (the cost panel waits while a fresh process computes the cost, instead of drawing "$0.00 a week"). U5 moved `page.tsx` to `suite/page.tsx` with that session's hunks intact, so both halves now ship together. Landing U5 without it breaks the build.
      - `~/src/union-mobile-wt/pl810-ship-tools/build.sh <worktree>` lays exactly this set from the main checkout over a worktree of origin/main: whole pl-810 files are copied, and mixed files keep only the hunks `pickhunks.py` matches. It is safe to rerun. The set's current worktree is `~/src/union-mobile-wt/pl810-ship-v2`, at origin/main `d36e6ca3cd`, uncommitted (review fixes laid, U6 included). `~/src/union-mobile-wt/pl810-ship` (at `bc97ee7958`) is stale: it predates U6, `promptFiles` and the review fixes, so nothing lands from it. No ship-set file changed on origin/main between the main checkout's base and `d36e6ca3cd`. At ship time, once platform is committed and union's mirror re-vendored from that commit (ship order step 1), run the script on a fresh worktree of the then origin/main, rerun the checks below there, and confirm `diff -rq` of its `evals-shared` and `vendor/platform` against the main checkout is empty.
      - The review fixes added to the set: `backend/src/lib/eval/suite/render.ts` (the CLI diff's words), the `evals diff` row of `backend/agent-skills/xrun/SKILL.md` and the "How to reach it" line of `docs/state/features/eval-suite-and-deploy-gate.md` (both hunk-picked: other sessions' hunks share those files), `components/admin/sim/{virtualTime.ts,storyItems.tsx}`, and the deletion of `StoryFeed.tsx`.
    - **Ship order.** The wall reads `GET /api/evals/rows` (U1), and the sims need `/api/simulations` gated (U0). Railway builds landing on every push to main, but the backend ships only through `./deploy.sh` (deploy.yml, with CI, the eval gate and the `/health` check). So:
      1. Commit platform, then re-vendor union's mirror from that commit (`PLATFORM_DIR` worktree, section 6).
      2. Land U6's migration alone and deploy it (U6, "Shipping"), then land U0, U1 and the rest of the backend on union main.
      3. Run `./deploy.sh --components backend` once CI is green on that sha. Check `/api/evals/rows` answers in production.
      4. Push the landing half in two steps, so the shared views meet production data beside the old pages before anything is deleted (section 0, "Union mounts on a parallel route first"):
         - 4a. The mount at `/admin/evals/v2/[[...path]]` (U4's route over `UnionEvalsRoute`, the sims' surface under it), the refreshed mirror and the adapter. No deletions, no redirects, no nav change: the old run, diff, scenario and sim pages stay live. In a real admin session on production, open the wall, an eval surface, a failed result with its Reproduction tab, the sims' surface, a gated sim and a running sim, and check what only production data can show: rows the fixtures never had, a run long enough to page, and the old addresses the Slack digests and the Line still carry.
         - 4b. Once 4a reads right: U5's canonical mount, the deletions, the `legacyAddress` redirects and the nav change, with `v2` removed (it is then a dead address nobody linked). If 4a reads wrong, the old pages are still serving and the fix lands at `v2` first.
         `build.sh` lays the whole U5 set today; 4a needs the set without U5's deletions, redirects and nav hunks, with U4's `v2` route restored.
      Pushing landing before step 3 leaves `/admin/evals` on the connection screen. Each commit carries `Requested-by: Ashot`.
    - **Codecast's half of the ship.** Codecast's mirror was vendored from frozen copies of uncommitted platform (C9, C10, U4 and the fix passes), and `daemon.ts` loads `@platform/evals/client`, `contract` and `analysis` files on every cast start (risk 1), so codecast lands only after platform is committed, and through section 0's boot-path gate:
      1. Commit platform (the same commit union's step 1 vendors from).
      2. Re-vendor codecast's mirror from that commit: `PLATFORM_DIR=<worktree at the commit> scripts/vendor-platform.sh vendor evals keys cli-kit`, then `--check` against the same `PLATFORM_DIR`.
      3. Restamp the daemon build id: `cd packages/cli && bun scripts/stamp-daemon-build-id.ts`. The closure holds files this convergence changed (`platform/packages/evals/src/client/*`, `contract/views.ts`, `analysis/*`, `shared/contracts/evalsApi/*`), so `--check` fails until then, and a release built on a stale stamp fails finalize, as the one dispatched on 5122a28a4 did for C8.
      4. `cast --version` from the checkout.
      5. Build the commit's tree in a clean worktree of origin/main with pl-810's files only, and run `scripts/vendor-platform.sh --write-manifest` then `--check-manifest` there. The shared checkout's `platform/vendor-manifest.txt` also carries other sessions' mirror state (a changed `agent` hash, and an `assistant` line for the untracked `platform/packages/assistant` that the hosted-assistant work adopts through its own dep lines). Committing that file as it stands, without those mirrors, fails CI's `test-platform` job; committing it with them ships another session's work. Of the manifest's lines only `evals` and `keys` are pl-810's (`cli-kit` is unchanged).
      6. `gh workflow run cut-cli-release.yml -R codecast-sh/codecast -f dry_run=true` on that commit, and land the codecast commits only once it passes.
    - Checks on the ship set over origin/main `bc97ee7958` (`~/src/union-mobile-wt/pl810-ship`, outreach's `bun install`):
      - CI typecheck: landing 0, backend 0.
      - Lint: 0 errors and 328 warnings (cap 345), none in pl-810 files.
      - Landing `bun run test`: 143 files, 1296 pass.
      - Backend: `routePermissions` and `evalResultRows` unit, 211 pass. The `evalResultRows` integration test passes 5 on a throwaway loopback database. `bun run test` passes 6111 and fails 3, all in `llmProviderChainOrder.test.ts`: its Bedrock leg needs the AWS credentials that CI's test job carries and the local placeholder env blanks. No ship-set file touches that code.
      - Railway-equivalent copy: npm 10 `npm ci`, then `next build` 0 with `/admin/evals/[[...path]]`, `/admin/evals/suite` and `/admin/simulations/[[...path]]`. No `node_modules` under `vendor/`, and only `commander` nested under `@platform/evals`.
      - Browser, that production build against the synthetic stub: the wall, an eval surface, the sims' surface, a failed result with its Reproduction tab, a gated sim, a running sim ("stalled?"), every old address landing where `legacyAddress` says, and the suite page's views with its cost panel. A sim's run page lights Simulations, and a result's lights Evals. Union has no `pair` source, so `/admin/evals/compare` reads "Not shown here"; the batch compare on a surface is how union compares.
- **C11 (codecast/web), recommended:** make the fixture world go through `localTransport(createEvalsHandler(fixtureSources))`, so dev fixtures run the production verdict code. Files: `lib/evals/fixtureTransport.ts` and `components/evals/__fixtures__/**`. Accept: mount tests; review the fixture screenshot diffs (expected where hand-built responses diverged).
  - As built (2026-10-06): the world holds records, not answers. `world/sources.ts` hands its rows, surfaces, freezes, prompt files, run folders, git, bisects and sim to `createEvalsHandler` exactly as `api/sources.ts` hands over codecast's homes (`satisfies EvalsSources<RunRow, SurfaceDef, SimFailureMoved>`), under codecast's pass rule (`statusPassRule` at 0.7, the row's ruler). `world.ts` answers codecast's own routes first and the rest through the handler, as `api/handlers.ts` does; `world.handle` is the bridge handler and `world.answer` goes through `localTransport`, so it is async and a non-200 throws the client's `EvalsRequestError`. `fixtureTransport.ts` is `localTransport(world.handle, "fixture")`. The hand-built verdict, flips, epochs, ledger, footing, attribution and bisect plan are gone (`world/attribution.ts` deleted); in their place `world/git.ts` (a commit line, the files each commit touched, and the `AttributionGit`/`AttributionMeta` reads) and `world/bisects.ts` (the engine's `attribute` and `planFrom`, and the six bisects started on pairs that fit their case). The test files moved with the fixture helpers, which are now async; that is beyond the unit's listed files.
  - Spec against the code: the handler weighs the wall (its 30-day window, a batch still landing) against `Date.now()`, so a world built at a fixed past instant no longer draws a full wall. The wall and foundation tests build their world on today's clock (`fixtureWorldNow()`, the transport's own default). Keys going dead in a later test file was not the clock: `@platform/keys` bound its capture listener to the window that existed when the module first loaded, and each mount test brings its own jsdom window, so every file after the first to load it got no shortcuts (fixed in the C10 fix pass). "Title is landing" is a record now (one unscored rep minutes old), not a flag. Which batches ran on edits is keyed by a batch's place in its surface's history, not its name, so every story holds on every day (the old world dropped the range bisect at some hours).
  - Screenshot review (fixture transport, before and after on one dev server): run and freeze pages are unchanged but for which batches are dirty. Expected divergences where the hand-built answers differed from production: a nightly batch is weighed against 7 nights, not 3; flips on an unchanged prompt read "flips on noise"; small pooled sets separate night by night instead of "too few reps"; the settle regression breaks three freezes and its free answer pins the commit, which `b-settle-0927` names as its culprit; the wall orders worse rows first, then calls.
- **U6 (union backend and landing, platform): provenance columns.** Founder decision sd-409 (section 9.1), taken after U5.
  - Files (union, in `~/src/union-mobile-wt/pl810-u6`, a worktree of origin/main with the ship set laid by `build.sh`): `backend/src/db/schema/{evalRuns,simulations}.ts`, migration `backend/drizzle/20261006150802_rare_katie_power.sql` with its snapshot and journal entry, new `backend/src/lib/eval/{provenance,skipped}.ts`, `backend/src/lib/eval/{recorder,judge,draws}.ts`, `backend/src/lib/sim/{clone,inboundOnboarding,score}.ts`, `backend/src/lib/eval/suite/queries.ts` (`listEvalResultRows`), `backend/src/routes/simulations.ts` (`GET /db`), new `backend/scripts/backfill-eval-prompt-sha.ts`, tests `backend/tests/{unit,integration}/evalProvenance.test.ts`; in the main checkout, `landing/src/components/admin/evals-shared/{mapRows,mapSim,policy,unionSources}.ts`, `mapRows.test.ts` and its re-recorded `__fixtures__`, `landing/src/components/admin/sim/types.ts`, and the mirror. Platform: `contract/views.ts`, `query/sources.ts`, `react/hooks.ts`, `react/freeze/{ComparePanel,CompareView,EpochDiffSheet,FreezeView}.tsx` and their tests.
  - Accept: union typecheck, tests and build green; the migration applies and rolls forward cleanly on a local database; the backfill is idempotent; the shared views show footing for union rows that carry the columns. Local and ephemeral databases only: no production database, no migration against production, no deploy.
  - As built (2026-10-06, in the working trees; nothing committed or deployed):
    - Columns, all nullable with no default, so the ALTERs touch no rows: `eval_runs.model`, `judge_model`, `dirty`; `eval_scenario_results.prompt_sha`; `simulations.git_sha`, `judge_model`. The migration is drizzle-kit's own (six `ADD COLUMN`s) with a header comment, chained on origin/main's latest snapshot.
    - What a run records (`lib/eval/provenance.ts`, one home for each rule). `model` is `AGENT_MODEL_OVERRIDE` when a run pins one on every agent (the A/B arm `agentRunner` and `freeze/replay.ts` already use), else `agent-default`: each agent answered on its own configured model, lane pins included, which `git_sha` fixes. A run-level column cannot name one model, because each agent has its own. `judge_model` is the rubric judge's (`RUBRIC_JUDGE_MODEL`, which `judge.ts` now reads from the same constant), or a caller's `judgeModel`. `dirty` is whether the checkout's tracked files had uncommitted edits; a run handed an explicit `gitSha` (a deployed build's `GIT_SHA`) is clean; unknown is null. A sim records `git_sha` when it is created (`GIT_SHA`, else the checkout's head) and `judge_model` when it is scored (`ScoreJudge.model`; the default judge's `SCORE_JUDGE_MODEL`).
    - `prompt_sha` is sha256 hex of `system_prompt` as stored, computed by Postgres (`encode(sha256(convert_to(…, 'UTF8')), 'hex')`) in one SQL fragment both the recorder and the backfill use, so the two cannot disagree (a UTF-8 prompt hashes the same as Node's `createHash`, tested). A draw that sent no prompt gets null: no output, or a skip sentinel. Without that a skipped scenario would read as a prompt change, a new epoch. The skip prefixes moved to a leaf (`lib/eval/skipped.ts`) that the judge, the draw verdicts and the provenance writer share; the judge's `isSkippedOutput` had its own copy.
    - The backfill is a script, not part of the migration: `scripts/backfill-eval-prompt-sha.ts` (dry run by default, `--execute`, `--batch n`). The table holds every draw ever recorded, each with up to 200 KB of prompt, and the migration runs in one transaction under a 5 minute statement timeout, holding the table's lock. The script hashes in batches of 500, one statement each, touches only rows whose `prompt_sha` is null and whose prompt was sent, so a rerun or a run cut off halfway picks up where the last stopped, then `ANALYZE`s.
    - Routes: `GET /api/evals/rows` adds `model`, `judgeModel`, `dirty` and `promptSha`; `GET /api/simulations/db` adds `gitSha` and `judgeModel`. The adapter treats each as optional, so a landing that ships before the backend draws as before.
    - Adapter: rows carry the provenance; `policy.ruler` reads the judge's model; `unionSources` turns `models` on and hands `PROMPTS_BY_HASH`. Union stores one system prompt per result and serves it on that result's page only, and `PromptReader` is synchronous, so the views cannot fetch texts to diff. That needed a platform capability, `promptFiles` (`EvalsSources.promptFiles: false`): with it off the epoch sheet names the freezes whose prompt changed and says the change is kept by hash, `ComparePanel`'s "What the model saw" and `CompareView`'s "Both prompts" are not drawn, a freeze's prompt-change note says so, and the sheet's commit list needs `commits`. Codecast has every capability, so it draws as before.
    - Spec against the code: `unfooted` only fires when every graded rep has model and judge null, so it stops firing once new rows land. A footing is model and ruler; at the cutover the newest pre-U6 batches (ruler null) differ from the first post-U6 batches (ruler `claude-sonnet-5-5`), so the first U6 batches are weighed against no pre-U6 batch until new baselines build. At about 30 suite runs a day (lib/eval/memo.ts's own count) that closes within a day for the busy selections, and after a week of nights for the nightly baseline. Backfilling `judge_model` on old runs would close it at once, but which judge graded an old run is not on record, so it is not done.
    - Shipping: the backend half rides as `~/src/union-mobile-wt/pl810-ship-tools/u6.patch` (written by `u6-export.sh` from the worktree), which `build.sh` now applies after the U0 to U5 set, resetting U6's files first so a rerun is clean. It is not in the main checkout on purpose: that checkout is 33 commits behind origin/main with four other sessions' uncommitted migrations, so a migration generated there would fork the snapshot chain, and its local dev reads production, where an insert naming the new columns fails until the deploy (drizzle lists every column on insert). Ship order, inside pl-810's ship phase (review fix): the migration lands and deploys alone first. Code with U6's schema cannot reach origin/main before production has the columns: union sessions rebase onto origin/main and their local dev and eval runs read production, where `startRun`'s insert (and any drizzle insert, which names every column) fails until the migration runs, and merging does not deploy (deploy.yml), so that window would last until someone ran a deploy. So: (a) commit only `drizzle/20261006150802_rare_katie_power.sql`, its snapshot and the journal entry, push, run `./deploy.sh --components backend`, and check the six columns exist; old code ignores nullable columns it does not name. (b) Land the rest of U6 with U0, U1 and the backend review fixes, and deploy the backend again. (c) Run `bun run scripts/backfill-eval-prompt-sha.ts` (dry run), then `--execute`, against production. (d) Push landing. None of U6's files is in `GATE_SCOPE`, so a U6-only deploy's eval gate plans `clean`; if the gate does run new code against the database before the release command, its inserts fail as SCHEMA_DRIFT (non-blocking).
    - Checks: the migration applied once to a database bootstrapped at origin/main's schema (`bootstrap-instance.ts`, ephemeral Postgres 17 on 127.0.0.1:5466), a second `db:migrate` applied nothing, and the migrated tables match a fresh bootstrap of the U6 schema column for column. With 1,200 old-shaped rows seeded before migrating: dry run 981, `--execute --batch 250` filled 981 in four batches, every hash equal to Postgres's own, 219 skipped or empty rows left null, a rerun filled 0. Integration tests (recorder, backfill, both routes) pass on both databases; backend typecheck 0, full unit suite 7,049 shared and 6,115 isolated pass, 0 fail; landing typecheck 0, lint 0 errors and 328 warnings, 1,300 tests pass (the adapter's 38 among them, over fixtures re-recorded through the U6 routes); npm 10 `npm ci` and `next build` 0 with the three routes. Platform evals typecheck 0 and 270 tests pass. Codecast: the seven mount tests and the drift test pass, `cast check` web, evals and cli green, and the parity dump is identical (368 files).
    - Browser, a production build of the ship set against a synthetic stub (fixtures plus an older run on an A/B arm): the wall's What moved names the prompt epoch and the model moving from `gpt-5.6-luna` to `agent-default`; the broker-email surface draws epochs e1 and e2, a model filter, the footing marker and "1 flip on the same footing", and weighs run 3 against runs 1 and 2 only; the e2 sheet names the changed freeze and says the change is kept by hash; a result's page shows `agent-default` and `claude-sonnet-5-5`; a sim shows its judge and commit (and "no model", since a sim records none).
- **Union review fixes (2026-10-06, after U6; working trees only, nothing committed or deployed).**
  - Platform (`~/src/platform`, vendored into both mirrors from a frozen copy of the tree, `/tmp/pf-uf`, taken after a three-minute quiet window in another session's edits): `query/kept.ts` (`keptRead`, `stableRows`) and its test; `EvalsSources.runRows` (`GET /run/:id` looks up a rep the rows did not reach, with its batch) and `EvalsSources.historyFrom` (`/health.historyFrom`, drawn by the nav as "from 3d ago" beside the run count); the default `useNavigate` returns one stable function. Codecast hands neither source, so its answers do not move: the parity dump over a fresh pin is identical (368 files), the seven mount tests and the drift test pass, `cast check` evals, web and cli are green, and `cast --version` boots.
  - Union backend: `/rows?result=` and single-run lookups at any age; `/db?id=` (in `u6.patch`); the CLI diff's words (section 1, item 4). Union landing: section 5's reads, lookups, sim problems, the Story on `Timeline`, the default location hooks; dead `useSimTimeline` and `TimelineResponse` gone.
  - Checks on the ship set over origin/main `d36e6ca3cd` (`~/src/union-mobile-wt/pl810-ship-v2`): CI typecheck backend 0 and landing 0; lint 0 errors, 327 warnings (cap 345); landing `bun run test` 144 files, 1,311 pass; backend `bun run test` 7,050 shared and 6,115 isolated pass, 0 fail; the `evalResultRows` and `evalProvenance` integration tests 12 pass on a throwaway loopback database (dropped after); npm 10 `npm ci` and `npm run build` green with the three routes, `@platform/*` installed as copies, nothing under `vendor/node_modules`. The browser pass did not run: the cast browser session was shared with a sibling agent driving codecast pages, so the union pages were checked through the adapter tests (46) and `storyItems.test.ts` instead.
- **E2 (eaiden), optional:** `xrun runs ui` as in section 5. Accept: a screenshot of the page served on 127.0.0.1 under React 18.

## 8. Risks

1. **Cast boot path.** `daemon.ts:322` → `evalsServer.ts:12` and `orgRoleOps.ts:8` → `lineProfileCommand.ts:12` load the contract and evalResult on every cast start. A runtime import before the vendor commit and dep lines breaks every cast command. C8 handles this with ordered commits, a boot smoke test and a release dry run.
2. **Silent verdict change.** Mitigations: the policy is codecast's own `repPassed`, moved verbatim; status stays without `running`; `unfooted` only fires when every graded rep lacks model and judge. Parity diffs gate every analysis move.
3. **Pixel drift from the Tailwind and token conversion.** About 1,206 classNames change. Only screenshots catch this. The className guard catches leftover utilities, which would render in neither host.
4. **Theme override.** Never declare `--sol-*` on `.ev-area`. Only `--ev-*` gets declared, in `:where()`. The drift test pins the fallbacks.
5. **Duplicate React or package copies.** Union: the mirror lives inside `landing/` and is rsynced without `node_modules`, and `landing/.npmrc`'s `install-links` keeps npm from installing the packages' devDependencies (their own React) at build time; local bun installs still do (section 6). Codecast: Vite dedupes react. Bun's per-peer-set copies are harmless because nothing holds a singleton.
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

The look itself is already decided: union admin uses codecast's look, and U2 records it in union's CLAUDE.md. Of the two below, the first is decided:

1. **Union provenance columns.** These are nullable prod Postgres columns:
   - `eval_runs`: `model`, `judge_model`, `dirty`
   - `eval_scenario_results`: `prompt_sha`, backfilled from the stored `system_prompt`
   - `simulations`: `git_sha`, `judge_model`

   Decided (sd-409, 2026-10-06): yes, after the union views land. Built as U6 (section 7): `prompt_sha` is filled by a batched script rather than in the migration, and `eval_runs.model` names the run's pinned model or `agent-default`, since each agent has its own.
2. **Pass mark for union sims.** Sims have no pass mark today.

   Default: none. Sims show scores, separation and trends but no pass/fail majority. Set one if sims should get pass/fail verdicts.