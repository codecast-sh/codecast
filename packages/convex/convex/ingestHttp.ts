// The ingest door (docs/architecture/external-data.md X2): where a running
// product posts its errors, logs, job failures, checks and deploys with a
// write-only key. `POST /cli/ingest/<key>`; `/api/ingest/<key>` is registered
// too for when the Caddy proxy forwards that prefix (see the registration in
// http.ts, next to the public repo routes that do the same).
//
// The key is checked by its hash (an address that has presented too many
// unknown keys is refused before the lookup, UNKNOWN_KEY_RATE), the batch is
// rate limited per source (failing closed: a flood on one counter row is what
// abuse looks like),
// validated against the shared contract, and handed to one internal mutation.
// Answers: 202 { accepted, dropped }; 400 or 413 for a batch that will never
// be accepted (413 means split it); 401 for an unknown key; 403 for a refused
// origin; 429 and 5xx for the SDK to retry. A paused source answers 503 with a
// Retry-After, so a running SDK keeps backing off and resumes on its own after
// `cast sources resume` (a 401 or 403 stops it for the life of its process).
import { Gunzip } from "fflate";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { INGEST_LIMITS, isIngestKey, validateIngestBatch } from "@codecast/shared/contracts/ingest";
import { sha256Hex } from "./lib/hash";
import { clientIp, ipRateLimited, keyRateLimited } from "./lib/httpRateLimit";
import { CLI_ERROR_STATUS } from "./lib/cliErrorStatus";
import { handleReplaySign, replaySignKey } from "./replaysHttp";
import type { Id } from "./_generated/dataModel";

export const INGEST_PREFIXES = ["/api/ingest/", "/cli/ingest/"];

/** Batches one source may post per window. An SDK flushes every few seconds, so this is headroom, not a quota. */
export const INGEST_RATE = { max: 120, window_ms: 60_000 } as const;

/**
 * Unknown keys one address may present per window before the door stops
 * looking keys up for it. A key ships in browser pages, so its secrecy is its
 * only guard; this bounds guessing at the lookup itself. An SDK stops on its
 * first 401, so a real caller never comes near it.
 */
export const UNKNOWN_KEY_RATE = { name: "ingest-unknown-key", max: 30, window_ms: 10 * 60_000 } as const;

/** The key from the path, else from `Authorization: Bearer <key>`. Null when neither holds one. */
export function ingestKeyFrom(pathname: string, authorization: string | null): string | null {
  const prefix = INGEST_PREFIXES.find((p) => pathname.startsWith(p));
  const fromPath = prefix ? decodeURIComponent(pathname.slice(prefix.length).split("/")[0] ?? "") : "";
  if (fromPath) return fromPath;
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  return bearer ? bearer[1] : null;
}

/** Whether a browser origin may post to a source. No list allows any; a server caller sends no Origin. */
export function originAllowed(allowed: string[] | null | undefined, origin: string | null): boolean {
  if (!allowed?.length || !origin) return true;
  return allowed.some((o) => o.replace(/\/+$/, "").toLowerCase() === origin.toLowerCase());
}

export function ingestCorsHeaders(origin?: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Content-Encoding, Authorization",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Expose-Headers": "Retry-After",
    ...(origin ? { Vary: "Origin" } : {}),
  };
}

/** Seconds a paused source asks an SDK to wait before it tries again; the SDK's own backoff cap is 60s. */
export const PAUSED_RETRY_AFTER_S = 60;

/** The answer to a paused source on every door: retryable, so resuming the source brings running SDKs back. */
export function pausedSourceResponse(cors: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "source is paused" }), {
    status: 503,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": String(PAUSED_RETRY_AFTER_S), ...cors },
  });
}

/** Inflate chunk size: one push can expand at most about a thousandfold, so the cap is checked often. */
const INFLATE_CHUNK = 4096;

/**
 * The request body as text. Gzip is inflated with the same byte cap as a
 * plain body, counted while inflating, so a small bomb is refused before it
 * is ever whole in memory.
 */
export function decodeIngestBody(bytes: Uint8Array, encoding: string | null): { text: string } | { status: 400 | 413; error: string } {
  const tooLarge = { status: 413 as const, error: `batch is over ${INGEST_LIMITS.max_bytes} bytes` };
  if (bytes.byteLength > INGEST_LIMITS.max_bytes) return tooLarge;
  const enc = (encoding ?? "").trim().toLowerCase();
  if (!enc || enc === "identity") return { text: new TextDecoder().decode(bytes) };
  if (enc !== "gzip") return { status: 400, error: `unsupported Content-Encoding ${enc}` };
  const parts: Uint8Array[] = [];
  let total = 0;
  let over = false;
  const inflater = new Gunzip((chunk) => {
    total += chunk.byteLength;
    if (total > INGEST_LIMITS.max_bytes) over = true;
    else parts.push(chunk);
  });
  try {
    for (let i = 0; i < bytes.byteLength && !over; i += INFLATE_CHUNK) {
      inflater.push(bytes.subarray(i, i + INFLATE_CHUNK), i + INFLATE_CHUNK >= bytes.byteLength);
    }
  } catch {
    return { status: 400, error: "body is not valid gzip" };
  }
  if (over) return tooLarge;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return { text: new TextDecoder().decode(out) };
}

/** The status a thrown error answers with: a structured code by the CLI routes' table, anything else 500 (retry). */
export function ingestErrorStatus(error: unknown): number {
  const code = (error as any)?.data?.code;
  return typeof code === "string" ? CLI_ERROR_STATUS[code] ?? 500 : 500;
}

export function ingestJson(status: number, body: unknown, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
}

/** A response with the CORS answer laid over its headers, so a browser SDK can read it (a 429's Retry-After). */
function withCors(res: Response, cors: Record<string, string>): Response {
  const headers = new Headers(res.headers);
  for (const [k, value] of Object.entries(cors)) headers.set(k, value);
  return new Response(res.body, { status: res.status, headers });
}

export type AdmittedSource = { _id: Id<"event_sources">; status: string; allowed_origins: string[] | null };

/**
 * Every keyed ingest route's admission, in one order: the key's shape and
 * hash, the source's origins (and the CORS answer they earn), its pause, and
 * a per-source rate limit under `rate.prefix`. Either the source and the CORS
 * headers every later answer carries, or the refusal to return.
 */
export async function admitIngestKey(
  ctx: any,
  request: Request,
  key: string | null,
  rate: { prefix: string; max: number; window_ms: number },
): Promise<{ source: AdmittedSource; cors: Record<string, string> } | Response> {
  const origin = request.headers.get("origin");
  let cors = ingestCorsHeaders();
  if (!key || !isIngestKey(key)) return ingestJson(401, { error: "unknown ingest key" }, cors);
  const found: AdmittedSource | { retry_after_ms: number } | null = await ctx.runQuery(internal.ingest.sourceForKey, {
    key_hash: await sha256Hex(key),
    guess_guard: { key: `${UNKNOWN_KEY_RATE.name}:${clientIp(request)}`, max: UNKNOWN_KEY_RATE.max, window_ms: UNKNOWN_KEY_RATE.window_ms },
  });
  if (found && "retry_after_ms" in found) {
    return ingestJson(429, { error: "too many unknown keys from this address" }, { ...cors, "Retry-After": String(Math.ceil(found.retry_after_ms / 1000)) });
  }
  if (!found) {
    // Counted only here: a known key spends nothing from this window.
    const limited = await ipRateLimited(ctx, request, UNKNOWN_KEY_RATE.name, UNKNOWN_KEY_RATE.max, UNKNOWN_KEY_RATE.window_ms);
    return limited ? withCors(limited, cors) : ingestJson(401, { error: "unknown ingest key" }, cors);
  }
  const source = found;
  if (!originAllowed(source.allowed_origins, origin)) return ingestJson(403, { error: "origin not allowed for this source" }, cors);
  if (source.allowed_origins?.length && origin) cors = ingestCorsHeaders(origin);
  if (source.status === "paused") return pausedSourceResponse(cors);
  const limited = await keyRateLimited(ctx, `${rate.prefix}:${source._id}`, rate.max, rate.window_ms, true);
  if (limited) return withCors(limited, cors);
  return { source, cors };
}

/**
 * A keyed ingest route's body run under the door's error map: a thrown
 * ConvexError answers its code's status and anything else a retryable 500,
 * both with CORS so a browser SDK reads the status instead of a network error.
 */
export async function ingestRoute(request: Request, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    const status = ingestErrorStatus(error);
    return ingestJson(status, { error: status === 500 ? "ingest failed, retry" : (error as any)?.data?.message ?? "refused" }, ingestCorsHeaders(request.headers.get("origin")));
  }
}

export const ingestServe = httpAction(async (ctx, request) => {
  // The design's spelling of the replay chunk sign route lands on this prefix (X5).
  const signKey = replaySignKey(new URL(request.url).pathname);
  if (signKey) return await handleReplaySign(ctx, request, signKey);
  return await ingestRoute(request, async () => {
    const key = ingestKeyFrom(new URL(request.url).pathname, request.headers.get("authorization"));
    const admitted = await admitIngestKey(ctx, request, key, { prefix: "ingest", max: INGEST_RATE.max, window_ms: INGEST_RATE.window_ms });
    if (admitted instanceof Response) return admitted;
    const { source, cors } = admitted;

    const decoded = decodeIngestBody(new Uint8Array(await request.arrayBuffer()), request.headers.get("content-encoding"));
    if ("status" in decoded) return ingestJson(decoded.status, { error: decoded.error }, cors);
    const batch = validateIngestBatch(decoded.text, Date.now());
    if (!batch.ok) return ingestJson(batch.status, { error: batch.error }, cors);

    let accepted = 0;
    let dropped = batch.rejected.length;
    if (batch.items.length) {
      const result: { accepted: number; dropped: number } = await ctx.runMutation(internal.ingest.applyBatch, {
        source_id: source._id,
        items_json: JSON.stringify(batch.items),
        ...(batch.envelope.release ? { release: batch.envelope.release } : {}),
        ...(batch.envelope.environment ? { environment: batch.envelope.environment } : {}),
      });
      accepted = result.accepted;
      dropped += result.dropped;
    }
    if (dropped) await ctx.runMutation(internal.ingest.countDropped, { source_id: source._id, dropped });
    return ingestJson(202, { accepted, dropped, ...(batch.rejected.length ? { rejected: batch.rejected.slice(0, 20) } : {}) }, cors);
  });
});

export const ingestPreflight = httpAction(async (_ctx, request) => {
  return new Response(null, { status: 204, headers: ingestCorsHeaders(request.headers.get("origin")) });
});
