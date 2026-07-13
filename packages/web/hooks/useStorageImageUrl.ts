// Resolve a Convex storage id to its serving URL — cached across mounts AND
// reloads, batched across images, and prefetchable before mount.
//
// Why this exists: every <ImageBlock> used to call useQuery(getImageUrl) on its
// own. That meant one live subscription AND one backend round-trip PER image,
// and because the message list is virtualized, scrolling an image off and back
// REMOUNTED the component — re-subscribing, re-fetching the URL, and flashing
// "Loading image…" every time. On a busy single-node backend that round-trip is
// exactly the felt latency.
//
// The storage id -> URL mapping is immutable (self-hosted Convex serves a stable
// /api/storage/<uuid> path, no expiry), so we cache it in a module-level map
// that survives remounts, mirror the resolved entries to localStorage so a
// reload starts warm (no round-trip at all for any image seen before), and
// resolve cache misses with ONE batched getImageUrls query per tick instead of
// N separate subscriptions. `prefetchStorageImageUrls` lets the message hook
// enqueue ids the moment messages arrive, before any ImageBlock mounts.

import { useConvex } from "convex/react";
import { useEffect, useReducer } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;

// storageId -> resolved URL (string) or null (storage object missing).
const urlCache = new Map<string, string | null>();
// Srcs the browser has already decoded once — lets a remount skip the
// "Loading…" overlay instead of flashing it while the (HTTP-cached) image
// re-decodes.
const loadedSrcs = new Set<string>();

// ── Persistence ──────────────────────────────────────────────────────────────
// Only resolved string URLs are persisted — never null (a "missing" verdict
// could be a transient auth/backend condition; re-verify each session).
const PERSIST_KEY = "codecast:imageUrls:v1";
const PERSIST_MAX = 800;

try {
  const raw = typeof localStorage !== "undefined" ? localStorage.getItem(PERSIST_KEY) : null;
  if (raw) {
    const entries = JSON.parse(raw);
    if (entries && typeof entries === "object") {
      for (const [id, url] of Object.entries(entries)) {
        if (typeof url === "string") urlCache.set(id, url);
      }
    }
  }
} catch {
  // Corrupt or unavailable storage: start cold, same as before persistence.
}

let persistScheduled = false;
function schedulePersist() {
  if (persistScheduled) return;
  persistScheduled = true;
  setTimeout(() => {
    persistScheduled = false;
    try {
      if (typeof localStorage === "undefined") return;
      const entries = [...urlCache].filter(([, url]) => typeof url === "string");
      // Map iteration is insertion order (persisted-oldest first), so slicing
      // from the end keeps the most recently resolved ids under the cap.
      localStorage.setItem(PERSIST_KEY, JSON.stringify(Object.fromEntries(entries.slice(-PERSIST_MAX))));
    } catch {
      // Quota exceeded / private mode: in-memory cache still works.
    }
  }, 1000);
}

// ── Batched resolution queue ─────────────────────────────────────────────────
const pendingIds = new Set<string>();
const waiters = new Map<string, Set<() => void>>();
let flushScheduled = false;
const RETRY_DELAY_MS = 1500;

// Re-queue ids that still have a mounted consumer and retry on a delay, so an
// image self-heals instead of sticking on "Loading…" forever (the hook effect's
// deps don't change, so nothing else re-triggers resolution). Prefetched ids
// with no waiters are dropped — mount-time interest re-queues them anyway.
function requeueLiveIds(convex: ReturnType<typeof useConvex>, ids: string[]) {
  let anyLive = false;
  for (const id of ids) {
    if (waiters.get(id)?.size) {
      pendingIds.add(id);
      anyLive = true;
    }
  }
  if (anyLive) scheduleFlush(convex, RETRY_DELAY_MS);
}

function scheduleFlush(convex: ReturnType<typeof useConvex>, delayMs = 0) {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = async () => {
    flushScheduled = false;
    const ids = [...pendingIds];
    pendingIds.clear();
    if (ids.length === 0) return;
    try {
      const urls: Record<string, string | null> | null = await convex.query(api.images.getImageUrls, {
        storageIds: ids,
      });
      const unresolved: string[] = [];
      for (const id of ids) {
        const url = urls?.[id];
        // Absent from the response (the server answers null when the caller
        // isn't authenticated yet, e.g. during boot): NOT a "missing image"
        // verdict. Caching null here would silently hide the image for the
        // whole session — treat it as transient instead.
        if (url === undefined) {
          unresolved.push(id);
          continue;
        }
        urlCache.set(id, url);
        const fns = waiters.get(id);
        waiters.delete(id);
        fns?.forEach((fn) => fn());
      }
      schedulePersist();
      requeueLiveIds(convex, unresolved);
    } catch {
      // Transient failure (backend blip / deploy): do NOT cache or fire waiters.
      requeueLiveIds(convex, ids);
    }
  };
  if (delayMs > 0) setTimeout(run, delayMs);
  else queueMicrotask(run);
}

// Register interest in a storage id. Returns an unsubscribe that drops this
// waiter on unmount — so a failed-then-retrying id with no consumers left stops
// retrying instead of looping forever.
function requestUrl(
  convex: ReturnType<typeof useConvex>,
  storageId: string,
  onResolved: () => void
): () => void {
  if (urlCache.has(storageId)) {
    onResolved();
    return () => {};
  }
  pendingIds.add(storageId);
  let set = waiters.get(storageId);
  if (!set) {
    set = new Set();
    waiters.set(storageId, set);
  }
  set.add(onResolved);
  scheduleFlush(convex);
  return () => {
    set!.delete(onResolved);
    if (set!.size === 0) waiters.delete(storageId);
  };
}

// Resolve ids ahead of render — called when a conversation's messages arrive,
// BEFORE the virtualized ImageBlocks mount — so the URL is already cached by
// the time an image scrolls into view and the placeholder never waits on the
// id→URL round-trip. Best-effort: no waiters, so a transient failure is
// dropped and mount-time interest retries it.
export function prefetchStorageImageUrls(
  convex: ReturnType<typeof useConvex>,
  storageIds: Array<string | undefined | null>
) {
  let queued = false;
  for (const id of storageIds) {
    if (!id || urlCache.has(id) || pendingIds.has(id)) continue;
    pendingIds.add(id);
    queued = true;
  }
  if (queued) scheduleFlush(convex);
}

/**
 * Returns the serving URL for a storage id:
 *   undefined = still resolving, null = missing, string = URL.
 * Cached results are returned synchronously on first render (no flash on
 * remount), cache misses resolve via a single batched query.
 */
export function useStorageImageUrl(storageId: string | undefined | null): string | null | undefined {
  const convex = useConvex();
  const [, forceRender] = useReducer((c: number) => c + 1, 0);

  useEffect(() => {
    if (!storageId || urlCache.has(storageId)) return;
    let cancelled = false;
    const unsubscribe = requestUrl(convex, storageId, () => {
      if (!cancelled) forceRender();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [storageId, convex]);

  if (!storageId) return undefined;
  if (urlCache.has(storageId)) return urlCache.get(storageId)!;
  return undefined;
}

export function hasDecodedSrc(src: string | undefined): boolean {
  return !!src && loadedSrcs.has(src);
}

export function markSrcDecoded(src: string | undefined) {
  if (src) loadedSrcs.add(src);
}
