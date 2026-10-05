import { rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';

import {
  EVALS_BATCH_TOKEN_RE,
  EVALS_SHA_RE,
  matchEvalsRoute,
  resolveEvalsBatchRef,
  searchRows,
  type BisectPlan,
  type BisectPlanRequest,
  type BisectStartRequest,
  type ChangesResponse,
  type EvalsBridgeRequest,
  type EvalsBridgeResponse,
  type EvalsErrorBody,
  type EvalsResponse,
  type EvalsRouteKey,
  type EvalsRoutes,
  type HealthResponse,
  type RunRow,
} from '@codecast/shared/contracts/evalsApi';

import { indexedRuns, indexProgress, refreshRunIndex, runIndexPath } from '../history/runIndex';
import { evalsHome, REPO_ROOT, writeJsonAtomic } from '../paths';
import { surfaceMeta } from '../registry';
import { gitHead } from '../state';
import { planFrom } from '../bisect/plan';
import { startRefusal } from '../bisect/runner';
import { bisectPaths, listBisects, newBisectId, writePendingState } from '../bisect/state';
import { bisectPlanArgs, bisectStartArgs, launchPath, readBisect, runningBisect, settlePendingBisects, stopBisect } from './bisects';
import { OutsideRunFolder, runFile } from './files';
import { BadSha, commitDetail, patchDetail, verifiedSha } from './git';
import { simCatalog, simJobs, simRun, simSessionSummaries, SimRequestError, startShrink, startSweep } from './simHistory';
import { evalsTool, hasTmux, launch, runTool } from './spawn';
import { attributionView, BadRequest, batchesView, compareView, epochView, freezeView, NotFound, overview, rowById, runView, stalenessWords, surfaceView } from './views';

// The api child's dispatch (evals-ui.md section 3.4): one handler per route
// of the contract's EvalsRoutes, chosen by matchEvalsRoute, so the daemon's
// bridge, this child and the web fixture transport read one table. Every
// input is checked here: names must exist in the index or the registry, a
// sha must be one, and no client value is ever a filesystem path or reaches
// a shell. Errors come back as an EvalsErrorBody with a status.

type Args<K extends EvalsRouteKey> = { params: EvalsRoutes[K]['params'] extends Record<string, never> ? Record<string, string> : EvalsRoutes[K]['params']; query: Record<string, string>; body: unknown };
type Handler<K extends EvalsRouteKey> = (a: Args<K>) => Promise<EvalsResponse<K>> | EvalsResponse<K>;

const startedAt = new Date().toISOString();
let refreshed = false;
let current: { version: string; rows: RunRow[] } | null = null;

/**
 * The index, at most 2 s old: one readdir and parallel stats when nothing
 * moved. The same array comes back until the index changes, so the analysis
 * views can memoize on it (views.ts overviewCore). Any refresh that changes
 * the index rewrites runs.jsonl, including the per-surface ones flipExamples
 * runs, so the file's mtime and size are its version. Requests that arrive
 * together (a page and its /changes poller) join the one load in flight:
 * refreshRunIndex runs a sweep per caller once the index is past its age.
 */
let loading: Promise<RunRow[]> | null = null;
const rows = (): Promise<RunRow[]> => (loading ??= loadRows().finally(() => (loading = null)));

async function loadRows(): Promise<RunRow[]> {
  await refreshRunIndex({ maxAgeMs: 2000 });
  refreshed = true;
  const st = await stat(runIndexPath()).catch(() => null);
  const version = st ? `${st.mtimeMs}:${st.size}` : 'none';
  if (current?.version !== version) current = { version, rows: await indexedRuns({ maxAgeMs: Number.MAX_SAFE_INTEGER }) };
  return current.rows;
}

const need = (q: Record<string, string>, k: string): string => {
  const v = q[k];
  if (!v) throw new BadRequest(`${k} is required`);
  return v;
};
const flag = (v: string | undefined): boolean => v === '1' || v === 'true';
const posInt = (v: unknown, what: string, max = 100): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequest(`${what} takes a whole number from 1 to ${max}`);
  return n;
};
const posNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${what} takes a positive number`);
  return n;
};

/** A batch of the surface (by name or by its address hash) or a commit in this repo (EVALS_SHA_RE, then `git rev-parse --verify <sha>^{commit}`): what a bisect endpoint may be. */
function endpointRef(all: RunRow[], surface: string, ref: unknown, what: string): string {
  if (typeof ref !== 'string' || !ref) throw new BadRequest(`${what} is required`);
  if (all.some((r) => r.surface === surface && r.batch === ref)) return ref;
  // A page address names a labelled batch by its hash (evalsBatchRef); the batch is the one that hashes to it.
  if (EVALS_BATCH_TOKEN_RE.test(ref)) {
    const named = resolveEvalsBatchRef(ref, new Set(all.flatMap((r) => (r.surface === surface && r.batch ? [r.batch] : []))));
    if (!named) throw new BadRequest(`${what} ${ref} names no ${surface} batch`);
    return named;
  }
  if (!EVALS_SHA_RE.test(ref)) throw new BadRequest(`${what} ${ref} is neither a ${surface} batch nor a sha`);
  verifiedSha(ref);
  return ref;
}

/**
 * Freezes a request names, as ids or id prefixes of 8 or more characters,
 * each one the surface has run: the plan, the bisect and the free answer take
 * the same refs, so the launcher's two asks cannot read different freezes.
 */
function ranFreezes(all: RunRow[], surface: string, refs: unknown[]): string[] {
  if (refs.some((f) => typeof f !== 'string' || !/^[0-9a-f-]{8,36}$/.test(f))) throw new BadRequest('freezes are freeze ids, or id prefixes of 8 or more characters');
  const ran = new Set(all.filter((r) => r.surface === surface).map((r) => r.freezeId));
  const unknown = (refs as string[]).filter((f) => ![...ran].some((id) => id.startsWith(f)));
  if (unknown.length) throw new BadRequest(`${surface} never ran freeze ${unknown.join(', ')}`);
  return refs as string[];
}

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
    good: endpointRef(all, b.surface, b.good, 'good'),
    bad: endpointRef(all, b.surface, b.bad, 'bad'),
    freezes,
    reps: posInt(b.reps, 'reps', 7),
    budgetUsd: posNum(b.budgetUsd, 'budgetUsd'),
    maxMinutes: posInt(b.maxMinutes, 'maxMinutes', 24 * 60),
    allCommits: b.allCommits === true,
    confirm: b.confirm === true,
  };
}

// ── /changes ───────────────────────────────────────────────────────────────

/** When each row last changed, as this child saw it: rows present at the first look count as old (0). */
const seen = new Map<string, { sig: string; at: number }>();
let primed = false;
const sigOf = (r: RunRow): string => `${r.status}|${r.score}|${r.scoreVersions}|${r.gatesFailed.join(',')}|${r.costUsd}|${r.judgeCostUsd}`;

/**
 * Everything that moved since a cursor (a time in ms the last answer gave):
 * reps that landed or were rescored, bisects whose state moved, and sim
 * jobs. A cursor from before this child started is fine: rows it never saw
 * change count as old, so a restart does not replay the whole index.
 */
async function changes(since: number): Promise<ChangesResponse> {
  const now = Date.now();
  const all = await rows();
  for (const r of all) {
    const sig = sigOf(r);
    const hit = seen.get(r.id);
    if (!hit) seen.set(r.id, { sig, at: primed ? now : 0 });
    else if (hit.sig !== sig) seen.set(r.id, { sig, at: now });
  }
  primed = true;
  return {
    cursor: now,
    runs: all.filter((r) => (seen.get(r.id)?.at ?? 0) > since),
    bisects: (settlePendingBisects(), listBisects()).filter((b) => Date.parse(b.updatedAt) > since),
    jobs: simJobs().filter((j) => Date.parse(j.updatedAt) > since),
  };
}

// ── The table ──────────────────────────────────────────────────────────────

const HANDLERS: { [K in EvalsRouteKey]: Handler<K> } = {
  'GET /health': (): HealthResponse => {
    const p = indexProgress();
    // The first build can take minutes on a cold home: start it, never wait for it here.
    if (!refreshed && p.phase === 'idle') void rows().catch(() => null);
    const head = gitHead(REPO_ROOT);
    return {
      root: REPO_ROOT,
      evalsHome: evalsHome(),
      gitHead: head === 'unknown' ? null : head,
      runsIndexed: p.rows,
      index: { state: p.phase !== 'idle' ? (refreshed ? 'warm' : 'building') : refreshed ? 'warm' : 'cold', done: p.done, total: p.total || null },
      pid: process.pid,
      startedAt,
    };
  },
  'GET /overview': async ({ query }) => {
    // Staleness reads git in a worker while the index loads.
    const words = stalenessWords();
    return overview(await rows(), query.cadence || 'all', words);
  },
  'GET /surface/:id': async ({ params, query }) => surfaceView(await rows(), params.id, { from: query.from, to: query.to, model: query.model, cadence: query.cadence, dry: flag(query.dry), bisect: flag(query.bisect) }),
  'GET /freeze/:id': async ({ params }) => {
    if (!/^[0-9a-f-]{4,36}$/.test(params.id)) throw new BadRequest('a freeze id is hex with dashes');
    return freezeView(await rows(), params.id);
  },
  'GET /run/:id': async ({ params }) => runView(await rows(), params.id),
  'GET /run/:id/file': async ({ params, query }) => {
    rowById(await rows(), params.id);
    try {
      return runFile(params.id, need(query, 'path'));
    } catch (e) {
      if (e instanceof OutsideRunFolder) throw new NotFound(e.message);
      throw e;
    }
  },
  'GET /compare': async ({ query }) => compareView(await rows(), need(query, 'a'), need(query, 'b')),
  'GET /batches': async ({ query }) => batchesView(await rows(), need(query, 'surface'), need(query, 'a'), need(query, 'b')),
  'GET /epoch': async ({ query }) => {
    const n = posInt(need(query, 'n'), 'n', 10_000)!;
    return epochView(await rows(), need(query, 'surface'), n);
  },
  'GET /attribution': async ({ query }) => {
    const surface = need(query, 'surface');
    const all = await rows();
    const ref = (k: 'good' | 'bad') => (query[k] ? endpointRef(all, surface, query[k], k) : undefined);
    const freeze = query.freeze ? ranFreezes(all, surface, [query.freeze])[0] : undefined;
    return attributionView(all, surface, ref('good'), ref('bad'), flag(query.allCommits), freeze);
  },
  'GET /commit/:sha': ({ params, query }) => {
    if (query.surface && !surfaceMeta(query.surface)) throw new NotFound(`no surface ${query.surface}`);
    return commitDetail(params.sha, query.surface || null, flag(query.whole));
  },
  'GET /patch/:sha': ({ params }) => {
    const p = patchDetail(params.sha);
    if (!p) throw new NotFound(`no patch ${params.sha.slice(0, 12)} is kept under EVALS_HOME/trees`);
    return p;
  },
  'GET /changes': ({ query }) => changes(Number(query.since) || 0),
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
  'GET /bisects': () => {
    settlePendingBisects();
    return { bisects: listBisects(), running: runningBisect() };
  },
  'GET /bisect/:id': ({ params, query }) => {
    const b = readBisect(params.id, Number(query.since) || 0);
    if (!b) throw new NotFound(`no bisect ${params.id}`);
    return b;
  },
  'POST /bisect/:id/stop': ({ params }) => {
    const s = stopBisect(params.id);
    if (!s) throw new NotFound(`no bisect ${params.id}`);
    return s;
  },
  'GET /sim/catalog': () => simCatalog(),
  'GET /sim/sessions': () => ({ sessions: simSessionSummaries() }),
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

const errorBody = (status: number, error: string, reason?: EvalsErrorBody['reason']): { status: number; body: EvalsErrorBody } => ({ status, body: { error, ...(reason ? { reason } : {}) } });

/** One bridge request answered: the route's value with 200, or an error body with its status. Never throws. */
export async function handleRequest(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse> {
  const route = matchEvalsRoute(req.method, req.path);
  const answer = (r: { status: number; body: unknown }): EvalsBridgeResponse => ({ id: req.id, ...r });
  if (!route) return answer(errorBody(404, `no route ${req.method} ${req.path}`, 'not-found'));
  try {
    // matchEvalsRoute decoded exactly the params this key's pattern names.
    const handler = HANDLERS[route.key] as unknown as (a: { params: Record<string, string>; query: Record<string, string>; body: unknown }) => unknown;
    const body = await handler({ params: route.params, query: req.query ?? {}, body: req.body });
    return answer({ status: 200, body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof NotFound) return answer(errorBody(404, msg, 'not-found'));
    if (e instanceof BadRequest || e instanceof BadSha || e instanceof SimRequestError) return answer(errorBody(400, msg, 'bad-request'));
    return answer(errorBody(500, msg));
  }
}

