// What every evals handler does with a request before and after its route:
// the checks a query or body goes through, the two errors a route throws, and
// the answer that turns a route's value or error into a bridge response. A
// product's own routes (codecast's run files, bisect starts, sim) take the
// same checks and the same answer, so every route reports errors one way.

import { EVALS_BATCH_TOKEN_RE, EVALS_SHA_RE, resolveEvalsBatchRef, type EvalsBridgeRequest, type EvalsBridgeResponse, type EvalsErrorBody, type RunRowCore } from '../contract';

/** A request that names something no source holds: 404. */
export class NotFound extends Error {}
/** A request whose query or body is wrong: 400. */
export class BadRequest extends Error {}

// ── Request checks ──────────────────────────────────────────────────────────

export const need = (q: Record<string, string>, k: string): string => {
  const v = q[k];
  if (!v) throw new BadRequest(`${k} is required`);
  return v;
};
export const flag = (v: string | undefined): boolean => v === '1' || v === 'true';
export const posInt = (v: unknown, what: string, max = 100): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new BadRequest(`${what} takes a whole number from 1 to ${max}`);
  return n;
};
export const posNum = (v: unknown, what: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequest(`${what} takes a positive number`);
  return n;
};

export const rowById = <R extends Pick<RunRowCore, 'id'>>(rows: R[], id: string): R => {
  const row = rows.find((r) => r.id === id);
  if (!row) throw new NotFound(`no run ${id}`);
  return row;
};

/** A batch of the surface (by name or by its address hash) or a commit `verify` accepts (EVALS_SHA_RE first): what an attribution or bisect endpoint may be. */
export function endpointRef(all: Array<Pick<RunRowCore, 'surface' | 'batch'>>, surface: string, ref: unknown, what: string, verify: (sha: string) => void): string {
  if (typeof ref !== 'string' || !ref) throw new BadRequest(`${what} is required`);
  if (all.some((r) => r.surface === surface && r.batch === ref)) return ref;
  // A page address names a labelled batch by its hash (evalsBatchRef); the batch is the one that hashes to it.
  if (EVALS_BATCH_TOKEN_RE.test(ref)) {
    const named = resolveEvalsBatchRef(ref, new Set(all.flatMap((r) => (r.surface === surface && r.batch ? [r.batch] : []))));
    if (!named) throw new BadRequest(`${what} ${ref} names no ${surface} batch`);
    return named;
  }
  if (!EVALS_SHA_RE.test(ref)) throw new BadRequest(`${what} ${ref} is neither a ${surface} batch nor a sha`);
  verify(ref);
  return ref;
}

/**
 * Freezes a request names, as ids or id prefixes of 8 or more characters,
 * each one the surface has run: the plan, the bisect and the free answer take
 * the same refs, so the launcher's two asks cannot read different freezes.
 */
export function ranFreezes(all: Array<Pick<RunRowCore, 'surface' | 'freezeId'>>, surface: string, refs: unknown[]): string[] {
  if (refs.some((f) => typeof f !== 'string' || !/^[0-9a-f-]{8,36}$/.test(f))) throw new BadRequest('freezes are freeze ids, or id prefixes of 8 or more characters');
  const ran = new Set(all.filter((r) => r.surface === surface).map((r) => r.freezeId));
  const unknown = (refs as string[]).filter((f) => ![...ran].some((id) => id.startsWith(f)));
  if (unknown.length) throw new BadRequest(`${surface} never ran freeze ${unknown.join(', ')}`);
  return refs as string[];
}

// ── Route types ─────────────────────────────────────────────────────────────

type ParamsOf<R> = R extends { params: infer P } ? P : never;
type ResponseOf<R> = R extends { response: infer Res } ? Res : never;

/** What a route's handler is called with: its decoded params, the query and the body. `T` is a route table (EvalsViewRoutes, or a product's wider one). */
export type RouteArgs<T, K extends keyof T> = {
  params: ParamsOf<T[K]> extends Record<string, never> ? Record<string, string> : ParamsOf<T[K]>;
  query: Record<string, string>;
  body: unknown;
};
export type RouteHandler<T, K extends keyof T> = (a: RouteArgs<T, K>) => Promise<ResponseOf<T[K]>> | ResponseOf<T[K]>;
/** A route's handler once its key is chosen at run time: matchRoute decoded exactly the params that key's pattern names. */
export type AnyRouteHandler = (a: { params: Record<string, string>; query: Record<string, string>; body: unknown }) => unknown;

// ── The answer ──────────────────────────────────────────────────────────────

/** The reply to a request. A request that carries a line protocol's id (codecast's daemon bridge) gets it back. */
export type EvalsReply<Req extends EvalsBridgeRequest> = EvalsBridgeResponse & (Req extends { id: infer I } ? { id: I } : unknown);

const replyTo = <Req extends EvalsBridgeRequest>(req: Req, r: EvalsBridgeResponse): EvalsReply<Req> =>
  ('id' in req ? { id: (req as { id?: unknown }).id, ...r } : r) as EvalsReply<Req>;

const errorBody = (status: number, error: string, reason?: string): EvalsBridgeResponse => ({ status, body: { error, ...(reason ? { reason } : {}) } satisfies EvalsErrorBody });

/** The 404 a request no table holds answers with. */
export const noRoute = <Req extends EvalsBridgeRequest>(req: Req): EvalsReply<Req> => replyTo(req, errorBody(404, `no route ${req.method} ${req.path}`, 'not-found'));

/**
 * One request answered by `handler`: its value with 200, or an error body
 * with its status (NotFound 404, BadRequest or what `badRequest` names 400,
 * anything else 500). Never throws.
 */
export async function answer<Req extends EvalsBridgeRequest>(req: Req, route: { params: Record<string, string> }, handler: AnyRouteHandler, badRequest: (e: unknown) => boolean = () => false): Promise<EvalsReply<Req>> {
  try {
    const body = await handler({ params: route.params, query: req.query ?? {}, body: req.body });
    return replyTo(req, { status: 200, body });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof NotFound) return replyTo(req, errorBody(404, msg, 'not-found'));
    if (e instanceof BadRequest || badRequest(e)) return replyTo(req, errorBody(400, msg, 'bad-request'));
    return replyTo(req, errorBody(500, msg));
  }
}
