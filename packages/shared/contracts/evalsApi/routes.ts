// Part of the Evals UI's wire contract (docs/architecture/evals-ui.md). Every
// party imports it through ../evalsApi.ts. The route table every party
// dispatches on, and the bridge's line protocol (sections 3.4 and 3.5). The
// neutral routes and the bridge come from @platform/evals/contract; codecast
// re-keys the routes whose answers it widens (an override must be assignable
// to the neutral answer, so the two cannot drift) and adds its own (the run
// file, patches, search, starting and stopping a bisect, the sim). PURE isomorphic
// data: no Node or DOM APIs.

import type {
  ChangesQuery,
  EvalsBridgeRequest as CoreBridgeRequest,
  EvalsBridgeResponse as CoreBridgeResponse,
  EvalsErrorBody as CoreErrorBody,
  EvalsViewRoutes,
  None,
  OverviewQuery,
  Route,
  SurfaceQuery,
} from "@platform/evals/contract";
import type { BisectPlan, BisectPlanRequest, BisectStartRequest, BisectStartResponse } from "./bisect";
import type { RunRow } from "./core";
import type { BisectStopResponse, ChangesResponse, OverviewResponse, PatchResponse, RunFileQuery, RunFileResponse, RunResponse, SearchQuery, SearchResponse, SimCatalogResponse, SimFailureMoved, SimJobResponse, SimRunResponse, SimSessionsResponse, SimShrinkRequest, SimSweepRequest, SurfaceResponse } from "./endpoints";

// ── The route table ─────────────────────────────────────────────────────────

/** Every endpoint, keyed `METHOD /path` with `:params`: what it takes and what it answers. Paths are relative to /evals. */
export interface EvalsRoutes extends EvalsViewRoutes<RunRow, SimFailureMoved> {
  "GET /overview": Route<None, OverviewQuery, OverviewResponse>;
  "GET /surface/:id": Route<{ id: string }, SurfaceQuery, SurfaceResponse>;
  "GET /run/:id": Route<{ id: string }, None, RunResponse>;
  "GET /changes": Route<None, ChangesQuery, ChangesResponse>;
  "GET /run/:id/file": Route<{ id: string }, RunFileQuery, RunFileResponse>;
  "GET /patch/:sha": Route<{ sha: string }, None, PatchResponse>;
  "GET /search": Route<None, SearchQuery, SearchResponse>;
  "POST /bisect/plan": Route<None, None, BisectPlan, BisectPlanRequest>;
  "POST /bisect": Route<None, None, BisectStartResponse, BisectStartRequest>;
  "POST /bisect/:id/stop": Route<{ id: string }, None, BisectStopResponse>;
  "GET /sim/catalog": Route<None, None, SimCatalogResponse>;
  "GET /sim/sessions": Route<None, None, SimSessionsResponse>;
  "GET /sim/run/:session/:run": Route<{ session: string; run: string }, None, SimRunResponse>;
  "POST /sim/shrink": Route<None, None, SimJobResponse, SimShrinkRequest>;
  "POST /sim/sweep": Route<None, None, SimJobResponse, SimSweepRequest>;
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

/** One line the daemon writes to the child's stdin: a handler request with the line's id. */
export interface EvalsBridgeRequest extends CoreBridgeRequest {
  id: number;
  method: "GET" | "POST";
  query: Record<string, string>;
}

/** One line the child writes back. */
export interface EvalsBridgeResponse extends CoreBridgeResponse {
  id: number;
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
export interface EvalsErrorBody extends CoreErrorBody {
  reason?: EvalsUnavailableReason | "bad-request" | "not-found" | "forbidden";
}
