// The replay routes (docs/architecture/external-data.md X5), registered in
// http.ts beside the ingest door (ingestHttp.ts).
//
// Sign: the SDK asks for one presigned PUT per gzipped chunk and uploads it
// straight to the private codecast-replays bucket, so replay bytes never pass
// through Convex. The key is content addressed
// (replays/<source>/<replay>/<seq>-<sha256>.json.gz): a chunk already in the
// bucket answers `exists` with no URL and is not uploaded twice. The PUT is
// unsigned-payload with the declared size signed as its content-length, so R2
// refuses any other size; the hash is not enforced there, and the assembler
// (replays.readReplayChunks) holds chunks to it.
//
// Chunk read: a 302 to a GET signed now for a few minutes, minted only after
// the reader's workspace access is checked, the way a shared call's video is
// served (http.ts sharedCallVideo). No URL into the bucket is ever stored.
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { r2FreshGetUrl, r2Presign, replayChunkKey, replaysBucketFromEnv, safeReplayPathSegment } from "./lib/r2";
import { admitIngestKey, ingestCorsHeaders, ingestJson, ingestRoute } from "./ingestHttp";
import { REPLAY_LIMITS } from "@codecast/shared/contracts/replay";

/** The path the SDK posts to, on either prefix the proxy forwards. */
export const REPLAY_SIGN_PREFIXES = ["/cli/ingest/replay-sign/", "/api/ingest/replay-sign/"] as const;

/** Sign requests a source may make per minute: a 60 chunk recording and its retries, several at once. */
const SIGN_PER_MINUTE = 600;

/**
 * The ingest key in a sign path. Both spellings are read: the registered
 * `/cli/ingest/replay-sign/<key>`, and the design's `/cli/ingest/<key>/replay-sign`,
 * which the ingest door forwards here (the router cannot hold two handlers on
 * the `/cli/ingest/` prefix, and the door owns that one).
 */
export function replaySignKey(pathname: string): string | null {
  const m =
    pathname.match(/^\/(?:cli|api)\/ingest\/replay-sign\/([^/]+)\/?$/) ??
    pathname.match(/^\/(?:cli|api)\/ingest\/([^/]+)\/replay-sign\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface ReplaySignBody {
  replay_id: string;
  seq: number;
  sha256: string;
  size: number;
}

/** The sign request, checked, or the reason it is refused (always a 400: retrying will not help). */
export function validateReplaySign(body: unknown): ReplaySignBody | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const b = body as Record<string, unknown>;
  if (typeof b.replay_id !== "string" || !b.replay_id.trim() || b.replay_id.length > 200) return "replay_id must be a string of 1 to 200 characters";
  if (typeof b.seq !== "number" || !Number.isInteger(b.seq) || b.seq < 0 || b.seq >= REPLAY_LIMITS.max_chunks_per_replay) {
    return `seq must be an integer from 0 to ${REPLAY_LIMITS.max_chunks_per_replay - 1}`;
  }
  if (typeof b.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(b.sha256)) return "sha256 must be 64 lowercase hex characters (of the gzipped chunk)";
  if (typeof b.size !== "number" || !Number.isInteger(b.size) || b.size <= 0) return "size must be the chunk's byte length";
  if (b.size > REPLAY_LIMITS.chunk_max_bytes) return `a chunk is at most ${REPLAY_LIMITS.chunk_max_bytes} bytes`;
  return { replay_id: b.replay_id.trim(), seq: b.seq, sha256: b.sha256, size: b.size };
}

/**
 * POST <prefix><key> { replay_id, seq, sha256, size } -> { key, upload_url, exists, expires_in }.
 * 401 stops the SDK (bad key), 403 stops it for a refused origin, 400 drops
 * the chunk, 429 and 503 are worth a retry (a paused source is a 503). The
 * upload URL signs the declared size as the PUT's content-length, so the
 * bucket refuses a body of any other size.
 */
export async function handleReplaySign(ctx: any, request: Request, key: string): Promise<Response> {
  return await ingestRoute(request, async () => {
    const admitted = await admitIngestKey(ctx, request, key, { prefix: "replay-sign", max: SIGN_PER_MINUTE, window_ms: 60_000 });
    if (admitted instanceof Response) return admitted;
    const { source, cors } = admitted;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return ingestJson(400, { error: "body is not JSON" }, cors);
    }
    const sign = validateReplaySign(body);
    if (typeof sign === "string") return ingestJson(400, { error: sign }, cors);

    const bucket = replaysBucketFromEnv();
    if (!bucket) return ingestJson(503, { error: "replay storage is not configured" }, cors);
    const objectKey = replayChunkKey({ sourceId: String(source._id), replay: safeReplayPathSegment(sign.replay_id), seq: sign.seq, sha256: sign.sha256 });
    const recorded = await ctx.runMutation(internal.replays.recordChunk, { source_id: source._id, replay_external_id: sign.replay_id, seq: sign.seq, key: objectKey });
    if (!recorded.ok) return ingestJson(400, { error: recorded.reason }, cors);

    const head = await fetch(await r2Presign(bucket, "HEAD", objectKey, REPLAY_LIMITS.signed_url_ttl_s), { method: "HEAD" }).catch(() => null);
    if (head?.ok) return ingestJson(200, { key: objectKey, upload_url: null, exists: true }, cors);
    const uploadUrl = await r2Presign(bucket, "PUT", objectKey, REPLAY_LIMITS.signed_url_ttl_s, undefined, undefined, { "content-length": String(sign.size) });
    return ingestJson(200, { key: objectKey, upload_url: uploadUrl, exists: false, expires_in: REPLAY_LIMITS.signed_url_ttl_s }, cors);
  });
}

export const replaySign = httpAction(async (ctx, request) => {
  const key = replaySignKey(new URL(request.url).pathname);
  if (!key) return ingestJson(404, { error: "not found" }, ingestCorsHeaders());
  return await handleReplaySign(ctx, request, key);
});

/** The path the web player and the CLI read one chunk through. */
export const REPLAY_CHUNK_PATH = "/cli/replays/chunk";

/**
 * GET /cli/replays/chunk?replay=<rp-N|id>&seq=<n>. The web signs in with its
 * Convex session (Authorization: Bearer <jwt>); the CLI sends its api token
 * as X-Api-Token, which a JWT check would refuse. A refusal and a missing
 * chunk answer the same 404.
 */
// The web app reads from its own origin with an Authorization header, so the
// answer carries CORS; the redirect target (R2) answers its own CORS for "*".
const CHUNK_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-Api-Token",
  "Access-Control-Max-Age": "86400",
};

export const replayChunkPreflight = httpAction(async () => new Response(null, { status: 204, headers: CHUNK_CORS }));

export const replayChunk = httpAction(async (ctx, request) => {
  const u = new URL(request.url);
  const replay = u.searchParams.get("replay") ?? "";
  const seq = Number(u.searchParams.get("seq"));
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store", ...CHUNK_CORS } });
  if (!replay || !Number.isInteger(seq) || seq < 0) return notFound();
  const apiToken = request.headers.get("X-Api-Token") ?? undefined;
  const userId = apiToken ? undefined : await getAuthUserId(ctx).catch(() => null);
  if (!apiToken && !userId) return new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store", ...CHUNK_CORS } });
  const key: string | null = await ctx.runQuery(internal.replays.chunkObject, { user_id: userId ?? undefined, api_token: apiToken, replay, seq });
  const bucket = replaysBucketFromEnv();
  if (!key || !bucket) return notFound();
  const { url } = await r2FreshGetUrl(bucket, key);
  return new Response(null, { status: 302, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...CHUNK_CORS } });
});
