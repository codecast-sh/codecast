// Byte-level image cache engine — ONE implementation behind every image the
// app renders from a URL. Extracted from avatarCache (the original consumer)
// so chat attachments, transcript images and inbox thumbnails share it instead
// of re-fetching bytes the app has already seen.
//
// Why the browser's HTTP cache is not enough: it evicts big images under
// pressure, and the Convex storage endpoint answers with `Vary: origin` — an
// <img> (no-cors, no Origin header) and a fetch() (cors, Origin sent) are
// DIFFERENT cache entries, so nothing the app fetched deliberately helps the
// tag render. The Cache Storage API is deliberate: bytes stay until we prune
// them, survive reloads, and serve offline. No service worker needed.
//
// Each createByteCache() instance owns one named cache plus the session-scoped
// bookkeeping (dedup, waiters, failure verdicts). Policy differences between
// consumers are the options, not forks of the machinery.

import { useReducer } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";

export type ByteCacheOpts = {
  cacheName: string;
  /** Refresh stored bytes in the background when older than this. Omit when
   *  the bytes behind a URL are immutable (Convex storage): never revalidate. */
  revalidateMs?: number;
  /** How long a session-scoped failure verdict stands before a NEW consumer
   *  retries — so a boot-time offline blip heals without a reload. */
  retryFailedMs?: number;
  /** Cap on stored responses, pruned oldest-stored-first: a rolling window of
   *  recent history. Omit for unbounded (avatars: tiny and few). */
  maxEntries?: number;
  /** What useSrc hands back while the bytes resolve. "remote" paints the
   *  network URL immediately (fast first paint, tolerable double-fetch for
   *  tiny files); "wait" returns undefined until the verdict, so a large image
   *  is fetched exactly once, through the cache. */
  whileResolving: "remote" | "wait";
  /** After a failed fetch with no cached copy: "remote" hands back the network
   *  URL so the <img> can try (and report) itself; "none" returns undefined —
   *  the caller renders its fallback (avatar initials). */
  onFailed: "remote" | "none";
};

export type ByteCache = {
  /** Cache-first src for a URL: object URL when the bytes are local, per the
   *  instance's whileResolving/onFailed policy otherwise. */
  useSrc: (url: string | null | undefined) => string | undefined;
  /** Warm the cache for URLs likely to render soon — bytes only, no object
   *  URLs, bounded concurrency, deduped for the session. Best-effort. */
  prefetch: (urls: Array<string | null | undefined>) => void;
};

// ── Origins that refuse cross-origin reads ───────────────────────────────────
// An <img> renders any URL; fetch() needs the server's permission, so a CDN
// that sends no `access-control-allow-origin` cannot be byte-cached at all.
// Slack's avatar CDN is one (and Gravatar redirects to it whenever a Slack
// user has no Gravatar, so those URLs fail the same way). Before this,
// every such face fetched, failed, logged a CORS error, and rendered as
// initials — a real picture the browser was perfectly willing to show.
//
// So we remember which origins refuse, and hand those URLs straight to the
// <img>: the face renders, nothing is fetched, the console stays clean. The
// only thing lost is the local byte copy, which for a face is a nicety.
//
// The list is seeded with the ones we know, learned from any fetch REJECTION
// (a status code is a server answer, not a permission refusal), and re-tested
// weekly so a CDN that starts sending the header gets its cache back.
const OPAQUE_ORIGINS_KEY = "codecast:opaque-origins:v1";
const OPAQUE_RETEST_MS = 7 * 24 * 3600_000;
const SEEDED_OPAQUE_ORIGINS = ["https://avatars.slack-edge.com", "https://a.slack-edge.com"];

// origin -> when we learned it refuses. Seeds never expire.
const opaqueOrigins = new Map<string, number>();

function loadOpaqueOrigins(): void {
  for (const origin of SEEDED_OPAQUE_ORIGINS) opaqueOrigins.set(origin, Infinity);
  try {
    const raw = localStorage.getItem(OPAQUE_ORIGINS_KEY);
    if (!raw) return;
    const now = Date.now();
    for (const [origin, at] of Object.entries(JSON.parse(raw) as Record<string, number>)) {
      if (now - at < OPAQUE_RETEST_MS) opaqueOrigins.set(origin, at);
    }
  } catch {
    // No storage, or a shape we no longer understand: the seeds still stand.
  }
}
loadOpaqueOrigins();

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Record a fetch rejection as a permission refusal by this URL's origin. */
function markOpaque(url: string): void {
  // Offline rejects every fetch the same way; poisoning an origin over a
  // network blip would cost it its cache for a week.
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const origin = originOf(url);
  if (!origin || opaqueOrigins.has(origin)) return;
  opaqueOrigins.set(origin, Date.now());
  try {
    const stored: Record<string, number> = {};
    for (const [key, at] of opaqueOrigins) if (Number.isFinite(at)) stored[key] = at;
    localStorage.setItem(OPAQUE_ORIGINS_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked: the verdict still stands for this session.
  }
}

// Byte-caching needs the Cache Storage API (absent during SSR), an absolute
// http(s) URL — data:/blob: srcs pass through untouched — and an origin that
// permits cross-origin reads.
function canByteCache(url: string): boolean {
  if (typeof caches === "undefined" || !/^https?:\/\//.test(url)) return false;
  const origin = originOf(url);
  return !(origin && opaqueOrigins.has(origin));
}

/**
 * Fetch bytes cross-origin, reading a REJECTION as the origin refusing
 * permission. A status code (404, 403) is the server answering, so it leaves
 * the origin's standing alone — only this URL is dead.
 */
async function corsFetch(url: string): Promise<Response> {
  try {
    return await fetch(url, { mode: "cors" });
  } catch (err) {
    markOpaque(url);
    throw err;
  }
}

const PREFETCH_CONCURRENCY = 3;

export function createByteCache(opts: ByteCacheOpts): ByteCache {
  const { cacheName, revalidateMs, retryFailedMs = 60_000, maxEntries } = opts;

  // url -> object URL (bytes cached) | null (fetch failed, no cached copy).
  const memCache = new Map<string, string | null>();
  const failedAt = new Map<string, number>();
  const inflight = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();

  async function prune(cache: Cache): Promise<void> {
    if (!maxEntries) return;
    try {
      // Cache keys are insertion-ordered: deleting from the front evicts the
      // least recently STORED entries. An evicted image a surface still shows
      // just refetches on its next cold render — nothing breaks.
      const keys = await cache.keys();
      for (let i = 0; i < keys.length - maxEntries; i++) void cache.delete(keys[i]);
    } catch {
      // Losing a prune only means the cache runs a little over the cap.
    }
  }

  async function resolve(url: string): Promise<void> {
    let verdict: string | null = null;
    try {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(url);
      if (hit) {
        verdict = URL.createObjectURL(await hit.blob());
        // Stale-while-revalidate on the response's own Date header: serve the
        // local copy now, refresh the stored bytes in the background. A failed
        // refresh is ignored — the stale copy is the point.
        if (revalidateMs !== undefined) {
          const fetchedAt = Date.parse(hit.headers.get("date") ?? "") || 0;
          if (Date.now() - fetchedAt > revalidateMs) {
            void fetch(url, { mode: "cors" })
              .then((r) => (r.ok ? cache.put(url, r) : undefined))
              .catch(() => {});
          }
        }
      } else {
        const resp = await corsFetch(url);
        if (!resp.ok) throw new Error(String(resp.status));
        const forCache = resp.clone();
        verdict = URL.createObjectURL(await resp.blob());
        await cache.put(url, forCache);
        void prune(cache);
      }
    } catch {
      verdict = null; // No bytes anywhere: the caller's fallback policy decides.
    }
    memCache.set(url, verdict);
    if (verdict === null) failedAt.set(url, Date.now());
    const fns = waiters.get(url);
    waiters.delete(url);
    fns?.forEach((fn) => fn());
  }

  // ── Prefetch ──────────────────────────────────────────────────────────────
  // Bytes into Cache Storage only — no object URLs, so warming a history
  // window holds no blobs in memory. Session-deduped and concurrency-bounded
  // so a burst of resolved URLs never stampedes the backend.
  const prefetchQueue: string[] = [];
  const prefetchSeen = new Set<string>();
  let prefetchRunning = 0;

  async function prefetchOne(url: string): Promise<void> {
    try {
      const cache = await caches.open(cacheName);
      if (await cache.match(url)) return;
      const resp = await corsFetch(url);
      if (!resp.ok) return;
      await cache.put(url, resp);
      void prune(cache);
    } catch {
      // Best-effort: mount-time interest fetches for real if this mattered.
    }
  }

  function pump(): void {
    while (prefetchRunning < PREFETCH_CONCURRENCY && prefetchQueue.length) {
      const url = prefetchQueue.shift()!;
      // A mounted consumer is already resolving it — don't fetch twice.
      if (inflight.has(url) || memCache.has(url)) continue;
      prefetchRunning++;
      void prefetchOne(url).finally(() => {
        prefetchRunning--;
        pump();
      });
    }
  }

  function prefetch(urls: Array<string | null | undefined>): void {
    for (const url of urls) {
      if (!url || !canByteCache(url)) continue;
      if (prefetchSeen.has(url) || memCache.has(url) || inflight.has(url)) continue;
      prefetchSeen.add(url);
      prefetchQueue.push(url);
    }
    pump();
  }

  // ── Consumer hook ─────────────────────────────────────────────────────────
  function useSrc(url: string | null | undefined): string | undefined {
    const [, forceRender] = useReducer((c: number) => c + 1, 0);

    useWatchEffect(() => {
      if (!url || !canByteCache(url)) return;
      // A failure verdict is session-scoped, and a NEW consumer after the
      // retry window re-attempts it.
      if (
        memCache.get(url) === null &&
        Date.now() - (failedAt.get(url) ?? 0) > retryFailedMs
      ) {
        memCache.delete(url);
      }
      if (memCache.has(url)) return;
      let live = true;
      let set = waiters.get(url);
      if (!set) waiters.set(url, (set = new Set()));
      const wake = () => {
        if (live) forceRender();
      };
      set.add(wake);
      if (!inflight.has(url)) {
        inflight.add(url);
        void resolve(url).finally(() => inflight.delete(url));
      }
      return () => {
        live = false;
        set!.delete(wake);
        if (set!.size === 0) waiters.delete(url);
      };
    }, [url]);

    if (!url) return undefined;
    if (!canByteCache(url)) return url;
    const entry = memCache.get(url);
    if (entry === undefined) return opts.whileResolving === "remote" ? url : undefined;
    if (entry === null) return opts.onFailed === "remote" ? url : undefined;
    return entry;
  }

  return { useSrc, prefetch };
}

/**
 * The app-wide byte cache for CONTENT images — chat attachments, transcript
 * images, inbox thumbnails. Convex storage bytes are immutable, so there is no
 * revalidation; the entry cap keeps "a reasonable amount of history" local
 * (recent chat + recently opened sessions) without growing unbounded.
 * "wait" + "remote": a content image is fetched once, through the cache, and a
 * fetch failure still hands the <img> the network URL to try itself.
 */
export const imageBytes = createByteCache({
  cacheName: "codecast:images:v1",
  maxEntries: 500,
  whileResolving: "wait",
  onFailed: "remote",
});
