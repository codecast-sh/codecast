"use client";
// The spotlight: one step of the running tour drawn over the real page.
//
// The dim sheet is four rectangles around the target, so the hole is real
// and the highlighted control keeps taking clicks (a "do it now" is often
// the control itself). A ring breathes around the hole; a thin leader runs
// from the card to it, so the card can sit wherever there is room and still
// point. The card is one small title, one or two sentences, the step dots,
// Back / Next / Done, and the step's own button when it has one.
//
// A step settles before it shows: it opens the panel it points at (`prepare`),
// waits for its target to exist, and skips itself when the target never
// comes and the step is optional (a role card in a workspace with no roles).
// A tour started on another page goes to its route first.
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { useTrackedStore } from "../store/inboxStore";
import { useEventListener } from "../hooks/useEventListener";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMountEffect } from "../hooks/useMountEffect";
import { isEditableTarget } from "../shortcuts";
import { KeyCap } from "../components/KeyboardShortcutsHelp";
import { endTour, setTourStep, startTour } from "./engine";
import { tourById } from "./registry";
import { TOUR_AREAS, tourAccent, type TourDef, type TourStep } from "./types";

const KEY_CAPTURE = { capture: true } as const;
const PAD = 8;
const CARD_W = 340;
const GAP = 18;
const MARGIN = 12;
/** How long a step waits for the panel it opened, and for its target. */
const PREPARE_WAIT_MS = 2500;
const TARGET_WAIT_MS = 1600;
/** An optional step decides fast: two absent cards must not cost three
 *  seconds of blank screen. */
const OPTIONAL_WAIT_MS = 350;
/** A tour started while its page is still loading (a link, a tour that just
 *  moved to its route) waits for the page to show anything of it. */
const PAGE_WAIT_MS = 15000;
const POLL_MS = 80;

type Rect = { x: number; y: number; w: number; h: number };
type Phase = { kind: "settling" } | { kind: "shown"; selector: string | null } | { kind: "missing" };

/** The first match of a selector list, tried in the list's order (a comma
 *  list to querySelector answers in document order instead, and a tour wants
 *  "the proposed card, else the Health button"). */
function qs(sel: string | null | undefined): HTMLElement | null {
  if (!sel) return null;
  for (const part of sel.split(",")) {
    try {
      const el = document.querySelector<HTMLElement>(part.trim());
      if (el) return el;
    } catch { /* a bad selector matches nothing */ }
  }
  return null;
}

/** The steps a person will actually see: an optional step whose target is
 *  not on the page is left out of the count and the dots, so "2 of 5" stays
 *  true. A step that opens its own panel first counts while the control
 *  that opens it is there. */
export function visibleSteps(steps: TourStep[], present: (target: string | null) => boolean): TourStep[] {
  return steps.filter((st) => !st.optional || present(st.target) || (!!st.prepare && present(st.prepare.click)));
}

const sameRect = (a: Rect | null, b: Rect | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** The target's box, padded and clipped to the viewport, followed while the
 *  step is open: panels slide, charts pan, dialogs grow. Animation rate for
 *  the first second, then a few times a second, plus resize and scroll. */
function useTargetRect(selector: string | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    if (!selector) { setRect(null); return; }
    let raf = 0;
    let ticks = 0;
    const measure = () => {
      const el = qs(selector);
      const r = el?.getBoundingClientRect();
      let next: Rect | null = null;
      if (el && r && r.width > 0 && r.height > 0) {
        // The part a person can see: the box cut to every scrolling ancestor
        // (a gallery taller than its dialog) and then to the viewport.
        let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if (!/(auto|scroll|hidden|clip)/.test(`${cs.overflowX} ${cs.overflowY}`)) continue;
          const c = p.getBoundingClientRect();
          left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
        }
        const x = Math.max(MARGIN / 2, left - PAD), y = Math.max(MARGIN / 2, top - PAD);
        const x2 = Math.min(window.innerWidth - MARGIN / 2, right + PAD), y2 = Math.min(window.innerHeight - MARGIN / 2, bottom + PAD);
        if (x2 > x && y2 > y) next = { x, y, w: x2 - x, h: y2 - y };
      }
      setRect((prev) => (sameRect(prev, next) ? prev : next));
    };
    const tick = () => { measure(); if (++ticks < 60) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const slow = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => { cancelAnimationFrame(raf); window.clearInterval(slow); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [selector]);
  return rect;
}

/** Where the card goes: below the target, else above, else beside it, else
 *  tucked into its bottom right corner (a target that fills the screen). */
export function placeCard(rect: Rect | null, card: { w: number; h: number }, view: { w: number; h: number }): { x: number; y: number } {
  const clampX = (x: number) => Math.max(MARGIN, Math.min(x, view.w - card.w - MARGIN));
  const clampY = (y: number) => Math.max(MARGIN, Math.min(y, view.h - card.h - MARGIN));
  if (!rect) return { x: clampX((view.w - card.w) / 2), y: clampY(view.h / 2 - card.h / 2) };
  const cx = rect.x + rect.w / 2 - card.w / 2;
  const cy = rect.y + rect.h / 2 - card.h / 2;
  if (rect.y + rect.h + GAP + card.h + MARGIN <= view.h) return { x: clampX(cx), y: rect.y + rect.h + GAP };
  if (rect.y - GAP - card.h >= MARGIN) return { x: clampX(cx), y: rect.y - GAP - card.h };
  if (rect.x + rect.w + GAP + card.w + MARGIN <= view.w) return { x: rect.x + rect.w + GAP, y: clampY(cy) };
  if (rect.x - GAP - card.w >= MARGIN) return { x: rect.x - GAP - card.w, y: clampY(cy) };
  return { x: clampX(rect.x + rect.w - card.w - GAP), y: clampY(rect.y + rect.h - card.h - GAP) };
}

/** The leader: from the card's edge to the nearest point on the ring. None
 *  when the card sits inside the target. */
export function leaderLine(rect: Rect, card: Rect): { x1: number; y1: number; x2: number; y2: number } | null {
  const ccx = card.x + card.w / 2, ccy = card.y + card.h / 2;
  const px = Math.max(rect.x, Math.min(ccx, rect.x + rect.w));
  const py = Math.max(rect.y, Math.min(ccy, rect.y + rect.h));
  const inside = ccx >= rect.x && ccx <= rect.x + rect.w && ccy >= rect.y && ccy <= rect.y + rect.h;
  if (inside) return null;
  const qx = Math.max(card.x, Math.min(px, card.x + card.w));
  const qy = Math.max(card.y, Math.min(py, card.y + card.h));
  if (Math.abs(qx - px) < 2 && Math.abs(qy - py) < 2) return null;
  return { x1: qx, y1: qy, x2: px, y2: py };
}

export function TourLayer() {
  const s = useTrackedStore([(st) => st.tour]);
  const run = s.tour;
  const def = run ? tourById(run.id) : undefined;
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const search = useSearchParams();

  // `?tour=<id>` starts a tour by link, as a replay.
  useMountEffect(() => {
    const id = search?.get("tour");
    if (id && tourById(id)) startTour(id, { replay: true });
  });

  // A tour started elsewhere goes to its page first, once per run.
  const onRoute = !def?.route || def.route.match(pathname);
  const navigated = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!run || !def?.route || onRoute || navigated.current === run.id) return;
    navigated.current = run.id;
    router.push(def.route.href);
  }, [run?.id, def, onRoute, router]);

  if (!run || !def || def.kind === "modal" || !onRoute) return null;
  return <Spotlight key={run.id} def={def} step={run.step} />;
}

function Spotlight({ def, step }: { def: TourDef; step: number }) {
  const cur: TourStep | undefined = def.steps[step];
  const accent = tourAccent(def.area);
  const areaLabel = TOUR_AREAS.find((a) => a.area === def.area)?.label ?? "";
  const dir = useRef<1 | -1>(1);
  const [phase, setPhase] = useState<Phase>({ kind: "settling" });
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardH, setCardH] = useState(150);
  // The page gate: no step settles until one of the tour's own controls is on
  // screen, so a slow page never makes the optional steps skip themselves.
  const [pageReady, setPageReady] = useState(false);
  useWatchEffect(() => {
    if (pageReady) return;
    const present = () => def.steps.some((st) => (st.target && qs(st.target)) || (st.prepare && qs(st.prepare.click)));
    if (!def.steps.some((st) => st.target) || present()) { setPageReady(true); return; }
    const start = Date.now();
    const poll = window.setInterval(() => {
      if (present() || Date.now() - start > PAGE_WAIT_MS) { window.clearInterval(poll); setPageReady(true); }
    }, 200);
    return () => window.clearInterval(poll);
  }, [def, pageReady]);

  const go = (next: number) => {
    if (next < 0) return;
    if (next >= def.steps.length) { endTour("finished"); return; }
    dir.current = next > step ? 1 : -1;
    setTourStep(next);
  };

  // Settle the step: open what it points at, wait for the target, skip an
  // optional step whose target never comes.
  useWatchEffect(() => {
    if (!pageReady) return;
    if (!cur) { endTour("finished"); return; }
    setPhase({ kind: "settling" });
    let cancelled = false;
    // What the step's `prepare` came to: it clicked the control that opens
    // the panel, or there was nothing to click (so nothing to wait for).
    let prepared: "no" | "clicked" | "nothing" = "no";
    let t: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const tick = () => {
      if (cancelled) return;
      const prep = cur.prepare;
      if (prep && prepared !== "nothing" && !qs(prep.until)) {
        if (prepared === "no") {
          const opener = qs(prep.click);
          if (opener) { prepared = "clicked"; opener.click(); } else prepared = "nothing";
        }
        if (prepared === "clicked" && Date.now() - start < PREPARE_WAIT_MS) { t = setTimeout(tick, POLL_MS); return; }
      }
      const el = qs(cur.target);
      if (cur.target && !el) {
        const wait = (cur.optional ? OPTIONAL_WAIT_MS : TARGET_WAIT_MS) + (prepared === "clicked" ? PREPARE_WAIT_MS : 0);
        if (Date.now() - start < wait) { t = setTimeout(tick, POLL_MS); return; }
        if (cur.optional) {
          const next = step + dir.current;
          if (next >= def.steps.length) { endTour("finished"); return; }
          if (next >= 0) { setTourStep(next); return; }
        }
        setPhase({ kind: "missing" });
        return;
      }
      el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      setPhase({ kind: "shown", selector: cur.target });
    };
    tick();
    return () => { cancelled = true; if (t) clearTimeout(t); };
  }, [def, step, cur, pageReady]);

  // The card's own height, for placement.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const read = () => setCardH(el.offsetHeight || 150);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase, step]);

  // The card takes focus so the arrows work and a reader announces it; a
  // field the person is typing in keeps its keys.
  useWatchEffect(() => { if (phase.kind !== "settling") cardRef.current?.focus({ preventScroll: true }); }, [phase, step]);
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); endTour("skipped"); }
    else if (e.key === "ArrowRight" || e.key === "Enter") { e.stopPropagation(); e.preventDefault(); go(step + 1); }
    else if (e.key === "ArrowLeft") { e.stopPropagation(); e.preventDefault(); go(step - 1); }
  }, undefined, KEY_CAPTURE);

  const rect = useTargetRect(phase.kind === "shown" ? phase.selector : null);
  if (!cur || phase.kind === "settling") return null;
  const shown = visibleSteps(def.steps, (t) => !!qs(t));
  const shownIndex = Math.max(0, shown.indexOf(cur));
  const last = !def.steps.slice(step + 1).some((st) => shown.includes(st));

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const cardW = Math.min(CARD_W, vw - MARGIN * 2);
  const pos = placeCard(rect, { w: cardW, h: cardH }, { w: vw, h: vh });
  const leader = rect ? leaderLine(rect, { x: pos.x, y: pos.y, w: cardW, h: cardH }) : null;
  const dim = "color-mix(in srgb, var(--sol-bg) 60%, transparent)";
  const action = cur.action && (!cur.action.when || qs(cur.action.when)) ? cur.action : null;
  const ringVars = { "--tour-accent": accent } as CSSProperties;
  const skip = () => endTour("skipped");

  return (
    <div className="fixed inset-0 z-[10050]" role="dialog" aria-modal="true" aria-label={`Tour: ${def.title}`} data-tour-open={def.id} data-tour-step={cur.id} style={ringVars}>
      {rect ? (
        <>
          <div className="absolute tour-sheet" onMouseDown={skip} style={{ left: 0, top: 0, width: vw, height: Math.max(0, rect.y), background: dim }} />
          <div className="absolute tour-sheet" onMouseDown={skip} style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h, background: dim }} />
          <div className="absolute tour-sheet" onMouseDown={skip} style={{ left: rect.x + rect.w, top: rect.y, width: Math.max(0, vw - rect.x - rect.w), height: rect.h, background: dim }} />
          <div className="absolute tour-sheet" onMouseDown={skip} style={{ left: 0, top: rect.y + rect.h, width: vw, height: Math.max(0, vh - rect.y - rect.h), background: dim }} />
          <div className="absolute pointer-events-none rounded-xl tour-ring" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} data-tour-ring />
          {leader && (
            <svg className="absolute inset-0 pointer-events-none tour-leader" width={vw} height={vh} aria-hidden>
              <line x1={leader.x1} y1={leader.y1} x2={leader.x2} y2={leader.y2} stroke={accent} strokeWidth={1.5} strokeDasharray="3 4" />
              <circle cx={leader.x2} cy={leader.y2} r={3.5} fill={accent} />
            </svg>
          )}
        </>
      ) : (
        <div className="absolute inset-0 tour-sheet" onMouseDown={skip} style={{ background: dim }} />
      )}

      <div
        ref={cardRef}
        tabIndex={-1}
        key={cur.id}
        className="absolute rounded-2xl border outline-none tour-card-in"
        style={{ left: pos.x, top: pos.y, width: cardW, background: "var(--sol-card)", borderColor: `color-mix(in srgb, ${accent} 42%, transparent)`, boxShadow: `0 24px 60px -24px rgba(0,0,0,0.6), 0 0 0 1px color-mix(in srgb, ${accent} 12%, transparent)` }}
        data-tour-card
      >
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="w-[7px] h-[7px] rounded-full shrink-0" style={{ background: accent }} />
          <span className="text-[11px] truncate" style={{ color: "var(--sol-text-dim)" }} title={areaLabel}>{def.title}</span>
          <span className="ml-auto text-[10.5px] tabular-nums shrink-0" style={{ color: "var(--sol-text-dim)" }} data-tour-count>{shownIndex + 1} of {shown.length}</span>
          <button type="button" onClick={skip} aria-label="Close the tour" className="w-6 h-6 -mr-2 inline-flex items-center justify-center rounded-md hover:bg-sol-bg-highlight shrink-0" style={{ color: "var(--sol-text-dim)" }} data-tour-close>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="px-4 pt-2.5">
          <h3 className="text-[16px] leading-tight font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }} data-tour-title>{cur.title}</h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-secondary, var(--sol-text-muted))" }} data-tour-body>{cur.body}</p>
          {phase.kind === "missing" && (
            <p className="mt-1.5 text-[11px]" style={{ color: "var(--sol-text-dim)" }} data-tour-missing>Not on this screen right now.</p>
          )}
        </div>
        <div className="mt-3 px-4 pb-3 flex items-center gap-2">
          <div className="flex items-center gap-1" aria-hidden>
            {shown.map((st, i) => (
              <span key={st.id} className="h-[5px] rounded-full transition-all duration-300" style={{ width: i === shownIndex ? 18 : 5, background: i === shownIndex ? accent : "color-mix(in srgb, var(--sol-border) 70%, transparent)" }} />
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            {shownIndex > 0 && (
              <button type="button" onClick={() => go(step - 1)} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} data-tour-back>Back</button>
            )}
            {action && (
              <button type="button" onClick={() => { qs(action.click)?.click(); go(step + 1); }} className="h-7 px-2.5 rounded-md text-[12px] font-medium border hover:bg-sol-bg-highlight" style={{ borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`, color: accent }} data-tour-action>{action.label}</button>
            )}
            <button type="button" onClick={() => go(step + 1)} className="h-7 px-3 rounded-md text-[12px] font-semibold hover:brightness-110" style={{ background: accent, color: "var(--sol-bg)" }} data-tour-next>{last ? "Done" : "Next"}</button>
          </div>
        </div>
        <div className="px-4 pb-2.5 -mt-1 flex items-center gap-3 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">→</KeyCap> next</span>
          <span className="inline-flex items-center gap-1"><KeyCap size="xs">esc</KeyCap> close</span>
        </div>
      </div>
    </div>
  );
}
