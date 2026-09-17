"use client";
// The inline reveal: a rich object reference (a pill in prose, a shared-object
// card) opens its FULL page right here in the conversation — a full-bleed band
// on a crosshatch ground, spanning the whole scrolling surface, with the
// object's real page inside. Reading the object no longer means leaving.
//
// Two halves. RevealHost wraps a rendered markdown body: it renders its
// children untouched (a fragment, so a message body's blocks stay direct
// children of their container) and, when the one open reveal belongs to it,
// portals the band into the slot lib/revealHost placed right under the
// reference's block. useRevealRef is what a pill or card calls to toggle
// itself; a surface with no host renders no reveal affordance.
//
// The band renders the page through the same pane renderer the split stage
// uses (RoutePane for a route, SessionPane for a conversation), so what opens
// here IS the page — same component, same in-pane navigation — never a second
// rendering of the object to keep in step.

import React, { useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Columns2, PanelBottomClose, PanelBottomOpen, X } from "lucide-react";
import { RoutePane } from "./RoutePane";
import { SessionPane } from "./stage/SessionPane";
import { PaneControls } from "./stage/PaneControls";
import { PageIcon, pageAccent } from "./RecentVisitRow";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal, isEditableTarget } from "../shortcuts";
import { canOpenBeside } from "../lib/stage";
import { openIn } from "../lib/openIntent";
import { useRouter } from "next/navigation";
import { useTabContext } from "../lib/tabParams";
import { paneSessionId } from "../lib/stage";
import { cssZoomOf } from "../lib/cssZoom";
import { useInboxStore } from "../store/inboxStore";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { useEventListener } from "../hooks/useEventListener";
import {
  RevealHostCtx,
  RevealInBandCtx,
  closeReveal,
  useOpenReveal,
  useRevealAncestry,
  useRevealRef,
  type OpenReveal,
  type RevealTarget,
} from "../lib/revealHost";

export type { RevealTarget } from "../lib/revealHost";

export function RevealHost({ children, persistKey }: { children: React.ReactNode; persistKey?: string }) {
  // The key a reveal remembers its host by. A transcript row passes its body,
  // so the band survives the virtualizer recycling the row; a chat message
  // its id; otherwise the mount's own id.
  const id = useId();
  const hostKey = persistKey ?? id;
  const value = useMemo(() => ({ hostKey }), [hostKey]);
  const reveal = useOpenReveal();
  const inBand = useContext(RevealInBandCtx);
  if (inBand) return <RevealHostCtx.Provider value={null}>{children}</RevealHostCtx.Provider>;
  // A slot that left the document (its row recycled) waits for the
  // reference to re-place it; rendering into it meanwhile would mount the
  // page into nothing.
  const mine = reveal && reveal.hostKey === hostKey && reveal.slot.isConnected ? reveal : null;
  return (
    <RevealHostCtx.Provider value={value}>
      {children}
      {mine && createPortal(<RevealBand key={mine.target.href} reveal={mine} />, mine.slot)}
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
  const ref = useRef<HTMLButtonElement>(null);
  const { host, open: on, toggle } = useRevealRef(target, ref);
  if (!host) return null;
  const label = on ? "Hide full page" : "Show full page here";
  const Icon = on ? PanelBottomClose : PanelBottomOpen;
  return (
    <button
      ref={ref}
      type="button"
      title={label}
      aria-pressed={on}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }}
      className={`inline-flex items-center gap-1 rounded p-0.5 transition-colors ${on ? "text-sol-cyan" : ""} ${className}`}
    >
      <Icon className="h-3 w-3" />
      {withLabel && label}
    </button>
  );
}

/** The big "open this page" hit. The label opens the object; the columns
 *  icon opens it beside, with a tooltip. `bar` sits above the framed page;
 *  `compact` is the card/pill. */
export function RevealOpenLink({
  href,
  label,
  onOpen,
  variant = "bar",
}: {
  href: string;
  label: string;
  onOpen?: (e: React.MouseEvent) => void;
  variant?: "bar" | "compact";
}) {
  const beside = canOpenBeside();
  return (
    <div className={variant === "bar" ? "object-reveal__open" : "object-reveal-open-compact"}>
      <Link
        href={href}
        onClick={(e) => {
          e.stopPropagation();
          onOpen?.(e);
        }}
        className="object-reveal__open-go"
        title={label}
      >
        <span className="object-reveal__open-label">
          {label}
          <ArrowUpRight className={variant === "bar" ? "h-4 w-4" : "h-3.5 w-3.5"} />
        </span>
      </Link>
      {beside && (
        <button
          type="button"
          className="object-reveal__open-beside"
          title="Open beside"
          aria-label="Open beside"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openIn("split", href);
          }}
        >
          <Columns2 className={variant === "bar" ? "h-4 w-4" : "h-3.5 w-3.5"} />
        </button>
      )}
    </div>
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

/** The hatch beside the framed page is the conversation-scroll lane. Wheel
 *  inside the frame reads the object; wheel on the gutter (or its lanes)
 *  moves the parent thread. */
export function revealWheelGoesToParent(target: EventTarget | null, _band?: HTMLElement): boolean {
  const start = target instanceof Element ? target : null;
  if (!start) return true;
  return !start.closest(".object-reveal__frame");
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
// A band may run to almost twice the scrolling surface: the strip and the
// foot stay pinned while the read scrolls through it, so close is never out
// of reach.
const maxBandHeight = (bounds: HTMLElement) => Math.round(bounds.clientHeight * 1.9);
function bandHeight(bounds: HTMLElement): number {
  const saved = savedHeight();
  return Math.min(maxBandHeight(bounds), saved ?? Math.round(bounds.clientHeight * 0.82));
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

/** Drag the grip under the frame to resize the band; the height persists. */
function useResizeGrip(ref: React.RefObject<HTMLDivElement | null>) {
  return useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget;
      grip.setPointerCapture?.(e.pointerId);
      const zoom = cssZoomOf(el);
      const startY = e.clientY;
      const startH = el.getBoundingClientRect().height / zoom;
      const bounds = revealBounds(el);
      const max = bounds ? maxBandHeight(bounds) : Infinity;
      let h = startH;
      el.dataset.resizing = "";
      const move = (ev: PointerEvent) => {
        h = Math.max(MIN_HEIGHT, Math.min(max, startH + (ev.clientY - startY) / zoom));
        el.style.height = `${Math.round(h)}px`;
      };
      const up = () => {
        grip.removeEventListener("pointermove", move);
        grip.removeEventListener("pointerup", up);
        grip.removeEventListener("pointercancel", up);
        delete el.dataset.resizing;
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

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * While another band's removal reflows the page, keep the clicked reference
 * where it was under the cursor: for a few frames after mount, any drift of
 * the anchor from where the click landed is paid back into the scroller.
 * The transcript virtualizer re-measures the emptied row a frame or two
 * later (and adjusts the scroll itself only for rows above the viewport),
 * so this runs as a short watch, not a single correction.
 */
const HOLD_MS = 200;
function useScrollHold(ref: React.RefObject<HTMLDivElement | null>, reveal: OpenReveal) {
  useLayoutEffect(() => {
    const el = ref.current;
    const want = reveal.holdTop;
    if (!el || want === null) return;
    const bounds = revealBounds(el);
    if (!bounds) return;
    const { anchor } = reveal;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      raf = 0;
      const drift = (anchor.getBoundingClientRect().top - want) / cssZoomOf(bounds);
      if (Math.abs(drift) >= 1) bounds.scrollTop += drift;
      if (performance.now() - t0 < HOLD_MS) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [ref, reveal]);
}

/**
 * A fresh band grows from the line it opened under to its height, then
 * takes the scroll to itself — as far as the band's bottom needs, but never
 * so far that the line it opened under leaves the top, so the reader keeps
 * the sentence and the page together. Restored bands (a recycled row
 * scrolling back) skip both: they are where the reader left them.
 */
function useOpenMotion(ref: React.RefObject<HTMLDivElement | null>, reveal: OpenReveal) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !reveal.fresh) return;
    const settle = () => {
      const bounds = revealBounds(el);
      if (!bounds) return;
      const zoom = cssZoomOf(bounds);
      const b = bounds.getBoundingClientRect();
      const overflow = (el.getBoundingClientRect().bottom - b.bottom) / zoom;
      if (overflow <= 0) return;
      const room = (reveal.anchor.getBoundingClientRect().top - b.top) / zoom - 12;
      const delta = Math.min(overflow, room);
      if (delta <= 0) return;
      bounds.scrollTo({ top: bounds.scrollTop + delta, behavior: reducedMotion() ? "auto" : "smooth" });
    };
    if (reducedMotion() || typeof el.animate !== "function") {
      settle();
      return;
    }
    const anim = el.animate(
      [{ height: "0px", opacity: 0.4 }, { height: el.style.height, opacity: 1 }],
      { duration: 260, easing: EASE_OUT },
    );
    anim.finished.then(settle, () => {});
    return () => anim.cancel();
  }, [ref, reveal]);
}

function useRevealWheel(ref: React.RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!revealWheelGoesToParent(e.target, el)) return;
      const bounds = revealBounds(el);
      if (!bounds) return;
      e.preventDefault();
      bounds.scrollTop += e.deltaY / cssZoomOf(bounds);
    };
    el.addEventListener("wheel", onWheel, { passive: false, capture: true });
    return () => el.removeEventListener("wheel", onWheel, { capture: true });
  }, [ref]);
}

function RevealBand({ reveal }: { reveal: OpenReveal }) {
  const { target } = reveal;
  const ref = useRef<HTMLDivElement>(null);
  useFullBleed(ref);
  useScrollHold(ref, reveal);
  useOpenMotion(ref, reveal);
  useRevealWheel(ref);
  // Closing folds the band back into the line it grew from, then brings the
  // reference that opened it back into view if the read had scrolled past it
  // — so a toggle lands the reader where they started, not on whatever the
  // collapse pulled up under the cursor.
  const closing = useRef(false);
  const requestClose = useCallback(() => {
    const el = ref.current;
    if (closing.current) return;
    closing.current = true;
    const origin = reveal.anchor;
    const done = () => {
      closeReveal();
      requestAnimationFrame(() => origin.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }));
    };
    if (!el || reducedMotion() || typeof el.animate !== "function") {
      done();
      return;
    }
    el.animate([{ height: el.style.height, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
      .finished.then(done, done);
  }, [reveal.anchor]);
  const onGripDown = useResizeGrip(ref);
  // The header and the foot are both the close: one click anywhere on either
  // strip. Enter and Space do the same from the keyboard.
  const closeKeys = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      requestClose();
    }
  }, [requestClose]);
  // Escape closes the open band from anywhere on the page: it is the one
  // band, so no focus or hover has to say which. Inside the band its own key
  // handler takes it (and stops keys from leaving the band, so a page's own
  // Escape never reaches the host). Never from an editable or under a modal;
  // both own Escape.
  const escapes = useCallback((e: { key: string; defaultPrevented: boolean; target: EventTarget | null }) =>
    e.key === "Escape" && !e.defaultPrevented && !isEditableTarget(e.target) && !hasOpenModal(), []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (!escapes(e)) return;
    e.preventDefault();
    requestClose();
  }, [escapes, requestClose]);
  useEventListener("keydown", (e) => {
    if (!escapes(e)) return;
    e.preventDefault();
    requestClose();
  }, typeof document === "undefined" ? undefined : document);
  const tab = useTabContext();
  // In-band navigation (a page's own links, its list → detail) stays in the
  // band: the pane-local navigate re-points this band, not the tab. A
  // conversation is the exception. The band lives inside a conversation, and
  // the session a revealed task or plan links is often that very one; shown
  // in the band it would render itself, its bands open, without end. So a
  // session opened from inside the band goes where a click on it goes from
  // the host page — onto the stage — through the same gesture, and a message
  // deep link rides the host's router so its target survives.
  const [path, setPath] = useState(target.href);
  const openLinkedSession = useOpenLinkedSession();
  const hostRouter = useRouter();
  const navigate = useCallback((p: string, mode: "push" | "replace") => {
    const [pathname, hash] = p.split("#");
    const sid = paneSessionId(pathname);
    if (!sid) {
      setPath(p);
    } else if (hash) {
      hostRouter[mode](p);
    } else {
      openLinkedSession(useInboxStore.getState().sessions[sid] ?? { _id: sid });
    }
  }, [openLinkedSession, hostRouter]);
  const sessionId = paneSessionId(path);
  const targetMessageId = path.includes("#msg-") ? path.slice(path.indexOf("#msg-") + 5) : undefined;
  // A reference to a conversation this band is already inside (a session's
  // own id in its transcript, two sessions citing each other) shows a line,
  // not the conversation again.
  const ancestry = useRevealAncestry();
  const nested = sessionId !== null && ancestry.includes(sessionId);
  return (
    <div
      ref={ref}
      className="object-reveal not-prose"
      data-object-reveal
      style={{ "--reveal-accent": pageAccent(path) } as React.CSSProperties}
      // A band lives inside a card row / a message body whose click handlers
      // toggle things; nothing inside the page should reach them.
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div className="object-reveal__lane object-reveal__lane--left" title="Scroll the conversation" />
      <div className="object-reveal__lane object-reveal__lane--right" title="Scroll the conversation" />
      <RevealOpenLink href={target.href} label={target.openLabel ?? "Open"} onOpen={target.onOpen} />
      <div className="object-reveal__frame">
      <div
        className="object-reveal__strip"
        onClick={requestClose}
        onKeyDown={closeKeys}
        role="button"
        tabIndex={0}
        aria-label="Close"
        title="Close"
      >
        <PageIcon path={path} className="object-reveal__icon h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-sol-text">{target.title}</span>
        <span className="object-reveal__hint" aria-hidden>
          <span className="object-reveal__hint-word">close</span>
          <KeyCap size="xs">esc</KeyCap>
        </span>
        <PaneControls onClose={requestClose} closeTitle="Close (Esc)" />
      </div>
      <div className="object-reveal__body">
        <RevealInBandCtx.Provider value={true}>
        <ErrorBoundary name="ObjectReveal" level="panel">
          {nested ? (
            <div className="flex h-full items-center justify-center text-xs text-sol-text-dim" data-reveal-nested>
              This is the conversation you are reading
            </div>
          ) : sessionId ? (
            <SessionPane sessionId={sessionId} targetMessageId={targetMessageId} />
          ) : (
            <RoutePane tabId={tab?.tabId ?? "reveal"} path={path} isActive={tab?.isActive ?? true} navigate={navigate} />
          )}
        </ErrorBoundary>
        </RevealInBandCtx.Provider>
      </div>
      {/* The foot is the other close: the whole strip, pinned to the bottom
          of the view while the read scrolls through a tall band. */}
      <div
        className="object-reveal__foot"
        onClick={requestClose}
        onKeyDown={closeKeys}
        role="button"
        tabIndex={0}
        aria-label="Close"
        title="Close"
      >
        <X className="h-3.5 w-3.5" />
        <span>Close</span>
        <KeyCap size="xs">esc</KeyCap>
      </div>
      </div>
      {/* The grip is only a grip: the rounded bar under the frame, in the
          gutter, always drawn so the resize reads before the pointer finds it. */}
      <div
        className="object-reveal__grip"
        onPointerDown={onGripDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize"
        title="Drag to resize"
      >
        <span className="object-reveal__grip-bar" />
      </div>
    </div>
  );
}
