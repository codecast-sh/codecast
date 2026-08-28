// Byte-level cache for profile pictures — an instance of the shared
// imageByteCache engine (which started life here; the mechanics — Cache
// Storage bytes, session dedup, waiters, failure verdicts — now live there so
// chat attachments and transcript images share them).
//
// Why this exists: avatars are remote CDN URLs (avatars.githubusercontent.com,
// lh3.googleusercontent.com). Every surface rendered them as a raw <img>, so a
// CDN rate limit, a network blip, or an expired Google photo URL painted the
// browser's broken-image glyph across the whole team bar. Both CDNs serve
// `access-control-allow-origin: *`, so we fetch the bytes once, keep them in
// the Cache Storage API (persistent across reloads, no service worker needed),
// and serve every render from the local copy. A face seen once renders
// forever, CDN up or not.
//
// Policy: "remote" while resolving (a face is tiny — paint the CDN URL
// immediately, same markup as SSR), daily revalidation (a profile photo CAN
// change behind its URL), no entry cap (a roster of faces is small), and no
// remote fallback on failure — the caller renders its initials instead of the
// broken glyph.
//
// Semantics of useAvatarSrc(url):
//   - returns a src to render (cached object URL when available, else the
//     remote URL while the cache resolves), or undefined when the URL is
//     absent or known-dead — the caller renders its initials fallback.
//   - resolution is deduped app-wide: N mounted avatars of one teammate cost
//     one fetch, and at most one revalidation per day thereafter.
// <AvatarImg> wraps the hook plus an onError fallback so no consumer can ever
// show the broken glyph.

import * as React from "react";
import { useState } from "react";
import { createByteCache } from "./imageByteCache";

const avatarBytes = createByteCache({
  cacheName: "codecast:avatars:v1",
  revalidateMs: 24 * 3600_000,
  whileResolving: "remote",
  onFailed: "none",
});

/**
 * Cache-first src for a remote avatar URL.
 * string = render it (cached object URL, or the remote URL while resolving),
 * undefined = nothing renderable (no URL / known-dead) — show initials.
 */
export function useAvatarSrc(url: string | null | undefined): string | undefined {
  return avatarBytes.useSrc(url);
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
