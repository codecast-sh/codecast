// Part of the shared evals wire contract (codecast docs/architecture/evals-ui.md):
// the neutral route table every party dispatches on, and the bridge protocol
// (sections 3.4 and 3.5). A product's own routes join the table by
// intersection, in its own key list (codecast: EvalsRoutes and EVALS_ROUTE_KEYS).
// PURE isomorphic data: no Node or DOM APIs.

import type { Attribution } from "./bisect";
import type { RunRowCore } from "./core";
import type { AttributionQuery, BatchesQuery, BatchesResponse, BisectListResponse, BisectQuery, BisectResponse, ChangesQuery, ChangesResponse, CommitQuery, CommitResponse, CompareQuery, CompareResponse, EpochQuery, EpochResponse, FreezeResponse, HealthResponse, OverviewQuery, OverviewResponse, RunResponse, SurfaceQuery, SurfaceResponse } from "./views";

// ── The route table ─────────────────────────────────────────────────────────

/** No params, or no query. */
export type None = Record<string, never>;

/** One endpoint: what it takes and what it answers. */
export interface Route<P, Q, Res, B = never> {
  params: P;
  query: Q;
  body: B;
  response: Res;
}

/**
 * The neutral endpoints, keyed `METHOD /path` with `:params`, relative to the
 * evals base. `R` is the product's row; `M` its own "What moved" kinds.
 */
export interface EvalsViewRoutes<R extends RunRowCore = RunRowCore, M = never> {
  "GET /health": Route<None, None, HealthResponse>;
  "GET /overview": Route<None, OverviewQuery, OverviewResponse<M>>;
  "GET /surface/:id": Route<{ id: string }, SurfaceQuery, SurfaceResponse<R>>;
  "GET /freeze/:id": Route<{ id: string }, None, FreezeResponse<R>>;
  "GET /run/:id": Route<{ id: string }, None, RunResponse<R>>;
  "GET /compare": Route<None, CompareQuery, CompareResponse<R>>;
  "GET /batches": Route<None, BatchesQuery, BatchesResponse>;
  "GET /epoch": Route<None, EpochQuery, EpochResponse>;
  "GET /attribution": Route<None, AttributionQuery, Attribution>;
  "GET /commit/:sha": Route<{ sha: string }, CommitQuery, CommitResponse>;
  "GET /changes": Route<None, ChangesQuery, ChangesResponse<R>>;
  "GET /bisects": Route<None, None, BisectListResponse>;
  "GET /bisect/:id": Route<{ id: string }, BisectQuery, BisectResponse>;
}

export type EvalsViewRouteKey = keyof EvalsViewRoutes;

/** Every neutral route key, in the order of codecast's table. Typed so a key missing here or misspelled fails to compile. */
export const EVALS_VIEW_ROUTE_KEYS = [
  "GET /health",
  "GET /overview",
  "GET /surface/:id",
  "GET /freeze/:id",
  "GET /run/:id",
  "GET /compare",
  "GET /batches",
  "GET /epoch",
  "GET /attribution",
  "GET /commit/:sha",
  "GET /changes",
  "GET /bisects",
  "GET /bisect/:id",
] as const satisfies readonly EvalsViewRouteKey[];

type _AllViewRoutesListed = Exclude<EvalsViewRouteKey, (typeof EVALS_VIEW_ROUTE_KEYS)[number]> extends never ? true : never;
const _allViewRoutesListed: _AllViewRoutesListed = true;
void _allViewRoutesListed;

/**
 * The route a method and path name among `keys`, with its params decoded, or
 * null. Keys are tried in order, so a product lists its own table once and
 * every party (its server, its fixture transport) reads that one list. `path`
 * is relative to the evals base and carries no query.
 */
export function matchRoute<K extends string>(keys: readonly K[], method: string, path: string): { key: K; params: Record<string, string> } | null {
  const parts = path.replace(/^\/+|\/+$/g, "").split("/");
  for (const key of keys) {
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

/** One request to an evals handler. A line protocol adds its own id (codecast's daemon bridge). */
export interface EvalsBridgeRequest {
  method: string;
  /** Relative to the evals base, without the query. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

/** The handler's answer. */
export interface EvalsBridgeResponse {
  status: number;
  body: unknown;
}

/** The body of every non-2xx answer. A product narrows `reason` to its own words. */
export interface EvalsErrorBody {
  error: string;
  reason?: string;
  /** A crashed child's last stderr lines. */
  stderr?: string[];
}
