// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. The route table every party
// dispatches on, and the bridge's line protocol (sections 3.4 and 3.5). PURE
// isomorphic data: no Node or DOM APIs.

import type { Attribution, BisectPlan, BisectPlanRequest, BisectStartRequest, BisectStartResponse } from "./bisect";
import type { AttributionQuery, BatchesQuery, BatchesResponse, BisectListResponse, BisectQuery, BisectResponse, BisectStopResponse, ChangesQuery, ChangesResponse, CommitQuery, CommitResponse, CompareQuery, CompareResponse, EpochQuery, EpochResponse, FreezeResponse, HealthResponse, OverviewQuery, OverviewResponse, PatchResponse, RunFileQuery, RunFileResponse, RunResponse, SearchQuery, SearchResponse, SimCatalogResponse, SimJobResponse, SimRunResponse, SimSessionsResponse, SimShrinkRequest, SimSweepRequest, SurfaceQuery, SurfaceResponse } from "./endpoints";

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
  "GET /search": { params: None; query: SearchQuery; body: never; response: SearchResponse };
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
  "GET /search",
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
