// How a page asks the evals handler: every request is an EvalsBridgeRequest,
// whatever carries it (a local handler in the same process, plain HTTP, or a
// product's own bridge such as codecast's daemon loopback), so every
// transport takes the same value and a route table types both ends.

import type { EvalsBridgeRequest, EvalsBridgeResponse, EvalsErrorBody, EvalsViewRoutes } from '../contract';

/** A non-2xx answer, with the handler's error body (its reason and, for a crash, stderr). */
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
  /** What answers: "local", "http", or a product's own ("loopback", "fixture"). */
  readonly kind: string;
  send(req: EvalsBridgeRequest): Promise<EvalsBridgeResponse>;
}

/** A bridge request as the client builds it: the query always present, flattened to strings. */
export type EvalsRequest = EvalsBridgeRequest & { query: Record<string, string> };

type ParamsOf<R> = R extends { params: infer P } ? P : never;
type QueryOf<R> = R extends { query: infer Q } ? Q : never;
type BodyOf<R> = R extends { body: infer B } ? B : never;
/** What route K of table T answers. */
export type EvalsResponseOf<T, K extends keyof T> = T[K] extends { response: infer Res } ? Res : never;
/** Whether a route part has anything in it: `never` and the contract's empty `Record<string, never>` do not. */
type Has<T> = [T] extends [never] ? false : string extends keyof T ? false : keyof T extends never ? false : true;

/** What a call to route K of table T takes: only the parts the route has. */
export type EvalsArgs<T, K extends keyof T> = (Has<ParamsOf<T[K]>> extends true ? { params: ParamsOf<T[K]> } : { params?: undefined }) &
  (Has<QueryOf<T[K]>> extends true ? { query?: QueryOf<T[K]> } : { query?: undefined }) &
  ([BodyOf<T[K]>] extends [never] ? { body?: undefined } : { body: BodyOf<T[K]> });

/** A query value as the handler reads it: booleans as 1 and 0 (`whole=0|1`), nothing for undefined. */
export function encodeEvalsQuery(query: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
  }
  return out;
}

/** The bridge request for a route key: `:params` filled in and encoded, the query flattened. */
function requestOf(key: string, args: { params?: unknown; query?: unknown; body?: unknown }): EvalsRequest {
  const [method, pattern] = key.split(' ') as [string, string];
  const params = (args.params ?? {}) as Record<string, string>;
  const path = pattern.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') throw new Error(`${key}: missing :${name}`);
    return encodeURIComponent(value);
  });
  const req: EvalsRequest = { method, path, query: encodeEvalsQuery(args.query as Record<string, unknown> | undefined) };
  if (args.body !== undefined) req.body = args.body;
  return req;
}

/** The cache key for a request: its method, path and sorted query, which is everything the answer depends on. */
export function evalsRequestKey(req: Pick<EvalsRequest, 'method' | 'path' | 'query'>): string {
  const qs = new URLSearchParams(Object.entries(req.query).sort(([a], [b]) => a.localeCompare(b))).toString();
  return `${req.method} ${req.path}${qs ? `?${qs}` : ''}`;
}

/** Sends a request and returns its body; a non-2xx status throws EvalsRequestError. */
export async function sendEvals(transport: EvalsTransport, req: EvalsBridgeRequest): Promise<unknown> {
  const { status, body } = await transport.send(req);
  if (status < 200 || status >= 300) {
    const err = (body && typeof body === 'object' ? body : {}) as EvalsErrorBody;
    throw new EvalsRequestError(status, { ...err, error: err.error ?? `evals: ${status}` });
  }
  return body;
}

/** Requests, cache keys and calls typed by a route table: the neutral one, or a product's wider one (codecast: EvalsRoutes). */
export interface EvalsCalls<T> {
  request<K extends keyof T & string>(key: K, args: EvalsArgs<T, K>): EvalsRequest;
  cacheKey<K extends keyof T & string>(key: K, args: EvalsArgs<T, K>): string;
  call<K extends keyof T & string>(transport: EvalsTransport, key: K, args: EvalsArgs<T, K>): Promise<EvalsResponseOf<T, K>>;
}

/** The calls for route table T. One implementation; the table only types it. */
export function evalsCalls<T>(): EvalsCalls<T> {
  return {
    request: (key, args) => requestOf(key, args),
    cacheKey: (key, args) => evalsRequestKey(requestOf(key, args)),
    call: async (transport, key, args) => (await sendEvals(transport, requestOf(key, args))) as never,
  };
}

/** The neutral routes' calls. */
export const { request: evalsRequest, cacheKey: evalsCacheKey, call: callEvals } = evalsCalls<EvalsViewRoutes>();

/** The URL path a bridge request travels on, under a base (codecast's daemon: `/evals`). */
export function evalsUrlPath(req: Pick<EvalsBridgeRequest, 'path' | 'query'>, basePath: string): string {
  const qs = new URLSearchParams(req.query ?? {}).toString();
  return `${basePath.replace(/\/+$/, '')}${req.path}${qs ? `?${qs}` : ''}`;
}

/** The fetch init for a bridge request: its method, and its body as JSON. */
export function evalsFetchInit(req: Pick<EvalsBridgeRequest, 'method' | 'body'>): { method: string; body?: string; headers?: Record<string, string> } {
  return req.body === undefined ? { method: req.method } : { method: req.method, body: JSON.stringify(req.body), headers: { 'Content-Type': 'application/json' } };
}

/** A fetched answer as a bridge response: its status, and its JSON body or an error body saying it had none. */
export async function evalsResponseOf(res: { status: number; json(): Promise<unknown> }): Promise<EvalsBridgeResponse> {
  const body = await res.json().catch((): EvalsErrorBody => ({ error: `evals: ${res.status} with no JSON body` }));
  return { status: res.status, body };
}

/**
 * A handler in the same process (a browser adapter over a product's REST,
 * a test). Each answer is a copy, as it would be over the wire: a page that
 * edits what it got cannot change an answer the handler keeps.
 */
export function localTransport(handler: (req: EvalsBridgeRequest) => Promise<EvalsBridgeResponse>, kind = 'local'): EvalsTransport {
  return {
    kind,
    async send(req) {
      const { status, body } = await handler(req);
      return { status, body: structuredClone(body) };
    },
  };
}

/** A handler served over HTTP at `baseUrl` (eaiden's local server). `init` adds headers or credentials to every request. */
export function httpTransport(baseUrl: string, init: { headers?: Record<string, string>; credentials?: 'omit' | 'same-origin' | 'include' } = {}): EvalsTransport {
  return {
    kind: 'http',
    async send(req) {
      const base = evalsFetchInit(req);
      const res = await fetch(evalsUrlPath(req, baseUrl), { ...base, headers: { ...init.headers, ...base.headers }, ...(init.credentials ? { credentials: init.credentials } : {}) });
      return evalsResponseOf(res);
    },
  };
}
