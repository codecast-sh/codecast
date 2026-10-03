// Loopback client for the daemon's /evals routes (cli/src/evals/evalsServer.ts),
// which forwards each request to the eval tool's api child. The evals live on
// the laptop that ran them, so they are read straight off its disk through the
// same bridge, token and endpoint discovery as Files and Memory.
//
// Every request is an EvalsBridgeRequest, the line the daemon hands the child,
// so the loopback transport and the dev fixture transport take the same value
// and the route table in the contract types both ends.

import type {
  EvalsBridgeRequest,
  EvalsErrorBody,
  EvalsRouteKey,
  EvalsRoutes,
  EvalsResponse,
} from "@codecast/shared/contracts/evalsApi";
import { loopbackFetch, type VaultEndpoint } from "../vault/client";

/** A non-2xx answer, with the bridge's error body (its reason and, for a crash, stderr). */
export class EvalsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: EvalsErrorBody,
  ) {
    super(body.error || `evals: ${status}`);
  }
}

/** Sends one bridge request and returns the status and body, never throwing on a status. */
export interface EvalsTransport {
  readonly kind: "loopback" | "fixture";
  send(req: EvalsBridgeRequest): Promise<{ status: number; body: unknown }>;
}

type Route<K extends EvalsRouteKey> = EvalsRoutes[K];
/** Whether a route part has anything in it: `never` and the contract's empty `Record<string, never>` do not. */
type Has<T> = [T] extends [never] ? false : string extends keyof T ? false : keyof T extends never ? false : true;

/** What a call to route K takes: only the parts the route has. */
export type EvalsArgs<K extends EvalsRouteKey> = (Has<Route<K>["params"]> extends true ? { params: Route<K>["params"] } : { params?: undefined }) &
  (Has<Route<K>["query"]> extends true ? { query?: Route<K>["query"] } : { query?: undefined }) &
  ([Route<K>["body"]] extends [never] ? { body?: undefined } : { body: Route<K>["body"] });

/** A query value as the child reads it: booleans as 1 and 0 (`whole=0|1`), nothing for undefined. */
export function encodeEvalsQuery(query: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  }
  return out;
}

/** The bridge request for route K: `:params` filled in and encoded, the query flattened. */
export function evalsRequest<K extends EvalsRouteKey>(key: K, args: EvalsArgs<K>, id = 0): EvalsBridgeRequest {
  const [method, pattern] = key.split(" ") as ["GET" | "POST", string];
  const params = (args.params ?? {}) as Record<string, string>;
  const path = pattern.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`${key}: missing :${name}`);
    return encodeURIComponent(value);
  });
  const req: EvalsBridgeRequest = { id, method, path, query: encodeEvalsQuery(args.query as Record<string, unknown> | undefined) };
  if (args.body !== undefined) req.body = args.body;
  return req;
}

/** The URL path a bridge request travels on, under the daemon's /evals prefix. */
export function evalsUrlPath(req: EvalsBridgeRequest): string {
  const qs = new URLSearchParams(req.query).toString();
  return `/evals${req.path}${qs ? `?${qs}` : ""}`;
}

export function loopbackTransport(ep: VaultEndpoint): EvalsTransport {
  return {
    kind: "loopback",
    async send(req) {
      const init: RequestInit = { method: req.method };
      if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
        init.headers = { "Content-Type": "application/json" };
      }
      const res = await loopbackFetch(ep, evalsUrlPath(req), init);
      const body = await res.json().catch(() => ({ error: `evals: ${res.status} with no JSON body` }));
      return { status: res.status, body };
    },
  };
}

let nextId = 1;

/** Calls route K and returns its typed answer; a non-2xx status throws EvalsRequestError. */
export async function callEvals<K extends EvalsRouteKey>(transport: EvalsTransport, key: K, args: EvalsArgs<K>): Promise<EvalsResponse<K>> {
  const { status, body } = await transport.send(evalsRequest(key, args, nextId++));
  if (status < 200 || status >= 300) {
    const err = (body && typeof body === "object" ? body : {}) as EvalsErrorBody;
    throw new EvalsRequestError(status, { ...err, error: err.error ?? `evals: ${status}` });
  }
  return body as EvalsResponse<K>;
}
