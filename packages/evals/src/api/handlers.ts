import { rmSync } from 'node:fs';

import { matchEvalsRoute, searchRows, type BisectPlan, type BisectPlanRequest, type BisectStartRequest, type EvalsBridgeRequest, type EvalsBridgeResponse, type EvalsRouteKey, type EvalsRoutes } from '@codecast/shared/contracts/evalsApi';
import type { EvalsViewRouteKey } from '@platform/evals/contract';
import { answer, BadRequest, createEvalsHandler, endpointRef, isViewRoute, need, NotFound, posInt, posNum, ranFreezes, rowById, type AnyRouteHandler, type RouteHandler } from '@platform/evals/query';

import { REPO_ROOT, writeJsonAtomic } from '../paths';
import { surfaceMeta } from '../registry';
import { planFrom } from '../bisect/plan';
import { startRefusal } from '../bisect/runner';
import { bisectPaths, newBisectId, writePendingState } from '../bisect/state';
import { bisectPlanArgs, bisectStartArgs, launchPath, runningBisect, stopBisect } from './bisects';
import { OutsideRunFolder, runFile } from './files';
import { BadSha, patchDetail } from './git';
import { simCatalog, simJobs, simRun, simSessionSummaries, SimRequestError, startShrink, startSweep } from './simHistory';
import { codecastPolicy, codecastSources, rows } from './sources';
import { evalsTool, hasTmux, launch, runTool } from './spawn';

// The api child's dispatch (evals-ui.md section 3.4): the routes every
// product shares are answered by @platform/evals/query over codecast's sources
// (sources.ts); the ones only codecast has (run files, kept patches, search,
// starting and stopping bisects, the sim) are answered here first. Both read
// the contract's one route table through matchEvalsRoute, so the daemon's
// bridge, this child and the web fixture transport agree. Every input is
// checked: names must exist in the index or the registry, a sha must be one,
// and no client value is ever a filesystem path or reaches a shell. Errors
// come back as an EvalsErrorBody with a status.

/** A bisect request as the CLI will get it: a known surface, real endpoints, freezes the surface ran, bounded numbers. */
async function bisectRequest(body: unknown): Promise<BisectStartRequest> {
  if (!body || typeof body !== 'object') throw new BadRequest('a bisect takes a JSON body');
  const b = body as Partial<BisectStartRequest>;
  if (typeof b.surface !== 'string' || !surfaceMeta(b.surface)) throw new BadRequest(`no surface ${String(b.surface)}`);
  const all = await rows();
  if (b.freezes !== undefined && !Array.isArray(b.freezes)) throw new BadRequest('freezes are a list of freeze ids');
  const freezes = ranFreezes(all, b.surface, b.freezes ?? []);
  return {
    surface: b.surface,
    good: endpointRef(all, b.surface, b.good, 'good', codecastSources.git.verify),
    bad: endpointRef(all, b.surface, b.bad, 'bad', codecastSources.git.verify),
    freezes,
    reps: posInt(b.reps, 'reps', 7),
    budgetUsd: posNum(b.budgetUsd, 'budgetUsd'),
    maxMinutes: posInt(b.maxMinutes, 'maxMinutes', 24 * 60),
    allCommits: b.allCommits === true,
    confirm: b.confirm === true,
  };
}

// ── Codecast's own routes ──────────────────────────────────────────────────

type OwnRouteKey = Exclude<EvalsRouteKey, EvalsViewRouteKey>;

const OWN: { [K in OwnRouteKey]: RouteHandler<EvalsRoutes, K> } = {
  'GET /run/:id/file': async ({ params, query }) => {
    rowById(await rows(), params.id);
    try {
      return runFile(params.id, need(query, 'path'));
    } catch (e) {
      if (e instanceof OutsideRunFolder) throw new NotFound(e.message);
      throw e;
    }
  },
  'GET /patch/:sha': ({ params }) => {
    const p = patchDetail(params.sha);
    if (!p) throw new NotFound(`no patch ${params.sha.slice(0, 12)} is kept under EVALS_HOME/trees`);
    return p;
  },
  'GET /search': async ({ query }) => searchRows(await rows(), query.q ?? ''),
  'POST /bisect/plan': async ({ body }) => {
    const req: BisectPlanRequest = await bisectRequest(body);
    const out = await runTool(bisectPlanArgs(req));
    try {
      return JSON.parse(out) as BisectPlan;
    } catch {
      throw new Error(`./evals bisect plan printed no JSON plan: ${out.slice(0, 200)}`);
    }
  },
  'POST /bisect': async ({ body }) => {
    const req = await bisectRequest(body);
    if (surfaceMeta(req.surface)!.route === 'agent' && !req.confirm) throw new BadRequest(`${req.surface} is an agent surface: confirm the spend to start it`);
    const holder = runningBisect();
    if (holder) throw new BadRequest(`bisect ${holder} is running; one runs at a time`);
    // The free plan, as the runner will first make it: a refusal reaches the page here, and the
    // placeholder state the page opens on carries it while the runner loads the records.
    const plan = planFrom(req, { rows: await rows() });
    const refused = startRefusal(plan, req.confirm);
    if (refused) throw new BadRequest(refused);
    const id = newBisectId(req.surface);
    const paths = bisectPaths(id);
    const session = `evals-bisect-${id}`;
    writePendingState(id, plan, hasTmux() ? session : null);
    try {
      const launched = launch(session, [...evalsTool(), ...bisectStartArgs(req, id)], { cwd: REPO_ROOT, log: paths.job });
      writeJsonAtomic(launchPath(id), launched);
      return { id, tmux: launched.tmux };
    } catch (e) {
      rmSync(paths.dir, { recursive: true, force: true });
      throw e;
    }
  },
  'POST /bisect/:id/stop': ({ params }) => {
    const s = stopBisect(params.id);
    if (!s) throw new NotFound(`no bisect ${params.id}`);
    return s;
  },
  'GET /sim/catalog': () => simCatalog(),
  'GET /sim/sessions': () => ({ sessions: simSessionSummaries(), lastSweep: simJobs().find((j) => j.kind === 'sweep') ?? null }),
  'GET /sim/run/:session/:run': async ({ params }) => {
    const r = await simRun(params.session, params.run);
    if (!r) throw new NotFound(`no sim run ${params.run} in session ${params.session}`);
    return r;
  },
  'POST /sim/shrink': async ({ body }) => {
    const b = (body ?? {}) as { session?: unknown; run?: unknown };
    if (typeof b.session !== 'string' || typeof b.run !== 'string') throw new BadRequest('a shrink names a session and a run');
    return { job: (await startShrink(b.session, b.run)).id };
  },
  'POST /sim/sweep': async ({ body }) => {
    const b = (body ?? {}) as { filter?: unknown; seeds?: unknown };
    if (b.filter !== undefined && typeof b.filter !== 'string') throw new BadRequest('filter is a scenario name');
    return { job: (await startSweep((b.filter as string | undefined) || undefined, Number(b.seeds))).id };
  },
};

/** The shared routes, over codecast's sources and verdict. */
const shared = createEvalsHandler(codecastSources, codecastPolicy);

/** Codecast's request errors beyond the shared NotFound and BadRequest. */
const ownBadRequest = (e: unknown): boolean => e instanceof BadSha || e instanceof SimRequestError;

/** One bridge request answered: the route's value with 200, or an error body with its status. Never throws. */
export async function handleRequest(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse> {
  const route = matchEvalsRoute(req.method, req.path);
  if (!route || isViewRoute(route.key)) return shared(req);
  return answer(req, route, OWN[route.key] as AnyRouteHandler, ownBadRequest);
}
