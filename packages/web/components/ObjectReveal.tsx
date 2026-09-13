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

import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, PanelBottomOpen } from "lucide-react";
import { RoutePane } from "./RoutePane";
import { SessionPane } from "./stage/SessionPane";
import { PaneControls } from "./stage/PaneControls";
import { PageIcon } from "./RecentVisitRow";
import { ErrorBoundary } from "./ErrorBoundary";
import { useTabContext } from "../lib/tabParams";
import { paneSessionId } from "../lib/stage";
import { cssZoomOf } from "../lib/cssZoom";

export type RevealTarget = {
  /** The object's page — the same href the reference links to. */
  href: string;
  /** The band's strip title: "Task: Fix the auth race". */
  title: string;
  /** The reference's own open handler (a session routes through
   *  useOpenLinkedSession); the band's open link calls it too. */
  onOpen?: (e: React.MouseEvent) => void;
};

type RevealHostValue = {
  toggle: (target: RevealTarget) => void;
  isOpen: (href: string) => boolean;
};

const RevealHostCtx = createContext<RevealHostValue | null>(null);

/** The host a reference toggles itself in — null on a surface without one. */
export function useRevealHost(): RevealHostValue | null {
  return useContext(RevealHostCtx);
}

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
 * The control a reference shows for "open the full page here": an icon
 * button when the host exists, nothing otherwise. Stops propagation so a
 * card's own expand toggle never fires with it.
 */
export function RevealButton({
  target,
  className = "",
  label = "Show full page here",
  children,
}: {
  target: RevealTarget;
  className?: string;
  label?: string;
  /** Text after the icon, for a footer-style control. */
  children?: React.ReactNode;
}) {
  const host = useRevealHost();
  if (!host) return null;
  const on = host.isOpen(target.href);
  return (
    <button
      type="button"
      title={on ? "Hide the page" : label}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        host.toggle(target);
      }}
      className={`inline-flex items-center gap-1 rounded p-0.5 transition-colors ${on ? "text-sol-cyan" : ""} ${className}`}
    >
      <PanelBottomOpen className="h-3 w-3" />
      {children}
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
      el.style.height = `${Math.round(bounds.clientHeight * 0.82)}px`;
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

function RevealBand({ target, onClose }: { target: RevealTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFullBleed(ref);
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
      <div className="object-reveal__frame">
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
      </div>
    </div>
  );
}
