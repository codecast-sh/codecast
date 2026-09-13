"use client";
// A page in an iframe. The default backend, and the only one that works in
// every environment.
//
// No `sandbox` attribute: a foreign origin is already isolated by the browser,
// and sandboxing it would break sites that expect a normal origin (storage,
// popups, their own frames). `referrerpolicy="no-referrer"` keeps the pane's
// URL out of the site's logs, and `allow` grants clipboard only.
//
// ── What the pane can and cannot know about what it shows ──────────────────
//
// Measured in Chrome 2026-09-13, framing four addresses from
// https://local.codecast.sh and probing every signal available to the parent:
//
//   address                 load event   contentDocument   window.length
//   localhost:8765 (serves)   fires        null              0
//   github.com (refuses)      fires        null              0
//   localhost:9911 (dead)     fires        null              0
//   same-origin app page      fires        readable          0
//
// So a cross-origin frame reports NOTHING, whether it painted the site, was
// refused by X-Frame-Options, or hit a dead port. Load timing does not
// separate them either: the refusal took 4.5s (the server really answered)
// while the working local page took 29ms. Resource timing logs no entry for an
// iframe navigation at all. There is no client-side signal for "this site
// refused to be framed" — so this backend never claims one. Accusing a site
// that actually loaded is a worse failure than staying quiet, and the pane
// offers the refusal card as a user gesture instead (BrowserPane).
//
// What IS provable is whether anything answered at all. `fetch(url, {mode:
// "no-cors"})` rejects in ~2ms for a dead loopback port and ~100ms for a host
// that does not resolve, and resolves opaquely when a server answered — and
// Chrome allows that request to http://localhost from an https page, the same
// loopback exemption that lets the frame itself load. That is what powers the
// "nothing is listening" state, and it is the only claim this backend makes
// beyond "it loaded".

import { useCallback, useEffect, useRef } from "react";
import { isLoopbackUrl } from "../../../lib/browserPane";
import type { BackendProps } from "./types";

/** An http address under an https app: Chrome blocks the frame outright, and
 *  loopback is the one exception it makes. */
function blockedAsMixedContent(url: string): boolean {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:" && url.startsWith("http://") && !isLoopbackUrl(url);
}

export function FrameBackend({ source, reloadToken, onTitle, onUrl, onState }: BackendProps) {
  const url = source.kind === "url" ? source.url : "";
  const frameRef = useRef<HTMLIFrameElement>(null);
  // A dead address still fires `load` (Chrome commits its own error page), and
  // it fires FAST — 8ms against the probe's 2ms, so the two race. The probe is
  // proof and the load event is not, so once nothing has answered, the load
  // event may no longer claim the pane is showing a page.
  const nothingAnswered = useRef(false);

  useEffect(() => {
    if (!url) return;
    onTitle(null);
    if (blockedAsMixedContent(url)) {
      onState({ kind: "blocked", reason: "insecure" });
      return;
    }
    onState({ kind: "loading" });
    nothingAnswered.current = false;
    let live = true;
    // Runs beside the frame, not before it: the frame starts loading on the
    // same tick either way, and the probe only ever adds the honest
    // "nothing answered" state on top.
    void fetch(url, { mode: "no-cors", cache: "no-store", credentials: "omit" })
      .catch(() => {
        if (!live) return;
        nothingAnswered.current = true;
        onState({ kind: "unreachable", loopback: isLoopbackUrl(url) });
      });
    return () => {
      live = false;
    };
  }, [url, reloadToken, onTitle, onState]);

  const handleLoad = useCallback(() => {
    if (nothingAnswered.current) return;
    let doc: Document | null = null;
    try {
      doc = frameRef.current?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) {
      // Cross-origin: it committed something, and that is all we get.
      onState({ kind: "ready", opaque: true });
      return;
    }
    onTitle(doc.title || null);
    try {
      const href = frameRef.current?.contentWindow?.location.href;
      if (href && href !== "about:blank") onUrl(href);
    } catch {
      // Navigated away to another origin between the read and here.
    }
    onState({ kind: "ready", opaque: false });
  }, [onTitle, onUrl, onState]);

  if (!url || blockedAsMixedContent(url)) return null;

  return (
    <iframe
      // The key is what makes a reload a reload: same src, new element.
      key={`${url}#${reloadToken}`}
      ref={frameRef}
      src={url}
      onLoad={handleLoad}
      title={url}
      referrerPolicy="no-referrer"
      allow="clipboard-read; clipboard-write"
      className="w-full h-full border-0 bg-white"
    />
  );
}
