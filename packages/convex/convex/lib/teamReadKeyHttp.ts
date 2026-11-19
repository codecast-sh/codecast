// GET /cli/v1/team/sessions: a server reads its team's shared session
// metadata with a team read key (teamReadKeys.ts), sent as
// `Authorization: Bearer cc_trk_...`. Under /cli/ so the Caddy proxies that
// forward /cli/* already reach it.
//
// Query: `since` and `until` (ms since the epoch or ISO 8601; the last 24
// hours by default), `limit` (50 by default, at most 100) and `cursor` (the
// previous page's next_cursor, which carries that page's window). A page can
// hold fewer than `limit` sessions while next_cursor is set; keep paging until
// it is null.
//
// Answers 200 { sessions, next_cursor }; 400 for a bad parameter; 401 for a
// missing, unknown, revoked or expired key; 429 when the key, or an address
// presenting unknown keys, is over its limit.
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { TeamSessionRow } from "../teamReadKeys";
import { ipRateLimited, keyRateLimited } from "./httpRateLimit";
import { sha256Hex } from "./hash";
import { isTeamReadKey } from "./teamReadKey";

export const TEAM_SESSIONS_PATH = "/cli/v1/team/sessions";
/** Requests one key may make per window. */
export const KEY_RATE = { max: 60, window_ms: 60_000 } as const;
/** Unknown keys one address may present per window, as ingest allows. */
export const UNKNOWN_KEY_RATE = { name: "team-read-key-unknown", max: 30, window_ms: 10 * 60_000 } as const;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Window = { since: number; until: number };
type PageRequest = Window & { limit: number; cursor: string | null };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** Undefined when absent, null when unreadable. */
function timeParam(raw: string | null): number | undefined | null {
  if (!raw) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

// The page cursor is the window plus feedPagination's per-member cursor, as
// base64url JSON, so a client passes back one opaque string.
function encodeCursor(window: Window, feed: string): string {
  return btoa(JSON.stringify({ ...window, feed })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(raw: string): (Window & { feed: string }) | null {
  try {
    const c = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof c?.since === "number" && typeof c?.until === "number" && typeof c?.feed === "string" ? c : null;
  } catch {
    return null;
  }
}

function pageRequest(params: URLSearchParams, now: number): PageRequest | string {
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) return "limit takes a whole number from 1 to 100";
  const cursorRaw = params.get("cursor");
  if (cursorRaw) {
    const cursor = decodeCursor(cursorRaw);
    if (!cursor) return "cursor is not a next_cursor this endpoint gave";
    return { since: cursor.since, until: cursor.until, limit: Math.min(limit, MAX_LIMIT), cursor: cursor.feed };
  }
  const until = timeParam(params.get("until"));
  const since = timeParam(params.get("since"));
  if (until === null || since === null) return "since and until take ms since the epoch or an ISO 8601 time";
  const end = until ?? now;
  return { since: since ?? end - DEFAULT_WINDOW_MS, until: end, limit: Math.min(limit, MAX_LIMIT), cursor: null };
}

export const teamSessionsHttp = httpAction(async (ctx, request) => {
  const unknownKey = async () =>
    (await ipRateLimited(ctx, request, UNKNOWN_KEY_RATE.name, UNKNOWN_KEY_RATE.max, UNKNOWN_KEY_RATE.window_ms)) ??
    json(401, { error: "missing, unknown, revoked or expired key" });

  const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!key || !isTeamReadKey(key)) return await unknownKey();
  const page = pageRequest(new URL(request.url).searchParams, Date.now());
  if (typeof page === "string") return json(400, { error: page });

  const found: { key_id: Id<"team_read_keys">; use_due: boolean } | null = await ctx.runQuery(internal.teamReadKeys.keyForHash, {
    key_hash: await sha256Hex(key),
  });
  if (!found) return await unknownKey();
  const limited = await keyRateLimited(ctx, `team-read-key:${found.key_id}`, KEY_RATE.max, KEY_RATE.window_ms, true);
  if (limited) return limited;
  // Audit before the read: a use that cannot be recorded is not served.
  if (found.use_due) await ctx.runMutation(internal.teamReadKeys.recordUse, { key_id: found.key_id });

  const result: { sessions: TeamSessionRow[]; next_cursor: string | null } | null = await ctx.runQuery(
    internal.teamReadKeys.sessionsForKey,
    { key_id: found.key_id, ...page },
  );
  if (!result) return await unknownKey();
  const { since, until } = page;
  return json(200, { sessions: result.sessions, next_cursor: result.next_cursor && encodeCursor({ since, until }, result.next_cursor) });
});
