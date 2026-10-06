// The one handler every product's evals routes go through: the neutral route
// table (EvalsViewRoutes) answered from a product's sources and verdict
// policy. A request for any other route answers 404, so a product answers its
// own routes first and hands the rest here. It runs wherever the product's
// rows are: codecast's api child, a browser over a REST adapter (union), a
// local server (eaiden), a test.

import type { VerdictRun } from '../analysis';
import { EVALS_VIEW_ROUTE_KEYS, matchRoute, type BisectListResponse, type ChangesResponse, type EvalsBridgeRequest, type EvalsViewRouteKey, type EvalsViewRoutes, type HealthResponse, type RunRowCore } from '../contract';
import { answer, BadRequest, endpointRef, flag, need, noRoute, NotFound, posInt, ranFreezes, type AnyRouteHandler, type EvalsReply, type RouteHandler } from './request';
import { capabilitiesOf, type EvalsSources, type HandlerPolicy, type QuerySurface } from './sources';
import { evalsViews, rowsMemo } from './views';

/** A handler: one bridge request in, its answer out. Never throws. */
export type EvalsHandler = <Req extends EvalsBridgeRequest>(req: Req) => Promise<EvalsReply<Req>>;

const VIEW_KEYS = new Set<string>(EVALS_VIEW_ROUTE_KEYS);
/** Whether a route key is one of the neutral routes this handler answers. */
export const isViewRoute = (key: string): key is EvalsViewRouteKey => VIEW_KEYS.has(key);

/** What marks a rep as changed for /changes: how it landed and was graded, its spend, and its newest event while it runs. */
const coreSig = (r: RunRowCore): string => `${r.status}|${r.score}|${r.gatesFailed.join(',')}|${r.costUsd}|${r.judgeCostUsd}|${r.lastEventAt ?? ''}`;

/**
 * The shared routes over one product's sources and verdict policy. /health
 * carries the capabilities the sources give, so a page hides what the
 * product cannot fill.
 */
export function createEvalsHandler<R extends RunRowCore, S extends QuerySurface, M extends { at: string } = never>(src: EvalsSources<R, S, M>, policy: HandlerPolicy<VerdictRun>): EvalsHandler {
  const views = evalsViews(src, policy, rowsMemo());
  const capabilities = capabilitiesOf(src, policy);
  const startedAt = new Date().toISOString();
  const surfaces = async () => src.surfaces();

  /** /health for a product with no facts of its own: how many rows it holds. */
  async function rowsHealth(): Promise<Omit<HealthResponse, 'capabilities'>> {
    const n = (await src.rows()).length;
    return { root: '', evalsHome: '', gitHead: null, runsIndexed: n, index: { state: 'warm', done: n, total: n }, pid: 0, startedAt };
  }

  // /changes: when each row last changed, as this handler saw it; rows present at the first look count as old (0).
  const seen = new Map<string, { sig: string; at: number }>();
  let primed = false;

  /**
   * Everything that moved since a cursor (a time in ms the last answer gave):
   * reps that landed or were rescored, bisects whose state moved, and the
   * product's own changed things. A cursor from before this handler started
   * is fine: rows it never saw change count as old, so a restart does not
   * replay the whole index.
   */
  async function changes(feed: NonNullable<EvalsSources<R, S, M>['changes']>, since: number): Promise<ChangesResponse<R> & object> {
    const now = Date.now();
    const all = await src.rows();
    const sigOf = feed.sig ? (r: R) => `${coreSig(r)}|${feed.sig!(r)}` : coreSig;
    for (const r of all) {
      const sig = sigOf(r);
      const hit = seen.get(r.id);
      if (!hit) seen.set(r.id, { sig, at: primed ? now : 0 });
      else if (hit.sig !== sig) seen.set(r.id, { sig, at: now });
    }
    primed = true;
    src.bisects?.settle?.();
    return {
      cursor: now,
      runs: all.filter((r) => (seen.get(r.id)?.at ?? 0) > since),
      bisects: (src.bisects?.summaries() ?? []).filter((b) => Date.parse(b.updatedAt) > since),
      ...feed.extra?.(since),
    };
  }

  const missing = (what: string) => {
    throw new NotFound(`this product records no ${what}`);
  };

  const routes: { [K in EvalsViewRouteKey]: RouteHandler<EvalsViewRoutes<R, M>, K> } = {
    'GET /health': async () => ({ ...(src.health ? src.health() : await rowsHealth()), capabilities }),
    'GET /overview': async ({ query }) => {
      // Staleness is asked first: the product may read it while the rows load.
      const words = src.staleness ? src.staleness() : Promise.resolve(null);
      return views.overview(await src.rows(), await surfaces(), query.cadence || 'all', words);
    },
    'GET /surface/:id': async ({ params, query }) => views.surfaceView(await src.rows(), await surfaces(), params.id, { from: query.from, to: query.to, model: query.model, cadence: query.cadence, dry: flag(query.dry), bisect: flag(query.bisect) }),
    'GET /freeze/:id': async ({ params }) => {
      if (!src.freezes) return missing('freezes');
      if (!/^[0-9a-f-]{4,36}$/.test(params.id)) throw new BadRequest('a freeze id is hex with dashes');
      return views.freezeView(await src.rows(), await surfaces(), params.id);
    },
    'GET /run/:id': async ({ params }) => views.runView(await src.rows(), params.id),
    'GET /compare': async ({ query }) => (src.pair ? views.compareView(await src.rows(), need(query, 'a'), need(query, 'b')) : missing('pairs of reps to compare')),
    'GET /batches': async ({ query }) => views.batchesView(await src.rows(), await surfaces(), need(query, 'surface'), need(query, 'a'), need(query, 'b')),
    'GET /epoch': async ({ query }) => {
      const n = posInt(need(query, 'n'), 'n', 10_000)!;
      return views.epochView(await src.rows(), await surfaces(), need(query, 'surface'), n);
    },
    'GET /attribution': async ({ query }) => {
      const surface = need(query, 'surface');
      const git = src.git;
      if (!git || !src.prompts) return missing('commits to attribute a change to');
      const all = await src.rows();
      const ref = (k: 'good' | 'bad') => (query[k] ? endpointRef(all, surface, query[k], k, git.verify) : undefined);
      const freeze = query.freeze ? ranFreezes(all, surface, [query.freeze])[0] : undefined;
      return views.attributionView(all, await surfaces(), surface, ref('good'), ref('bad'), flag(query.allCommits), freeze);
    },
    'GET /commit/:sha': async ({ params, query }) => {
      if (!src.git) return missing('commits');
      if (query.surface && !(await surfaces()).some((s) => s.id === query.surface)) throw new NotFound(`no surface ${query.surface}`);
      return src.git.commit(params.sha, query.surface || null, flag(query.whole));
    },
    'GET /changes': ({ query }) => (src.changes ? changes(src.changes, Number(query.since) || 0) : missing('change feed; poll the page instead')),
    'GET /bisects': (): BisectListResponse => {
      const b = src.bisects;
      if (!b) return missing('bisects');
      b.settle?.();
      return { bisects: b.summaries(), running: b.running() };
    },
    'GET /bisect/:id': ({ params, query }) => {
      if (!src.bisects) return missing('bisects');
      const b = src.bisects.get(params.id, Number(query.since) || 0);
      if (!b) throw new NotFound(`no bisect ${params.id}`);
      return b;
    },
  };

  return (req) => {
    const route = matchRoute(EVALS_VIEW_ROUTE_KEYS, req.method, req.path);
    if (!route) return Promise.resolve(noRoute(req));
    return answer(req, route, routes[route.key] as AnyRouteHandler);
  };
}
