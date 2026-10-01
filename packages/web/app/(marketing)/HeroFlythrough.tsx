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

import { useRef, useState, type CSSProperties } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { DOTS } from "./chapterDots";
import { useHeroChapters } from "./heroFly/chapters";
import { createFilmClock, FilmClockContext, POSTER_FRAME } from "./heroFly/filmClock";
import { HeroSandbox } from "./heroFly/sandbox";
import { frame, wrapT } from "./heroFly/timeline";
import { World } from "./heroFly/surfaces";
import { DURATION, POSTER_T, SCENES, STILLS } from "./heroFly/world";

const STAGE = { desktop: { w: 1280, h: 760 }, mobile: { w: 640, h: 800 } };
const REDUCED_STEP_MS = 5000;

const sceneAt = (t: number) => {
  const w = wrapT(t);
  const i = SCENES.findIndex((s) => w >= s.start && w < s.end);
  return i < 0 ? SCENES.length - 1 : i;
};

const POSTER_SCENE = sceneAt(POSTER_T);

const DESCRIPTION =
  "A looping tour of codecast: a live inbox of Claude Code, Codex, Cursor, Gemini, OpenCode and pi sessions; steering a session from its conversation; a lead session spawning two workers; a permission prompt approved from an iPhone; two agents messaging each other and forking; a decision queued for a person; a task filed from the conversation, claimed by an agent and synced to Linear; a trigger and a workflow running on their own; the team's channel and a huddle with live captions; a pull request going green and merging; a report published as a page; a teammate finding the session weeks later and tracing a line of code to it with cast blame; and sessions running on a laptop and a cloud host, where a worker drives a browser to check its change on staging.";

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
 * Prerender scale for the stage: the film box's own width over the stage's
 * (tan(atan2()) divides two lengths), so the poster fits before the driver
 * replaces it with the exact fit on mount. Below 640px the box is 4:5 and the
 * desktop poster sits in its middle until the driver frames it for a phone.
 */
/**
 * The edge of the film. The layer spans the window's width (100cqw is the
 * film's own width, from the figure) and reaches FADE_Y above and below the
 * film; a mask keeps the film's box fully visible and fades everything around
 * it to nothing by the window's edge, at least FADE_X wide on a narrow screen.
 */
const FADE_X = 72;
const FADE_Y = 40;
const H_MASK = `linear-gradient(to right, transparent 0, #000 max(${FADE_X}px, calc(50% - 50cqw)), #000 min(calc(100% - ${FADE_X}px), calc(50% + 50cqw)), transparent 100%)`;
const V_MASK = `linear-gradient(to bottom, transparent 0, #000 ${FADE_Y}px, #000 calc(100% - ${FADE_Y}px), transparent 100%)`;
const BLEED: CSSProperties = {
  width: "100vw",
  marginInline: "calc(50cqw - 50vw)",
  paddingBlock: FADE_Y,
  marginBlock: -FADE_Y,
  overflow: "clip",
  maskImage: `${H_MASK}, ${V_MASK}`,
  maskComposite: "intersect",
  WebkitMaskImage: `${H_MASK}, ${V_MASK}`,
  WebkitMaskComposite: "source-in",
};

const FALLBACK_SCALE_CSS = [
  ".hf-box{container-type:inline-size}",
  ".hf-stage{--hf-s:0.8;--hf-s:tan(atan2(100cqw,1280px));top:0}",
  "@media (max-width:639px){.hf-stage{top:calc(100cqw * 0.328)}}",
  // The film's width follows the viewport's height, so the scrubber's names hide by its own width: below about 70px a chapter, the dots and the caption carry it.
  ".hf-scrub{container-type:inline-size}@container (max-width:900px){.hf-name{display:none!important}}",
  "@keyframes hf-cap{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}",
  "@keyframes hf-cap-fade{from{opacity:0}to{opacity:1}}",
  "@media (prefers-reduced-motion:reduce){.hf-cap{animation-name:hf-cap-fade!important}}",
  // A region whose views arrive after the prerender (the poster's conversation pane) fades in rather than popping.
  "@keyframes hf-in{from{opacity:0}}.hf-in{animation:hf-in 300ms ease}",
  // A region's box lets clicks through to the regions under it; the views placed in it take them (heroFly/surfaces.tsx RegionSlot).
  "[data-region]>*{pointer-events:auto}",
].join("");

export function HeroFlythrough() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
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
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!wrap || !stage || !world) return;

    const params = new URLSearchParams(window.location.search);
    const frozenAt = params.get("hero-t");
    const reduced = params.get("hero-reduced") === "1" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const mq = window.matchMedia("(max-width: 639px)");
    const forceMobile = params.get("hero-mobile") === "1";

    // Chapters load after first paint and views mount elements as the film
    // moves, so the element maps are rebuilt whenever the world's DOM changes.
    // What was written is remembered per element, so a remount rewrites only
    // the elements that are new.
    const nodes = new Map<string, HTMLElement | SVGElement>();
    const textNodes = new Map<string, HTMLElement>();
    const written = new WeakMap<Element, Record<string, string>>();
    let stale = true;
    const scan = () => {
      stale = false;
      nodes.clear();
      textNodes.clear();
      world.querySelectorAll<HTMLElement | SVGElement>("[data-fly]").forEach((n) => nodes.set(n.getAttribute("data-fly")!, n));
      world.querySelectorAll<HTMLElement>("[data-fly-text]").forEach((n) => textNodes.set(n.getAttribute("data-fly-text")!, n));
    };
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
      scene: POSTER_SCENE,
      still: 0,
    };

    const render = (t: number) => {
      if (stale) scan();
      st.t = wrapT(t);
      clock.set(st.t);
      const f = frame(st.t, st.mobile);
      put(world, "t", (v) => (world.style.transform = v), f.camera);
      put(world, "will", (v) => (world.style.willChange = v), f.moving && !reduced ? "transform" : "auto");
      for (const id in f.els) {
        const n = nodes.get(id);
        if (!n) continue;
        const e = f.els[id];
        if (e.transform !== undefined) put(n, "t", (v) => (n.style.transform = v), e.transform);
        if (e.opacity !== undefined) put(n, "o", (v) => (n.style.opacity = v), String(e.opacity));
        if (e.visible !== undefined) put(n, "v", (v) => (n.style.visibility = v), e.visible ? "visible" : "hidden");
        if (e.dash !== undefined) put(n, "d", (v) => (n.style.strokeDashoffset = v), String(e.dash));
      }
      for (const id in f.texts) {
        const n = textNodes.get(id);
        if (n) put(n, "x", (v) => (n.textContent = v), f.texts[id]);
      }
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
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
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
      if (window.__heroFly === api) delete window.__heroFly;
    };
  }, [motionPref]);

  const size = mobile ? STAGE.mobile : STAGE.desktop;

  return (
    <figure role="group" aria-label="Codecast product tour" className="m-0" style={{ containerType: "inline-size" }}>
      <style>{FALLBACK_SCALE_CSS}</style>
      <p className="sr-only">{DESCRIPTION}</p>
      <HeroSandbox fallback={<div className="w-full aspect-[1280/760] max-sm:aspect-[4/5]" />}>
      {/* No frame: the screens sit on the page itself. The film keeps its box for layout, but what the camera sees around it runs out to the window's edges and fades there, and just above and below the box, instead of being cut at a border. */}
      <div className="hf-bleed pointer-events-none relative" style={BLEED}>
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

      <div className="mt-4 flex items-center gap-3 font-mono">
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
        <ol className="hf-scrub flex min-w-0 flex-1 gap-1">
          {SCENES.map((s, i) => (
            <li key={s.name} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => ctl.current?.jump(i)}
                aria-current={i === scene ? "step" : undefined}
                aria-label={`Chapter ${i + 1}: ${s.name}`}
                className="group relative flex min-h-6 w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-2.5 text-left transition-colors hover:bg-[#eee8d5]/70 sm:py-1.5"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: DOTS[i % DOTS.length], opacity: i === scene ? 1 : 0.55 }} />
                <span className={`hf-name hidden truncate text-[11px] sm:inline ${i === scene ? "text-[#002b36]" : "text-[#93a1a1] group-hover:text-[#586e75]"}`}>{s.name}</span>
                <span className="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full" style={{ backgroundColor: "#eee8d5" }} />
                <span
                  ref={(b) => {
                    barsRef.current[i] = b;
                  }}
                  className="absolute inset-x-1.5 bottom-0 h-[2px] origin-left rounded-full"
                  // Constant after mount (the poster's scene, not `scene`), so React never overwrites what the driver wrote.
                  style={{ backgroundColor: DOTS[i % DOTS.length], transform: `scaleX(${i === POSTER_SCENE ? ((POSTER_T - s.start) / (s.end - s.start)).toFixed(3) : 0})` }}
                />
              </button>
            </li>
          ))}
        </ol>
      </div>
      {/* Every caption sits in one grid cell, so the cell is always the tallest caption's height and nothing below moves as chapters change. */}
      <figcaption className="mt-2 grid text-left font-mono text-[13px] leading-relaxed text-[#657b83]">
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
