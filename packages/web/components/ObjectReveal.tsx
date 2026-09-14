"use client";
// The inline reveal: a rich object reference (a pill in prose, a shared-object
// card) opens its FULL page right here in the conversation — a full-bleed band
// on a crosshatch ground, spanning the whole scrolling surface, with the
// object's real page inside. Reading the object no longer means leaving.
//
// Two halves. RevealHost wraps a rendered markdown body and owns which
// references are open; it renders its children untouched (a fragment, so a
// message body's blocks stay direct children of their container) and appends
// one band per open reference. useRevealHost is what a pill or card calls to
// toggle itself; a surface with no host renders no reveal affordance.
//
// The band renders the page through the same pane renderer the split stage
// uses (RoutePane for a route, SessionPane for a conversation), so what opens
// here IS the page — same component, same in-pane navigation — never a second
// rendering of the object to keep in step.

import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, PanelBottomClose, PanelBottomOpen } from "lucide-react";
import { RoutePane } from "./RoutePane";
import { SessionPane } from "./stage/SessionPane";
import { PaneControls } from "./stage/PaneControls";
import { PageIcon } from "./RecentVisitRow";
import { ErrorBoundary } from "./ErrorBoundary";
import { useTabContext } from "../lib/tabParams";
import { paneSessionId } from "../lib/stage";
import { cssZoomOf } from "../lib/cssZoom";
import { RevealHostCtx, useRevealHost, type RevealTarget } from "../lib/revealHost";

export type { RevealTarget } from "../lib/revealHost";

// Open reveals by host key, surviving the host's unmount: the transcript
// virtualizer recycles rows scrolled far away, and a band the reader opened
// must still be there when they scroll back. Bounded so a long-lived tab
// stays bounded; an entry is dropped once its last band closes.
const OPEN_BY_KEY = new Map<string, Map<string, RevealTarget>>();
const OPEN_BY_KEY_MAX = 200;

export function RevealHost({ children, persistKey }: { children: React.ReactNode; persistKey?: string }) {
  // Insertion-ordered by href: a second reveal opens below the first.
  const [open, setOpen] = useState<Map<string, RevealTarget>>(
    () => (persistKey && OPEN_BY_KEY.get(persistKey)) || new Map(),
  );
  const toggle = useCallback((target: RevealTarget) => {
    setOpen((prev) => {
      const next = new Map(prev);
      if (next.has(target.href)) next.delete(target.href);
      else next.set(target.href, target);
      if (persistKey) {
        OPEN_BY_KEY.delete(persistKey);
        if (next.size > 0) {
          OPEN_BY_KEY.set(persistKey, next);
          if (OPEN_BY_KEY.size > OPEN_BY_KEY_MAX) OPEN_BY_KEY.delete(OPEN_BY_KEY.keys().next().value!);
        }
      }
      return next;
    });
  }, [persistKey]);
  const isOpen = useCallback((href: string) => open.has(href), [open]);
  const value = useMemo(() => ({ toggle, isOpen }), [toggle, isOpen]);
  return (
    <RevealHostCtx.Provider value={value}>
      {children}
      {[...open.values()].map((target) => (
        <RevealBand key={target.href} target={target} onClose={() => toggle(target)} />
      ))}
    </RevealHostCtx.Provider>
  );
}

/**
 * The ONE control a reference shows for its full page: it opens the band,
 * and the same button closes it — icon and label flip with the state, so
 * the reader never hunts for a second control. Renders nothing without a
 * host. Stops propagation so a card's own expand toggle never fires with it.
 */
export function RevealButton({
  target,
  className = "",
  withLabel = false,
}: {
  target: RevealTarget;
  className?: string;
  /** Show the words after the icon, for a footer-style control. */
  withLabel?: boolean;
}) {
  const host = useRevealHost();
  if (!host) return null;
  const on = host.isOpen(target.href);
  const label = on ? "Hide full page" : "Show full page here";
  const Icon = on ? PanelBottomClose : PanelBottomOpen;
  return (
    <button
      type="button"
      title={label}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        host.toggle(target);
      }}
      className={`inline-flex items-center gap-1 rounded p-0.5 transition-colors ${on ? "text-sol-cyan" : ""} ${className}`}
    >
      <Icon className="h-3 w-3" />
      {withLabel && label}
    </button>
  );
}

/**
 * Nearest thing the band should fill: an ancestor that opts in with
 * data-reveal-bounds, else the nearest scrolling ancestor — the transcript
 * feed, the chat list, a page's main scroll.
 */
function revealBounds(el: HTMLElement): HTMLElement | null {
  const marked = el.parentElement?.closest<HTMLElement>("[data-reveal-bounds]");
  if (marked) return marked;
  for (let n = el.parentElement; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if (o === "auto" || o === "scroll") return n;
  }
  return null;
}

// The band's height is the reader's choice, kept across reveals and reloads;
// until they drag, it is a share of the scrolling surface.
const HEIGHT_KEY = "codecast.reveal.height";
const MIN_HEIGHT = 160;
function savedHeight(): number | null {
  try {
    const n = Number(localStorage.getItem(HEIGHT_KEY));
    return n >= MIN_HEIGHT ? n : null;
  } catch {
    return null;
  }
}
function bandHeight(bounds: HTMLElement): number {
  const max = Math.round(bounds.clientHeight * 0.95);
  const saved = savedHeight();
  return Math.min(max, saved ?? Math.round(bounds.clientHeight * 0.82));
}

// Full bleed by measurement, not by CSS math: the band sits under an unknown
// stack of gutters (avatar column, centered prose column, row padding) that
// differs per host, so it measures its own offset from the bounds and pulls
// itself back to the bounds' left edge, taking the bounds' full width and a
// share of its height. Re-measured when the bounds resize (a pane drag, a
// window resize). Rects are screen px under the in-app zoom; inline lengths
// are layout px, hence the division.
function useFullBleed(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bounds = revealBounds(el);
    if (!bounds) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      el.style.marginLeft = "0px";
      el.style.width = "auto";
      const zoom = cssZoomOf(el);
      const b = bounds.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      el.style.marginLeft = `${(b.left - r.left) / zoom + bounds.clientLeft}px`;
      el.style.width = `${bounds.clientWidth}px`;
      el.style.height = `${bandHeight(bounds)}px`;
    };
    apply();
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(apply);
    });
    ro.observe(bounds);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
}

/** Drag the band's bottom edge to resize it; the height persists. */
function useResizeGrip(ref: React.RefObject<HTMLDivElement | null>) {
  return useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget;
      grip.setPointerCapture(e.pointerId);
      const zoom = cssZoomOf(el);
      const startY = e.clientY;
      const startH = el.getBoundingClientRect().height / zoom;
      const bounds = revealBounds(el);
      const max = bounds ? Math.round(bounds.clientHeight * 0.95) : Infinity;
      let h = startH;
      const move = (ev: PointerEvent) => {
        h = Math.max(MIN_HEIGHT, Math.min(max, startH + (ev.clientY - startY) / zoom));
        el.style.height = `${Math.round(h)}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
        } catch {}
      };
      grip.addEventListener("pointermove", move);
      grip.addEventListener("pointerup", up);
      grip.addEventListener("pointercancel", up);
    },
    [ref],
  );
}

function RevealBand({ target, onClose }: { target: RevealTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFullBleed(ref);
  const onGripDown = useResizeGrip(ref);
  const tab = useTabContext();
  // In-band navigation (a page's own links, its list → detail) stays in the
  // band: the pane-local navigate re-points this band, not the tab.
  const [path, setPath] = useState(target.href);
  const navigate = useCallback((p: string) => setPath(p), []);
  const sessionId = paneSessionId(path);
  const targetMessageId = path.includes("#msg-") ? path.slice(path.indexOf("#msg-") + 5) : undefined;
  return (
    <div
      ref={ref}
      className="object-reveal not-prose"
      data-object-reveal
      // A band lives inside a card row / a message body whose click handlers
      // toggle things; nothing inside the page should reach them.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="object-reveal__strip">
        <PageIcon path={path} className="h-3 w-3 flex-shrink-0 text-sol-text-dim" />
        <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-sol-text-muted">{target.title}</span>
        <Link href={target.href} onClick={target.onOpen} className="cc-panel__btn flex-shrink-0" title="Open the page">
          <ArrowUpRight className="h-3 w-3" />
        </Link>
        <PaneControls onClose={onClose} closeTitle="Close" />
      </div>
      <div className="object-reveal__body">
        <ErrorBoundary name="ObjectReveal" level="panel">
          {sessionId ? (
            <SessionPane sessionId={sessionId} targetMessageId={targetMessageId} />
          ) : (
            <RoutePane tabId={tab?.tabId ?? "reveal"} path={path} isActive={tab?.isActive ?? true} navigate={navigate} />
          )}
        </ErrorBoundary>
      </div>
      <div
        className="object-reveal__grip"
        onPointerDown={onGripDown}
        title="Drag to resize"
        aria-label="Drag to resize"
        role="separator"
        aria-orientation="horizontal"
      />
    </div>
  );
}
