// Byte-level cache for profile pictures — the remote-URL sibling of
// useStorageImageUrl (which caches Convex storage id → URL mappings; here the
// URL is known and the BYTES are the fragile part).
//
// Why this exists: avatars are remote CDN URLs (avatars.githubusercontent.com,
// lh3.googleusercontent.com). Every surface rendered them as a raw <img>, so a
// CDN rate limit, a network blip, or an expired Google photo URL painted the
// browser's broken-image glyph across the whole team bar. Both CDNs serve
// `access-control-allow-origin: *`, so we can fetch the bytes once, keep them
// in the Cache Storage API (persistent across reloads, no service worker
// needed), and serve every render from the local copy. A face seen once
// renders forever, CDN up or not.
//
// Semantics of useAvatarSrc(url):
//   - returns a src to render (cached object URL when available, else the
//     remote URL while the cache resolves), or undefined when the URL is
//     absent or known-dead — the caller renders its initials fallback.
//   - resolution is deduped app-wide: N mounted avatars of one teammate cost
//     one fetch, and at most one revalidation per REVALIDATE_MS thereafter.
// <AvatarImg> wraps the hook plus an onError fallback so no consumer can ever
// show the broken glyph.

import * as React from "react";
import { useReducer, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";

const CACHE_NAME = "codecast:avatars:v1";
const REVALIDATE_MS = 24 * 3600_000;
const RETRY_FAILED_MS = 60_000;

// url -> object URL (bytes cached) | null (fetch failed, no cached copy).
const memCache = new Map<string, string | null>();
const failedAt = new Map<string, number>();
const inflight = new Set<string>();
const waiters = new Map<string, Set<() => void>>();

// Byte-caching needs the Cache Storage API (absent during SSR) and an absolute
// http(s) URL — data:/blob: srcs pass through untouched.
function canByteCache(url: string): boolean {
  return typeof caches !== "undefined" && /^https?:\/\//.test(url);
}

async function resolve(url: string): Promise<void> {
  let verdict: string | null = null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      verdict = URL.createObjectURL(await hit.blob());
      // Stale-while-revalidate on the response's own Date header: serve the
      // local copy now, refresh the stored bytes in the background at most
      // once a day. A failed refresh is ignored — the stale face is the point.
      const fetchedAt = Date.parse(hit.headers.get("date") ?? "") || 0;
      if (Date.now() - fetchedAt > REVALIDATE_MS) {
        void fetch(url, { mode: "cors" })
          .then((r) => (r.ok ? cache.put(url, r) : undefined))
          .catch(() => {});
      }
    } else {
      const resp = await fetch(url, { mode: "cors" });
      if (!resp.ok) throw new Error(String(resp.status));
      const forCache = resp.clone();
      verdict = URL.createObjectURL(await resp.blob());
      await cache.put(url, forCache);
    }
  } catch {
    verdict = null; // No bytes anywhere: the caller renders initials.
  }
  memCache.set(url, verdict);
  if (verdict === null) failedAt.set(url, Date.now());
  const fns = waiters.get(url);
  waiters.delete(url);
  fns?.forEach((fn) => fn());
}

/**
 * Cache-first src for a remote avatar URL.
 * string = render it (cached object URL, or the remote URL while resolving),
 * undefined = nothing renderable (no URL / known-dead) — show initials.
 */
export function useAvatarSrc(url: string | null | undefined): string | undefined {
  const [, forceRender] = useReducer((c: number) => c + 1, 0);

  useWatchEffect(() => {
    if (!url || !canByteCache(url)) return;
    // A failure verdict is session-scoped, and a NEW consumer after a minute
    // retries it — so a boot-time offline blip heals without a reload.
    if (
      memCache.get(url) === null &&
      Date.now() - (failedAt.get(url) ?? 0) > RETRY_FAILED_MS
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
  if (entry === undefined) return url; // resolving — same markup as SSR/today
  return entry ?? undefined;
}

/**
 * Drop-in replacement for an avatar <img>: same props, plus `fallback` —
 * rendered instead of the image when the URL is absent or the bytes are
 * unreachable. The browser's broken-image glyph is unrepresentable here.
 */
export function AvatarImg({
  src,
  fallback = null,
  alt = "",
  ...imgProps
}: {
  src: string | null | undefined;
  fallback?: React.ReactNode;
} & Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src">) {
  const resolved = useAvatarSrc(src);
  // Derived, not effect-reset: a NEW resolution (e.g. the cached copy landing
  // after a CDN error) compares unequal to the errored src, so it gets a fresh
  // chance to render automatically.
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  if (!resolved || erroredSrc === resolved) return <>{fallback}</>;
  return <img src={resolved} alt={alt} {...imgProps} onError={() => setErroredSrc(resolved)} />;
}
