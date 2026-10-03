"use client";

/**
 * The homepage hero: a looping 3D fly-through of the product, rendering the
 * real app's views with fixture data inside a sandbox (heroFly/sandbox.tsx).
 * One world, one camera, one timeline (heroFly/). React renders the world
 * when its chapters load; a single requestAnimationFrame driver writes
 * `frame(t)` straight to the DOM and ticks the film clock, so a view
 * re-renders only when a value it derives from film time changes.
 *
 * With reduced motion the film is a set of chapter stills: it opens paused on
 * the first, the scrubber picks any, and Play steps through them.
 *
 * Verification hook: `window.__heroFly` seeks, pauses and plays, and
 * `?hero-t=<seconds>` freezes the film at that time. `?hero-reduced=1`
 * previews the reduced-motion version and `?hero-mobile=1` the phone framing.
 */

import { useRef, useState, type CSSProperties, type RefObject } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { DOTS } from "./chapterDots";
import { useHeroChapters } from "./heroFly/chapters";
import { createFilmClock, FilmClockContext, POSTER_FRAME } from "./heroFly/filmClock";
import { STAGE_SIZE as STAGE } from "./heroFly/project";
import { HeroSandbox } from "./heroFly/sandbox";
import { frame, warm, wrapT } from "./heroFly/timeline";
import { World } from "./heroFly/surfaces";
import { DURATION, POSTER_T, SCENES, STILLS } from "./heroFly/world";

const REDUCED_STEP_MS = 5000;

const sceneAt = (t: number) => {
  const w = wrapT(t);
  const i = SCENES.findIndex((s) => w >= s.start && w < s.end);
  return i < 0 ? SCENES.length - 1 : i;
};

const POSTER_SCENE = sceneAt(POSTER_T);

const DESCRIPTION =
  "A looping tour of codecast: a live inbox of Claude Code, Codex, Cursor, Gemini, OpenCode and pi sessions; steering a session from its conversation; a lead session spawning two workers; a worker's question answered in chat from the codecast app on an iPhone, the worker replying and carrying on; two agents messaging each other and forking; a decision queued for a person; a task filed from the conversation, claimed by an agent and synced to Linear; a trigger and a workflow running on their own; the team's channel and a huddle with live captions; a pull request going green and merging; a report published as a page; a teammate finding the session weeks later and tracing a line of code to it with cast blame; and sessions running on a laptop and a cloud host, where a worker drives a browser to check its change on staging.";

type HeroFlyApi = {
  seek(seconds: number): void;
  pause(): void;
  play(): void;
  duration: number;
  scenes: { name: string; start: number; end: number }[];
  readonly t: number;
};

declare global {
  interface Window {
    __heroFly?: HeroFlyApi;
  }
}

/**
 * The edge of the film. There is no frame, nothing fades and nothing clips:
 * the screens are windows on the page, shadows and all. The layer spans the
 * page's width (100cqw is the film's own width, from the figure) and is the
 * film's height. What keeps the page clean is the camera, not a clip: a hold
 * shows only the windows it is about (timeline.ts transitOpacity), and every
 * visible window stays wholly inside the film's height, lifting out whole
 * when it must leave across the top or bottom (timeline.test).
 */
const BLEED: CSSProperties = {
  // The page's own width, set by the driver from the root's client width: 100vw counts a classic scrollbar and would push the world's centre off the column's. 100vw is the prerender's guess.
  width: "var(--hf-page-w, 100vw)",
  marginInline: "calc(50cqw - var(--hf-page-w, 100vw) / 2)",
  overflow: "visible",
};

/** Room a chapter takes beside its name: the dot, the gap after it, the button's padding, and the gap between chapters (px). */
const CHAPTER_CHROME = 6 + 4 + 8 + 4;
/** A chapter's room inside its own box: the chrome less the gap between chapters. */
const CHAPTER_INNER = CHAPTER_CHROME - 4;
/** A dot's own room: the dot and the button's padding. */
const CHAPTER_DOT = 6 + 8;
/** The bar's width (px) from which every name fits whole, before the names are measured: their characters at the 11px mono's advance, with each chapter's chrome. */
const CHAPTER_NAMES_FIT = Math.ceil(SCENES.reduce((n, s) => n + s.name.length * 6.7 + CHAPTER_CHROME, 0));
/** How a chapter's room eases as the current chapter changes or the bar resizes. */
const CHAPTER_EASE = "300ms cubic-bezier(0.25, 0.5, 0.3, 1)";

/**
 * Prerender scale for the stage: the film box's own width over the stage's
 * (tan(atan2()) divides two lengths), so the poster fits before the driver
 * replaces it with the exact fit on mount. Below 640px the box is 4:5 and the
 * desktop poster sits in its middle until the driver frames it for a phone.
 */
const FALLBACK_SCALE_CSS = [
  ".hf-box{container-type:inline-size}",
  ".hf-stage{--hf-s:0.8;--hf-s:tan(atan2(100cqw,1280px));top:0}",
  "@media (max-width:639px){.hf-stage{top:calc(100cqw * 0.328)}}",
  "@keyframes hf-cap{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
  "@keyframes hf-cap-fade{from{opacity:0}to{opacity:1}}",
  "@media (prefers-reduced-motion:reduce){.hf-cap{animation-name:hf-cap-fade!important}}",
  // Reduced motion: the chapter bar's room and names change at once, without the eased slide.
  "@media (prefers-reduced-motion:reduce){.hf-chaps li,.hf-chaps [data-name]{transition:none!important}}",
  // A region whose views arrive after the prerender (the poster's conversation pane) fades in rather than popping.
  "@keyframes hf-in{from{opacity:0}}.hf-in{animation:hf-in 300ms ease}",
  // Inside the film every change is film time's (FilmSwap, FilmGrow, beats): a view's own wall-clock transition would replay a change the film already made, or stall in a background tab.
  ".hf-stage *{transition:none!important}",
  // Except a visitor's own hover and press on the film's live controls, which ease their colours as the app's do.
  ".hf-stage [data-hero-live],.hf-stage [data-hero-live] *{transition:color 150ms,background-color 150ms,border-color 150ms!important}",
  // A region's box lets clicks through to the regions under it; the views placed in it take them (heroFly/surfaces.tsx RegionSlot).
  "[data-region]>*{pointer-events:auto}",
  // The chapter bar before it has measured its names (useChapterNamesFit): the current chapter named and dots for the rest, every name once the bar is wide enough for all of them (CHAPTER_NAMES_FIT, about what the measure finds), so the first paint is the measured layout.
  ".hf-chaps{container-type:inline-size}",
  ".hf-chaps:not([data-measured])>li{flex:1 1 0px}",
  ".hf-chaps:not([data-measured])>li[data-on]{flex:0 0 auto}",
  ".hf-chaps:not([data-measured])>li:not([data-on]) [data-name]{max-width:0;opacity:0}",
  `@container (min-width:${CHAPTER_NAMES_FIT}px){.hf-chaps:not([data-measured])>li{flex:1 0 auto!important}.hf-chaps:not([data-measured])>li [data-name]{max-width:none!important;opacity:1!important}}`,
].join("");


/**
 * Whether the chapter bar fits every name whole, from the names' own widths
 * and the bar's, kept as the bar resizes and once the font has loaded; with
 * each name's width, so a name opening or closing eases to its exact size.
 */
type NamesFit = { all: boolean; widths: number[]; ease: boolean };

/**
 * Null until measured, when the bar lays itself out by CSS alone (a
 * container query at CHAPTER_NAMES_FIT). `ease` turns on a frame after the
 * first measure, so the measured layout takes over without animating and
 * only later changes (a chapter turning, the bar resizing) ease.
 */
function useChapterNamesFit(ref: RefObject<HTMLOListElement | null>): NamesFit | null {
  const [fit, setFit] = useState<NamesFit | null>(null);
  useMountEffect(() => {
    const ol = ref.current;
    if (!ol) return;
    const measure = () => {
      const widths = [...ol.querySelectorAll<HTMLElement>("[data-name]")].map((n) => Math.ceil(n.scrollWidth));
      const need = widths.reduce((a, w) => a + w + CHAPTER_CHROME, 0);
      const all = need <= ol.clientWidth;
      setFit((f) => (f && f.all === all && f.widths.join() === widths.join() ? f : { all, widths, ease: f?.ease ?? false }));
      requestAnimationFrame(() => setFit((f) => (f && !f.ease ? { ...f, ease: true } : f)));
    };
    measure();
    void document.fonts?.ready.then(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(ol);
    return () => ro.disconnect();
  });
  return fit;
}

export function HeroFlythrough() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const bleedRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const scrubRef = useRef<HTMLOListElement>(null);
  const names = useChapterNamesFit(scrubRef);
  const ctl = useRef<{ toggle(): void; jump(i: number): void } | null>(null);
  const [scene, setScene] = useState(POSTER_SCENE);
  const [playing, setPlaying] = useState(true);
  const [mobile, setMobile] = useState(false);
  // Bumped when the visitor turns reduced motion on or off mid-visit, so the driver restarts as the film or as stills.
  const [motionPref, setMotionPref] = useState(0);
  const chapters = useHeroChapters();
  const [clock] = useState(() => createFilmClock());
  const [now] = useState(() => Date.now());

  useWatchEffect(() => {
    const wrap = wrapRef.current;
    const bleed = bleedRef.current;
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!wrap || !bleed || !stage || !world) return;

    const params = new URLSearchParams(window.location.search);
    const frozenAt = params.get("hero-t");
    const reduced = params.get("hero-reduced") === "1" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mq = window.matchMedia("(max-width: 639px)");
    const forceMobile = params.get("hero-mobile") === "1";

    // Chapters load after first paint and views mount elements as the film
    // moves, so the element maps are rebuilt whenever the world's DOM changes.
    // What was written is remembered per element, so a remount rewrites only
    // the elements that are new.
    // The seam's copy of the opening window (surfaces.tsx SeamGhost) repeats the live window's ids: its elements are kept apart and always written the film's first frame.
    const nodes = new Map<string, HTMLElement | SVGElement>();
    const textNodes = new Map<string, HTMLElement>();
    const ghostNodes = new Map<string, HTMLElement | SVGElement>();
    const ghostTextNodes = new Map<string, HTMLElement>();
    const written = new WeakMap<Element, Record<string, string>>();
    let stale = true;
    const scan = () => {
      stale = false;
      for (const m of [nodes, textNodes, ghostNodes, ghostTextNodes]) m.clear();
      const inGhost = (n: Element) => n.closest("[data-fly-ghost]") !== null;
      world.querySelectorAll<HTMLElement | SVGElement>("[data-fly]").forEach((n) => (inGhost(n) ? ghostNodes : nodes).set(n.getAttribute("data-fly")!, n));
      world.querySelectorAll<HTMLElement>("[data-fly-text]").forEach((n) => (inGhost(n) ? ghostTextNodes : textNodes).set(n.getAttribute("data-fly-text")!, n));
    };
    const opening: Partial<Record<"desktop" | "mobile", ReturnType<typeof frame>>> = {};
    const mo = new MutationObserver((records) => {
      // The driver's own typed text replaces text nodes; that changes nothing it drives.
      if (records.every((r) => r.target instanceof Element && r.target.hasAttribute("data-fly-text"))) return;
      stale = true;
      if (!st.playing || reduced) render(st.t);
    });
    mo.observe(world, { childList: true, subtree: true });
    const put = (el: Element, key: string, apply: (v: string) => void, v: string) => {
      let w = written.get(el);
      if (!w) written.set(el, (w = {}));
      if (w[key] === v) return;
      w[key] = v;
      apply(v);
    };

    const st = {
      t: POSTER_T,
      // Reduced motion never advances on its own: the stills step only once the visitor presses Play.
      playing: frozenAt === null && !reduced,
      anchorT: POSTER_T,
      anchorWall: performance.now(),
      onScreen: true,
      docVisible: document.visibilityState !== "hidden",
      mobile: forceMobile || mq.matches,
      // How far the page reaches beyond either side of the film, in stage px: windows come and go beyond it (timeline.ts transitOpacity).
      side: undefined as number | undefined,
      scene: POSTER_SCENE,
      still: 0,
    };

    const render = (t: number) => {
      if (stale) scan();
      clock.view = { mobile: st.mobile, side: st.side };
      st.t = wrapT(t);
      clock.set(st.t);
      const f = frame(st.t, st.mobile, st.side);
      put(world, "t", (v) => (world.style.transform = v), f.camera);
      put(world, "will", (v) => (world.style.willChange = v), f.moving && !reduced ? "transform" : "auto");
      const write = (fr: ReturnType<typeof frame>, els: Map<string, HTMLElement | SVGElement>, texts: Map<string, HTMLElement>) => {
        for (const [id, n] of els) {
          const e = fr.els[id];
          if (!e) continue;
          if (e.transform !== undefined) put(n, "t", (v) => (n.style.transform = v), e.transform);
          if (e.opacity !== undefined) put(n, "o", (v) => (n.style.opacity = v), String(e.opacity));
          if (e.visible !== undefined) put(n, "v", (v) => (n.style.visibility = v), e.visible ? "visible" : "hidden");
          if (e.dash !== undefined) put(n, "d", (v) => (n.style.strokeDashoffset = v), String(e.dash));
        }
        for (const [id, n] of texts) {
          const x = fr.texts[id];
          if (x !== undefined) put(n, "x", (v) => (n.textContent = v), x);
        }
      };
      write(f, nodes, textNodes);
      if (ghostNodes.size || ghostTextNodes.size) write((opening[st.mobile ? "mobile" : "desktop"] ??= frame(0, st.mobile)), ghostNodes, ghostTextNodes);
      const k = sceneAt(st.t);
      if (k !== st.scene) {
        st.scene = k;
        setScene(k);
      }
      barsRef.current.forEach((b, i) => {
        if (!b) return;
        const sc = SCENES[i];
        const p = i === k ? (reduced ? 1 : (st.t - sc.start) / (sc.end - sc.start)) : 0;
        put(b, "t", (v) => (b.style.transform = v), `scaleX(${p.toFixed(3)})`);
      });
    };

    const fit = () => {
      const { w, h } = st.mobile ? STAGE.mobile : STAGE.desktop;
      const s = wrap.clientWidth / w;
      stage.style.width = `${w}px`;
      stage.style.height = `${h}px`;
      stage.style.top = "0px";
      stage.style.setProperty("--hf-s", String(s));
      const pageW = document.documentElement.clientWidth;
      bleed.style.setProperty("--hf-page-w", `${pageW}px`);
      st.side = Math.max(0, (pageW - wrap.clientWidth) / 2 / s);
      // What the moves need for this page (timeline.ts warm) is built in idle time, ahead of the first move, so no frame pays for it.
      const idle = window.requestIdleCallback ?? ((fn: () => void) => window.setTimeout(fn, 200));
      const [m, side] = [st.mobile, st.side];
      idle(() => warm(m, side));
    };

    let raf = 0;
    const running = () => st.playing && st.onScreen && st.docVisible && !reduced;
    const loop = () => {
      raf = 0;
      if (!running()) return;
      render(st.anchorT + (performance.now() - st.anchorWall) / 1000);
      raf = requestAnimationFrame(loop);
    };
    const reanchor = () => {
      st.anchorT = st.t;
      st.anchorWall = performance.now();
    };
    const kick = () => {
      reanchor();
      if (running() && !raf) raf = requestAnimationFrame(loop);
    };

    // Reduced motion: chapter stills, cross-faded every few seconds while playing.
    let fadeTimer = 0;
    const showStill = (i: number, fade: boolean) => {
      st.still = (i + SCENES.length) % SCENES.length;
      if (!fade) return render(STILLS[st.still]);
      stage.style.transition = "opacity 200ms ease";
      stage.style.opacity = "0";
      window.clearTimeout(fadeTimer);
      fadeTimer = window.setTimeout(() => {
        render(STILLS[st.still]);
        stage.style.opacity = "1";
      }, 200);
    };
    const stillTimer = reduced
      ? window.setInterval(() => {
          if (st.playing && st.onScreen && st.docVisible) showStill(st.still + 1, true);
        }, REDUCED_STEP_MS)
      : 0;

    const setPlay = (on: boolean) => {
      st.playing = on;
      setPlaying(on);
      kick();
    };

    const api: HeroFlyApi = {
      seek(seconds: number) {
        render(seconds);
        reanchor();
      },
      pause: () => setPlay(false),
      play: () => setPlay(true),
      duration: DURATION,
      scenes: SCENES.map(({ name, start, end }) => ({ name, start, end })),
      get t() {
        return st.t;
      },
    };
    window.__heroFly = api;
    ctl.current = {
      toggle: () => setPlay(!st.playing),
      jump: (i: number) => {
        if (reduced) showStill(i, true);
        else api.seek(SCENES[i].hold);
      },
    };

    const reducedMq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onReduced = () => setMotionPref((n) => n + 1);
    reducedMq.addEventListener("change", onReduced);
    const onMq = () => {
      st.mobile = forceMobile || mq.matches;
      setMobile(st.mobile);
      fit();
      render(st.t);
    };
    mq.addEventListener("change", onMq);
    // A new page width moves where windows come and go: redraw the frame for it, playing or not.
    const ro = new ResizeObserver(() => {
      fit();
      render(st.t);
    });
    ro.observe(wrap);
    // The root's width changes without the film's when a scrollbar comes or goes.
    ro.observe(document.documentElement);
    const io = new IntersectionObserver(([e]) => {
      st.onScreen = e.isIntersecting;
      kick();
    });
    io.observe(wrap);
    const onVis = () => {
      st.docVisible = document.visibilityState !== "hidden";
      kick();
    };
    document.addEventListener("visibilitychange", onVis);
    // The film is hidden from assistive tech, but its live fields (the palette's search) can take focus by pointer: while one has it, the film is exposed, so focus never sits inside an aria-hidden subtree.
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof HTMLElement && e.target.matches("input,textarea,[contenteditable]")) wrap.removeAttribute("aria-hidden");
    };
    const onFocusOut = () => wrap.setAttribute("aria-hidden", "true");
    wrap.addEventListener("focusin", onFocusIn);
    wrap.addEventListener("focusout", onFocusOut);

    setMobile(st.mobile);
    fit();
    if (frozenAt !== null) {
      setPlaying(false);
      render(Number(frozenAt) || 0);
    } else if (reduced) {
      setPlaying(false);
      showStill(0, false);
    } else {
      render(POSTER_T);
      kick();
    }

    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(stillTimer);
      window.clearTimeout(fadeTimer);
      mq.removeEventListener("change", onMq);
      reducedMq.removeEventListener("change", onReduced);
      stage.style.opacity = "1";
      mo.disconnect();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      wrap.removeEventListener("focusin", onFocusIn);
      wrap.removeEventListener("focusout", onFocusOut);
      if (window.__heroFly === api) delete window.__heroFly;
    };
  }, [motionPref]);

  const size = mobile ? STAGE.mobile : STAGE.desktop;

  return (
    <figure role="group" aria-label="Codecast product tour" className="m-0" style={{ containerType: "inline-size" }}>
      <style>{FALLBACK_SCALE_CSS}</style>
      <p className="sr-only">{DESCRIPTION}</p>
      <HeroSandbox now={now} fallback={<div className="w-full aspect-[1280/760] max-sm:aspect-[4/5]" />}>
      {/* No frame, no fade, no clip: the screens sit on the page itself (BLEED). */}
      <div ref={bleedRef} className="hf-bleed pointer-events-none relative" style={BLEED}>
      <div
        ref={wrapRef}
        aria-hidden
        className="hf-box pointer-events-auto relative mx-auto aspect-[1280/760] max-sm:aspect-[4/5]"
        style={{ width: "100cqw" }}
      >
        <div
          ref={stageRef}
          className="hf-stage absolute left-0 top-0 origin-top-left"
          style={{ width: size.w, height: size.h, transform: "scale(var(--hf-s))", perspective: "1800px", perspectiveOrigin: "50% 50%" }}
        >
          <div ref={worldRef} className="absolute left-1/2 top-1/2 h-0 w-0" style={{ transformStyle: "preserve-3d", transform: POSTER_FRAME.camera }}>
            <FilmClockContext.Provider value={clock}>
              <World chapters={chapters} now={now} />
            </FilmClockContext.Provider>
          </div>
        </div>
      </div>
      </div>
      </HeroSandbox>

      <div className="relative z-[1] mt-4 flex items-center gap-3 font-mono">
        <button
          type="button"
          onClick={() => ctl.current?.toggle()}
          aria-label={playing ? "Pause the tour" : "Play the tour"}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[#eee8d5]"
          style={{ border: "1px solid #e4ddc8", borderBottomWidth: 2, color: "#586e75", backgroundColor: "#fdf6e3" }}
        >
          {playing ? (
            <svg className="h-2.5 w-2.5" viewBox="0 0 10 10" fill="currentColor" aria-hidden><rect x="1.5" y="1" width="2.4" height="8" rx="0.6" /><rect x="6.1" y="1" width="2.4" height="8" rx="0.6" /></svg>
          ) : (
            <svg className="ml-0.5 h-2.5 w-2.5" viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.6.6 0 0 0 .9.5l6.1-3.8a.6.6 0 0 0 0-1L2.9.7a.6.6 0 0 0-.9.5z" /></svg>
          )}
        </button>
        <ol ref={scrubRef} className="hf-chaps flex min-w-0 flex-1 gap-1" data-measured={names ? "" : undefined}>
          {SCENES.map((s, i) => {
            // Every name whole when the bar fits them all; otherwise the current chapter's name and dots for the rest. Never an ellipsis.
            // Each chapter's room is a basis that eases (never a switch of flex classes), so the dots part and close smoothly around the name that opens.
            const named = !names || names.all || i === scene;
            const nameW = names?.widths[i];
            const room: CSSProperties | undefined = names
              ? {
                  flexBasis: named && nameW !== undefined ? nameW + CHAPTER_INNER : CHAPTER_DOT,
                  flexGrow: names.all || !named ? 1 : 0,
                  flexShrink: named ? 0 : 1,
                  transition: names.ease ? `flex-basis ${CHAPTER_EASE}, flex-grow ${CHAPTER_EASE}` : undefined,
                }
              : undefined;
            return (
            <li key={s.name} className="min-w-0" style={room} data-on={i === scene ? "" : undefined}>
              <button
                type="button"
                onClick={() => ctl.current?.jump(i)}
                aria-current={i === scene ? "step" : undefined}
                aria-label={`Chapter ${i + 1}: ${s.name}`}
                className="group relative flex min-h-6 w-full items-center gap-1 overflow-hidden rounded-md px-1 py-2.5 text-left transition-colors hover:bg-[#eee8d5]/70 sm:py-1.5"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: DOTS[i % DOTS.length], opacity: i === scene ? 1 : 0.55 }} />
                <span
                  data-name
                  className={`overflow-hidden whitespace-nowrap text-[11px] ${i === scene ? "text-[#002b36]" : "text-[#93a1a1] group-hover:text-[#586e75]"}`}
                  style={names ? { maxWidth: named ? (nameW ?? "none") : 0, opacity: named ? 1 : 0, transition: names.ease ? `max-width ${CHAPTER_EASE}, opacity ${CHAPTER_EASE}, color 150ms` : undefined } : undefined}
                >
                  {s.name}
                </span>
                <span className="absolute inset-x-1 bottom-0 h-[2px] rounded-full" style={{ backgroundColor: "#eee8d5" }} />
                <span
                  ref={(b) => {
                    barsRef.current[i] = b;
                  }}
                  className="absolute inset-x-1 bottom-0 h-[2px] origin-left rounded-full"
                  // Constant after mount (the poster's scene, not `scene`), so React never overwrites what the driver wrote.
                  style={{ backgroundColor: DOTS[i % DOTS.length], transform: `scaleX(${i === POSTER_SCENE ? ((POSTER_T - s.start) / (s.end - s.start)).toFixed(3) : 0})` }}
                />
              </button>
            </li>
            );
          })}
        </ol>
      </div>
      {/* Every caption sits in one grid cell, so the cell is always the tallest caption's height and nothing below moves as chapters change. */}
      <figcaption className="relative z-[1] mt-2 grid text-left font-mono text-[13px] leading-relaxed text-[#657b83]">
        {SCENES.map((s, i) => (
          <span
            key={i === scene ? `on${i}` : i}
            aria-hidden={i !== scene}
            className={`hf-cap [grid-area:1/1] ${i === scene ? "" : "invisible"}`}
            style={i === scene ? { animation: "hf-cap 350ms cubic-bezier(0.16,1,0.3,1)" } : undefined}
          >
            <span className="text-[#002b36]">{s.name}.</span> {s.caption}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
