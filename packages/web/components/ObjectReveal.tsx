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
import { PageIcon } from "./RecentVisitRow";
import { pageAccent } from "../lib/pageAccent";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal, isEditableTarget } from "../shortcuts";
import { canOpenBeside, paneSessionId } from "../lib/stage";
import { openIn } from "../lib/openIntent";
import { useRouter } from "next/navigation";
import { useTabContext } from "../lib/tabParams";
import { cssZoomOf } from "../lib/cssZoom";
import { HeightGrip, maxGripHeight, savedGripHeight, scrollParentOf } from "./HeightGrip";
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
import { revealWheelGoesToParent } from "../lib/revealWheel";

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

/** The object's way out to its full page. `compact` is the card/pill: the
 *  label opens the object, the columns icon opens it beside. `bar` sits above
 *  the framed page: the whole bar is the band's close, with a small Open and
 *  the beside icon at its end. */
export function RevealOpenLink({
  href,
  label,
  onOpen,
  onClose,
  variant = "bar",
}: {
  href: string;
  label: string;
  onOpen?: (e: React.MouseEvent) => void;
  onClose?: () => void;
  variant?: "bar" | "compact";
}) {
  const beside = canOpenBeside();
  const bar = variant === "bar" && !!onClose;
  const open = (
    <Link
      href={href}
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.(e);
      }}
      className={bar ? "object-reveal__open-small" : "object-reveal__open-go"}
      title={label}
    >
      <span className="object-reveal__open-label">
        <span className="object-reveal__open-text">{bar ? "Open" : label}</span>
        <ArrowUpRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
  return (
    <div className={bar ? "object-reveal__open" : "object-reveal-open-compact"}>
      {bar ? (
        <button
          type="button"
          className="object-reveal__open-go"
          title="Close (Esc)"
          aria-label="Close"
          data-reveal-close
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onClose!();
          }}
        >
          <span className="object-reveal__open-label">
            <X className="h-4 w-4" />
            <span className="object-reveal__open-text">Close</span>
            <KeyCap size="xs">esc</KeyCap>
          </span>
        </button>
      ) : open}
      {bar && open}
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
          <Columns2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

// The surface the band scrolls with and takes its height from: the nearest
// scrolling ancestor (the transcript feed, the chat list, a page's main scroll).
const revealBounds = scrollParentOf;

/**
 * What the band spans side to side: a column inside the scroller that opts in
 * with data-reveal-span (the decision sheet's reasoning beside its sticky
 * options), else the whole scroller.
 */
function revealSpan(el: HTMLElement, bounds: HTMLElement): HTMLElement {
  const marked = el.parentElement?.closest<HTMLElement>("[data-reveal-span]");
  return marked && bounds.contains(marked) ? marked : bounds;
}

// The band's height is the reader's choice, kept across reveals and reloads;
// until they drag, it is a share of the scrolling surface.
const HEIGHT_KEY = "codecast.reveal.height";
const MIN_HEIGHT = 160;
function bandHeight(bounds: HTMLElement): number {
  const saved = savedGripHeight(HEIGHT_KEY, MIN_HEIGHT);
  return Math.min(maxGripHeight(bounds, MIN_HEIGHT), saved ?? Math.round(bounds.clientHeight * 0.6));
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
    const span = revealSpan(el, bounds);
    let raf = 0;
    const apply = () => {
      raf = 0;
      if (el.dataset.resizing !== undefined) return;
      el.style.marginLeft = "0px";
      el.style.width = "auto";
      const zoom = cssZoomOf(el);
      const b = span.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      el.style.marginLeft = `${(b.left - r.left) / zoom + span.clientLeft}px`;
      el.style.width = `${span.clientWidth}px`;
      el.style.height = `${bandHeight(bounds)}px`;
    };
    apply();
    const ro = new ResizeObserver(() => {
      if (!raf) raf = requestAnimationFrame(apply);
    });
    ro.observe(bounds);
    if (span !== bounds) ro.observe(span);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
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
 * A fresh band grows from the line it opened under to its height. Opening
 * never moves the conversation: the reader stays exactly where they clicked,
 * and the band grows down from there. Restored bands (a recycled row
 * scrolling back) skip the motion: they are where the reader left them.
 */
function useOpenMotion(ref: React.RefObject<HTMLDivElement | null>, reveal: OpenReveal) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !reveal.fresh || reducedMotion() || typeof el.animate !== "function") return;
    const anim = el.animate(
      [{ height: "0px", opacity: 0.4 }, { height: el.style.height, opacity: 1 }],
      { duration: 260, easing: EASE_OUT },
    );
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

/**
 * Where the pinned close bar goes while the band's top is scrolled out of
 * the view: the top edge of the scrolling surface, in the coordinates of the
 * surface's parent (the bar is portalled there, outside the transcript's
 * translated rows, where sticky and fixed both misplace it). Null while the
 * band's own top bar is in view or the band is out of view entirely.
 */
type PinSpot = { host: HTMLElement; top: number; left: number; width: number };
function usePinnedClose(ref: React.RefObject<HTMLDivElement | null>): PinSpot | null {
  const [spot, setSpot] = useState<PinSpot | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const bounds = el && revealBounds(el);
    const host = bounds?.parentElement;
    if (!el || !bounds || !host) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const zoom = cssZoomOf(bounds);
      const b = bounds.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (r.top >= b.top || r.bottom <= b.top + 80) {
        setSpot((cur) => (cur ? null : cur));
        return;
      }
      const h = host.getBoundingClientRect();
      const span = revealSpan(el, bounds);
      const s = span.getBoundingClientRect();
      const next = {
        host,
        top: Math.round((b.top - h.top) / zoom + bounds.clientTop),
        left: Math.round((s.left - h.left) / zoom + span.clientLeft),
        width: span.clientWidth,
      };
      setSpot((cur) => (cur && cur.top === next.top && cur.left === next.left && cur.width === next.width ? cur : next));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    bounds.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(bounds);
    ro.observe(el);
    return () => {
      bounds.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
  return spot;
}

function RevealBand({ reveal }: { reveal: OpenReveal }) {
  const { target } = reveal;
  const ref = useRef<HTMLDivElement>(null);
  useFullBleed(ref);
  useScrollHold(ref, reveal);
  useOpenMotion(ref, reveal);
  useRevealWheel(ref);
  const pin = usePinnedClose(ref);
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
  // The header strip and the foot are both the close: one click anywhere on
  // either. Enter and Space do the same from the keyboard.
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
  const targetMessageId = path.includes("#msg-") ? parseMessageHash(path.slice(path.indexOf("#msg-")))?.messageId : undefined;
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
      <RevealOpenLink href={target.href} label={target.openLabel ?? "Open"} onOpen={target.onOpen} onClose={requestClose} />
      {pin && createPortal(
        <div
          className="object-reveal__pin"
          style={{ top: pin.top, left: pin.left, width: pin.width, "--reveal-accent": pageAccent(path) } as React.CSSProperties}
          data-reveal-pin
        >
          <div
            className="object-reveal__strip"
            onClick={requestClose}
            onKeyDown={closeKeys}
            role="button"
            tabIndex={0}
            aria-label="Close"
            title="Close (Esc)"
          >
            <PageIcon path={path} className="object-reveal__icon h-3 w-3 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-sol-text">{target.title}</span>
            <span className="object-reveal__hint object-reveal__hint--on" aria-hidden>
              <span className="object-reveal__hint-word">close</span>
              <KeyCap size="xs">esc</KeyCap>
            </span>
            <X className="h-3.5 w-3.5 text-sol-text-muted" />
          </div>
        </div>,
        pin.host,
      )}
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
      <div
        className="object-reveal__foot"
        onClick={requestClose}
        onKeyDown={closeKeys}
        role="button"
        tabIndex={0}
        aria-label="Close"
        title="Close (Esc)"
      >
        <X className="h-3.5 w-3.5" />
        <span>Close</span>
        <KeyCap size="xs">esc</KeyCap>
      </div>
      </div>
      {/* The grip is only a grip: the rounded bar under the frame, in the
          gutter, always drawn so the resize reads before the pointer finds it. */}
      <HeightGrip target={ref} storageKey={HEIGHT_KEY} min={MIN_HEIGHT} className="object-reveal__grip" />
    </div>
  );
}
