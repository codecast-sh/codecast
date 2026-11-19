// GET /cli/v1/team/sessions: a server reads its team's shared session
// metadata with a team read key (teamReadKeys.ts), sent as
// `Authorization: Bearer cc_trk_...`. Under /cli/ so the Caddy proxies that
// forward /cli/* already reach it.
//
// Query: `since` and `until` (ms since the epoch or ISO 8601; the last 24
// hours by default), `limit` (50 by default, at most 100) and `cursor` (the
// previous page's next_cursor, which carries that page's window). Pages come
// strictly newest first. A page can hold fewer than `limit` sessions while
// next_cursor is set; keep paging until it is null.
//
// Admission runs in ingest's order: an address over its unknown-key window is
// refused before any lookup, every unknown or malformed key counts against it,
// and a known key is charged before its parameters are read. Both limiters
// fail closed. A page that stops partway through skipped rows resumes at the
// last row it examined, which can be a private one, so the cursor is sealed with
// AES-GCM under the key's own secret: it shows no timestamp, and only that key
// can use it.
//
// Answers 200 { sessions, next_cursor }; 400 for a bad parameter or cursor;
// 401 for a missing, unknown, revoked or expired key; 429 over a limit.
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { FoundKey, TeamSessionRow } from "../teamReadKeys";
import type { StreamPosition } from "../feedPagination";
import { clientIp, keyRateLimited } from "./httpRateLimit";
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
type PageRequest = Window & { limit: number; after: StreamPosition | null };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

/** Undefined when absent, null when unreadable. */
function timeParam(raw: string | null): number | undefined | null {
  if (!raw) return undefined;
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64 = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
const cursorKey = (secret: string) => crypto.subtle.importKey("raw", fromBase64(secret), "AES-GCM", false, ["encrypt", "decrypt"]);

async function sealCursor(secret: string, state: Window & StreamPosition): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cursorKey(secret), new TextEncoder().encode(JSON.stringify(state)));
  return toBase64Url(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

/** The window and position a cursor sealed, or null for anything this key did not seal. */
async function openCursor(secret: string, raw: string): Promise<(Window & StreamPosition) | null> {
  try {
    const bytes = fromBase64(raw);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cursorKey(secret), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

async function pageRequest(params: URLSearchParams, now: number, secret: string): Promise<PageRequest | string> {
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1) return "limit takes a whole number from 1 to 100";
  const cursorRaw = params.get("cursor");
  if (cursorRaw) {
    const cursor = await openCursor(secret, cursorRaw);
    if (!cursor) return "cursor is not a next_cursor this key was given";
    return { since: cursor.since, until: cursor.until, limit: Math.min(limit, MAX_LIMIT), after: { t: cursor.t, c: cursor.c } };
  }
  const until = timeParam(params.get("until"));
  const since = timeParam(params.get("since"));
  if (until === null || since === null) return "since and until take ms since the epoch or an ISO 8601 time";
  const end = until ?? now;
  return { since: since ?? end - DEFAULT_WINDOW_MS, until: end, limit: Math.min(limit, MAX_LIMIT), after: null };
}

export const teamSessionsHttp = httpAction(async (ctx, request) => {
  const guard = { key: `${UNKNOWN_KEY_RATE.name}:${clientIp(request)}`, max: UNKNOWN_KEY_RATE.max, window_ms: UNKNOWN_KEY_RATE.window_ms };
  const unknownKey = async () =>
    (await keyRateLimited(ctx, guard.key, guard.max, guard.window_ms, true)) ?? json(401, { error: "missing, unknown, revoked or expired key" });

  const presented = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!presented || !isTeamReadKey(presented)) return await unknownKey();
  const found: FoundKey | { retry_after_ms: number } | null = await ctx.runQuery(internal.teamReadKeys.keyForHash, {
    key_hash: await sha256Hex(presented),
    guess_guard: guard,
  });
  if (found && "retry_after_ms" in found) {
    return json(429, { error: "Too many requests" }, { "Retry-After": String(Math.ceil(found.retry_after_ms / 1000)) });
  }
  if (!found) return await unknownKey();
  const limited = await keyRateLimited(ctx, `team-read-key:${found.key_id}`, KEY_RATE.max, KEY_RATE.window_ms, true);
  if (limited) return limited;

  const page = await pageRequest(new URL(request.url).searchParams, Date.now(), found.cursor_secret);
  if (typeof page === "string") return json(400, { error: page });
  // Audit before the read: a use that cannot be recorded is not served.
  if (found.use_due) await ctx.runMutation(internal.teamReadKeys.recordUse, { key_id: found.key_id });

  const result: { sessions: TeamSessionRow[]; next: StreamPosition | null } | null = await ctx.runQuery(
    internal.teamReadKeys.sessionsForKey,
    { key_id: found.key_id, since: page.since, until: page.until, limit: page.limit, after: page.after },
  );
  if (!result) return await unknownKey();
  const next = result.next && (await sealCursor(found.cursor_secret, { since: page.since, until: page.until, ...result.next }));
  return json(200, { sessions: result.sessions, next_cursor: next });
});
