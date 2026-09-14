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
// What IS provable is whether anything answered at all: a no-cors request
// rejects in ~2ms for a dead loopback port and ~100ms for a host that does not
// resolve, and resolves opaquely when a server answered (probeAddress in
// lib/browserPane). That powers the "nothing is listening" state, and the
// "Chrome blocked the local network" state beside it, and they are the only
// claims this backend makes beyond "it loaded".
//
// Ordering rule: a dead address still fires `load` (Chrome commits its own
// error page), and it can fire before the probe settles. The probe is proof
// and the load event is not, so once nothing has answered, the load event may
// no longer claim the pane is showing a page.

import { useCallback, useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { useEventListener } from "../../../hooks/useEventListener";
import {
  isLoopbackUrl,
  paneSrc,
  probeAddress,
  readPaneMessage,
  withoutEmbedFlag,
} from "../../../lib/browserPane";
import { openBrowserPane } from "../../../lib/stage";
import { openIn } from "../../../lib/openIntent";
import type { BackendProps } from "./types";

/** How often a pane with nothing behind it asks again. A dev server that is
 *  down is usually a dev server about to come up, and the pane should flip to
 *  the page on its own when it does. */
const UNREACHABLE_POLL_MS = 3000;

/** An http address under an https app: Chrome blocks the frame outright, and
 *  loopback is the one exception it makes. */
function blockedAsMixedContent(url: string): boolean {
  if (typeof window === "undefined") return false;
  return window.location.protocol === "https:" && url.startsWith("http://") && !isLoopbackUrl(url);
}

export function FrameBackend({ source, reloadToken, onTitle, onUrl, onState }: BackendProps) {
  const url = source.kind === "url" ? source.url : "";
  const frameRef = useRef<HTMLIFrameElement>(null);
  const nothingAnswered = useRef(false);
  const titleWatch = useRef<MutationObserver | null>(null);
  // Nothing answered, so a poll is asking again. `revival` is bumped when one
  // finds a server: it remounts the frame exactly as a reload would.
  const [polling, setPolling] = useState(false);
  const [revival, setRevival] = useState(0);
  // The pane's callbacks, read when they are called rather than listed as
  // dependencies. The probe is keyed on the ADDRESS: keyed on the callbacks
  // too, it would depend on every parent memoizing them, and one that did not
  // would loop — the probe reports, the parent re-renders with fresh callbacks,
  // the probe runs again, one network request per render.
  const report = useRef({ onTitle, onUrl, onState });
  report.current = { onTitle, onUrl, onState };

  useWatchEffect(() => {
    if (!url) return;
    const { onTitle, onState } = report.current;
    onTitle(null);
    setPolling(false);
    if (blockedAsMixedContent(url)) {
      onState({ kind: "blocked", reason: "insecure" });
      return;
    }
    onState({ kind: "loading" });
    nothingAnswered.current = false;
    let live = true;
    // Runs beside the frame, not before it: the frame starts loading on the
    // same tick either way, and the probe only ever adds an honest verdict.
    void probeAddress(url).then((verdict) => {
      if (!live || verdict === "answered") return;
      nothingAnswered.current = true;
      if (verdict === "local-network-blocked") {
        report.current.onState({ kind: "blocked", reason: "local-network" });
      } else {
        report.current.onState({ kind: "unreachable", loopback: isLoopbackUrl(url) });
        setPolling(true);
      }
    });
    return () => {
      live = false;
    };
  }, [url, reloadToken, revival]);

  // Ask again every few seconds while the window is visible. A hidden window
  // waits for visibilitychange instead of probing a port nobody is looking at.
  useWatchEffect(() => {
    if (!polling || !url) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let asking = false;
    const schedule = () => {
      if (!live || timer || asking || document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        timer = undefined;
        if (document.visibilityState !== "visible") return;
        asking = true;
        void probeAddress(url).then((verdict) => {
          asking = false;
          if (!live) return;
          if (verdict === "answered") setRevival((n) => n + 1);
          else schedule();
        });
      }, UNREACHABLE_POLL_MS);
    };
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [polling, url]);

  useMountEffect(() => () => titleWatch.current?.disconnect());

  // A codecast page in this frame has no stage, so its pane gestures arrive
  // here and land on this window's stage (postToPaneHost in lib/browserPane).
  useEventListener("message", (event) => {
    const message = readPaneMessage(event, frameRef.current?.contentWindow);
    if (!message) return;
    if (message.type === "codecast:open-pane") openBrowserPane(message.source);
    else openIn("split", message.path);
  });

  const handleLoad = useCallback(() => {
    const { onTitle, onUrl, onState } = report.current;
    titleWatch.current?.disconnect();
    titleWatch.current = null;
    if (nothingAnswered.current) return;
    const frame = frameRef.current;
    let doc: Document | null = null;
    try {
      doc = frame?.contentDocument ?? null;
    } catch {
      doc = null;
    }
    if (!doc) {
      // Cross-origin: it committed something, and that is all we get.
      onState({ kind: "ready", opaque: true });
      return;
    }
    // A same-origin single page app retitles itself without loading again, so
    // the title is watched for as long as this document lives.
    const readable = doc;
    let title = readable.title;
    onTitle(title || null);
    const watch = new MutationObserver(() => {
      if (readable.title === title) return;
      title = readable.title;
      report.current.onTitle(title || null);
    });
    // The head when there is one, since that is where the title lives; the
    // document itself otherwise, so a head that arrives later is still seen.
    watch.observe(readable.head ?? readable, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    titleWatch.current = watch;
    frame?.contentWindow?.addEventListener("pagehide", () => watch.disconnect(), { once: true });
    try {
      // Without the flag: it is how the pane asked this page to render, not
      // part of the address the reader is looking at.
      const href = frame?.contentWindow?.location.href;
      if (href && href !== "about:blank") onUrl(withoutEmbedFlag(href));
    } catch {
      // Navigated away to another origin between the read and here.
    }
    onState({ kind: "ready", opaque: false });
  }, []);

  if (!url || blockedAsMixedContent(url)) return null;

  return (
    <iframe
      // The key is what makes a reload a reload: same src, new element.
      key={`${url}#${reloadToken}#${revival}`}
      ref={frameRef}
      // Not `url`: a codecast route is asked to render as a pane's page
      // rather than as the whole app (paneSrc in lib/browserPane).
      src={paneSrc(url)}
      onLoad={handleLoad}
      title={url}
      referrerPolicy="no-referrer"
      allow="clipboard-read; clipboard-write"
      className="w-full h-full border-0 bg-white"
    />
  );
}
