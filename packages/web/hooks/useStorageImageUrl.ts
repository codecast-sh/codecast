// Resolve a Convex storage id to its serving URL — cached across mounts and
// batched across images.
//
// Why this exists: every <ImageBlock> used to call useQuery(getImageUrl) on its
// own. That meant one live subscription AND one backend round-trip PER image,
// and because the message list is virtualized, scrolling an image off and back
// REMOUNTED the component — re-subscribing, re-fetching the URL, and flashing
// "Loading image…" every time. On a busy single-node backend that round-trip is
// exactly the felt latency.
//
// The storage id -> URL mapping is immutable (self-hosted Convex serves a stable
// /api/storage/<uuid> path, no expiry), so we can cache it forever in a
// module-level map that survives remounts, and resolve cache misses with ONE
// batched getImageUrls query per tick instead of N separate subscriptions.

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

// Batched resolution queue.
const pendingIds = new Set<string>();
const waiters = new Map<string, Set<() => void>>();
let flushScheduled = false;
const RETRY_DELAY_MS = 1500;

function scheduleFlush(convex: ReturnType<typeof useConvex>, delayMs = 0) {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = async () => {
    flushScheduled = false;
    const ids = [...pendingIds];
    pendingIds.clear();
    if (ids.length === 0) return;
    try {
      const urls: Record<string, string | null> = await convex.query(api.images.getImageUrls, {
        storageIds: ids,
      });
      for (const id of ids) urlCache.set(id, urls[id] ?? null);
      for (const id of ids) {
        const fns = waiters.get(id);
        waiters.delete(id);
        fns?.forEach((fn) => fn());
      }
    } catch {
      // Transient failure (backend blip / deploy): do NOT cache or fire waiters.
      // Re-queue ids that still have a mounted consumer and retry on a delay, so
      // the image self-heals instead of sticking on "Loading…" forever (the
      // effect's deps don't change, so nothing else re-triggers resolution).
      let anyLive = false;
      for (const id of ids) {
        if (waiters.get(id)?.size) {
          pendingIds.add(id);
          anyLive = true;
        }
      }
      if (anyLive) scheduleFlush(convex, RETRY_DELAY_MS);
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
