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
import { PageIcon, pageAccent } from "./RecentVisitRow";
import { ErrorBoundary } from "./ErrorBoundary";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { hasOpenModal, isEditableTarget } from "../shortcuts";
import { useRouter } from "next/navigation";
import { useTabContext } from "../lib/tabParams";
import { paneSessionId } from "../lib/stage";
import { cssZoomOf } from "../lib/cssZoom";
import { useInboxStore } from "../store/inboxStore";
import { useOpenLinkedSession } from "../hooks/useOpenLinkedSession";
import { useEventListener } from "../hooks/useEventListener";
import { RevealHostCtx, useRevealHost, useRevealAncestry, type RevealTarget } from "../lib/revealHost";

export type { RevealTarget } from "../lib/revealHost";

// Open reveals by host key, surviving the host's unmount: the transcript
// virtualizer recycles rows scrolled far away, and a band the reader opened
// must still be there when they scroll back. Bounded so a long-lived tab
// stays bounded; an entry is dropped once its last band closes.
const OPEN_BY_KEY = new Map<string, Map<string, RevealTarget>>();
const OPEN_BY_KEY_MAX = 200;
// Targets the reader just opened, as opposed to bands restored when a
// recycled row scrolls back: only a fresh band grows in and takes the scroll
// to itself. A restored one is already where the reader left it.
const FRESH = new WeakSet<RevealTarget>();

export function RevealHost({ children, persistKey }: { children: React.ReactNode; persistKey?: string }) {
  // Insertion-ordered by href: a second reveal opens below the first.
  const [open, setOpen] = useState<Map<string, RevealTarget>>(
    () => (persistKey && OPEN_BY_KEY.get(persistKey)) || new Map(),
  );
  const toggle = useCallback((target: RevealTarget) => {
    setOpen((prev) => {
      const next = new Map(prev);
      if (next.has(target.href)) next.delete(target.href);
      else {
        next.set(target.href, target);
        FRESH.add(target);
      }
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

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The reference that opened this band: the pressed pill for its href in the
 *  same message body (RevealHost renders a fragment, so it is a sibling). */
function originOf(el: HTMLElement | null, href: string): HTMLElement | null {
  const pressed = el?.parentElement?.querySelectorAll<HTMLElement>('[aria-pressed="true"]') ?? [];
  for (const p of pressed) if (p.getAttribute("href") === href) return p;
  return null;
}

/**
 * A fresh band grows from the rule under the message to its height, then
 * takes the scroll to itself — a nearest scroll, so a band that already fits
 * moves nothing. Restored bands (a recycled row scrolling back) skip both:
 * they are where the reader left them.
 */
function useOpenMotion(ref: React.RefObject<HTMLDivElement | null>, fresh: boolean) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !fresh) return;
    const settle = () => el.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
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
  }, [ref, fresh]);
}

function RevealBand({ target, onClose }: { target: RevealTarget; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fresh] = useState(() => FRESH.delete(target));
  useFullBleed(ref);
  useOpenMotion(ref, fresh);
  const onGripDown = useResizeGrip(ref);
  // Closing folds the band back into the rule it grew from, then brings the
  // reference that opened it back into view if the read had scrolled past it
  // — so a toggle lands the reader where they started, not on whatever the
  // collapse pulled up under the cursor.
  const closing = useRef(false);
  const requestClose = useCallback(() => {
    const el = ref.current;
    if (closing.current) return;
    closing.current = true;
    const origin = originOf(el, target.href);
    const done = () => {
      onClose();
      if (origin) requestAnimationFrame(() => origin.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" }));
    };
    if (!el || reducedMotion() || typeof el.animate !== "function") {
      done();
      return;
    }
    el.animate([{ height: el.style.height, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
      .finished.then(done, done);
  }, [onClose, target.href]);
  // Escape closes the band the reader is in: focus inside it (the band's own
  // key handler, since it stops keys from leaving the band), the pointer over
  // it, or focus still on the reference that opened it — the pill keeps
  // focus after the click, so open then Escape is one round trip. Never from
  // an editable or under a modal; both own Escape.
  const escapes = useCallback((e: { key: string; defaultPrevented: boolean; target: EventTarget | null }) =>
    e.key === "Escape" && !e.defaultPrevented && !isEditableTarget(e.target) && !hasOpenModal(), []);
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (!escapes(e)) return;
    e.preventDefault();
    requestClose();
  }, [escapes, requestClose]);
  useEventListener("keydown", (e) => {
    const el = ref.current;
    if (!el || !escapes(e)) return;
    const active = document.activeElement;
    if (!el.matches(":hover") && !(active !== null && active === originOf(el, target.href))) return;
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
      <div className="object-reveal__frame">
      <div className="object-reveal__strip">
        <PageIcon path={path} className="object-reveal__icon h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-sol-text">{target.title}</span>
        <span className="object-reveal__hint" aria-hidden><KeyCap size="xs">esc</KeyCap></span>
        <Link href={target.href} onClick={target.onOpen} className="cc-panel__btn flex-shrink-0" title="Open the page">
          <ArrowUpRight className="h-3 w-3" />
        </Link>
        <PaneControls onClose={requestClose} closeTitle="Close (Esc)" />
      </div>
      <div className="object-reveal__body">
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
      </div>
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
