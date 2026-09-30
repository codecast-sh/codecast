"use client";

/**
 * The homepage hero: a looping 3D fly-through of the product, rendering the
 * real app's views with fixture data inside a sandbox (heroFly/sandbox.tsx).
 * One world, one camera, one timeline (heroFly/). React renders the world
 * when its chapters load; a single requestAnimationFrame driver writes
 * `frame(t)` straight to the DOM and ticks the film clock, so a view
 * re-renders only when a value it derives from film time changes.
 *
 * Verification hook: `window.__heroFly` seeks, pauses and plays, and
 * `?hero-t=<seconds>` freezes the film at that time. `?hero-reduced=1`
 * previews the reduced-motion version and `?hero-mobile=1` the phone framing.
 */

import { useRef, useState } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { DOTS } from "./TourFilm";
import { useHeroChapters } from "./heroFly/chapters";
import { createFilmClock, FilmClockContext } from "./heroFly/film";
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

const DESCRIPTION =
  "A looping tour of codecast: a live inbox of Claude Code, Codex, Cursor, Gemini and pi sessions; steering a session from its conversation; a lead session spawning two workers; a permission prompt approved from an iPhone; two agents messaging each other and forking; a decision queued for a person; a task filed from the conversation and claimed by an agent; a trigger and a workflow running on their own; the team's channel, huddle and org chart; a pull request going green and merging; a report published as a page; a teammate finding the session weeks later and tracing a line of code to it with cast blame; and sessions running on a laptop, a cloud host and in a browser.";

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

/** Prerender scale for the stage, stepped by viewport width; the driver replaces it with the exact fit on mount. */
const FALLBACK_SCALE_CSS = (() => {
  const rules: string[] = [".hf-stage{--hf-s:0.8625}"];
  for (let vw = 320; vw < 1152; vw += 32) {
    const cw = Math.min(vw, 1152) - 48;
    rules.push(`@media (min-width:${vw}px){.hf-stage{--hf-s:${(cw / 1280).toFixed(4)}}}`);
  }
  rules.push(`@media (min-width:1152px){.hf-stage{--hf-s:0.8625}}`);
  rules.push("@keyframes hf-cap{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}");
  return rules.join("");
})();

export function HeroFlythrough() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<(HTMLSpanElement | null)[]>([]);
  const ctl = useRef<{ toggle(): void; jump(i: number): void } | null>(null);
  const [scene, setScene] = useState(sceneAt(POSTER_T));
  const [playing, setPlaying] = useState(true);
  const [mobile, setMobile] = useState(false);
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
    const nodes = new Map<string, HTMLElement | SVGElement>();
    const textNodes = new Map<string, HTMLElement>();
    const written = new Map<string, string>();
    let stale = true;
    const scan = () => {
      stale = false;
      nodes.clear();
      textNodes.clear();
      written.clear();
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
    const put = (key: string, apply: (v: string) => void, v: string) => {
      if (written.get(key) === v) return;
      written.set(key, v);
      apply(v);
    };

    const st = {
      t: POSTER_T,
      playing: frozenAt === null,
      anchorT: POSTER_T,
      anchorWall: performance.now(),
      onScreen: true,
      docVisible: document.visibilityState !== "hidden",
      mobile: forceMobile || mq.matches,
      scene: sceneAt(POSTER_T),
      still: 0,
    };

    const render = (t: number) => {
      if (stale) scan();
      st.t = wrapT(t);
      clock.set(st.t);
      const f = frame(st.t, st.mobile);
      put("camera", (v) => (world.style.transform = v), f.camera);
      put("will", (v) => (world.style.willChange = v), f.moving && !reduced ? "transform" : "auto");
      for (const id in f.els) {
        const n = nodes.get(id);
        if (!n) continue;
        const e = f.els[id];
        if (e.transform !== undefined) put(`${id}|t`, (v) => (n.style.transform = v), e.transform);
        if (e.opacity !== undefined) put(`${id}|o`, (v) => (n.style.opacity = v), String(e.opacity));
        if (e.visible !== undefined) put(`${id}|v`, (v) => (n.style.visibility = v), e.visible ? "visible" : "hidden");
        if (e.dash !== undefined) put(`${id}|d`, (v) => (n.style.strokeDashoffset = v), String(e.dash));
      }
      for (const id in f.texts) {
        const n = textNodes.get(id);
        if (n) put(`${id}|x`, (v) => (n.textContent = v), f.texts[id]);
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
        put(`bar${i}`, (v) => (b.style.transform = v), `scaleX(${p.toFixed(3)})`);
      });
    };

    const fit = () => {
      const { w, h } = st.mobile ? STAGE.mobile : STAGE.desktop;
      const s = wrap.clientWidth / w;
      stage.style.width = `${w}px`;
      stage.style.height = `${h}px`;
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
      mo.disconnect();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      if (window.__heroFly === api) delete window.__heroFly;
    };
  }, []);

  const size = mobile ? STAGE.mobile : STAGE.desktop;
  const active = SCENES[scene];

  return (
    <figure role="group" aria-label="Codecast product tour" className="m-0">
      <style>{FALLBACK_SCALE_CSS}</style>
      <p className="sr-only">{DESCRIPTION}</p>
      <HeroSandbox fallback={<div className="w-full rounded-2xl aspect-[1280/760] max-sm:aspect-[4/5]" style={{ backgroundColor: "#fdf6e3", border: "1px solid #eee8d5" }} />}>
      <div
        ref={wrapRef}
        aria-hidden
        className="relative w-full overflow-hidden rounded-2xl bg-sol-bg aspect-[1280/760] max-sm:aspect-[4/5]"
        style={{ border: "1px solid var(--sol-bg-alt)", boxShadow: "0 40px 80px -40px rgba(0,43,54,0.35)" }}
      >
        <div
          ref={stageRef}
          className="hf-stage absolute left-0 top-0 origin-top-left"
          style={{ width: size.w, height: size.h, transform: "scale(var(--hf-s))", perspective: "1800px", perspectiveOrigin: "50% 50%" }}
        >
          <div ref={worldRef} className="absolute left-1/2 top-1/2 h-0 w-0" style={{ transformStyle: "preserve-3d", transform: frame(POSTER_T).camera }}>
            <FilmClockContext.Provider value={clock}>
              <World chapters={chapters} now={now} />
            </FilmClockContext.Provider>
          </div>
        </div>
        <div
          className="pointer-events-none absolute inset-0"
          style={{ background: "radial-gradient(ellipse 75% 70% at 50% 48%, transparent 60%, color-mix(in srgb, var(--sol-bg) 85%, transparent) 100%)" }}
        />
      </div>
      </HeroSandbox>

      <div className="mt-4 flex items-center gap-3 font-mono">
        <button
          type="button"
          onClick={() => ctl.current?.toggle()}
          aria-pressed={!playing}
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
        <ol className="flex min-w-0 flex-1 gap-1">
          {SCENES.map((s, i) => (
            <li key={s.name} className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => ctl.current?.jump(i)}
                aria-current={i === scene ? "step" : undefined}
                aria-label={`Chapter ${i + 1}: ${s.name}`}
                className="group relative flex w-full items-center gap-1.5 overflow-hidden rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-[#eee8d5]/70"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: DOTS[i % DOTS.length], opacity: i === scene ? 1 : 0.55 }} />
                <span className={`hidden truncate text-[11px] sm:inline ${i === scene ? "text-[#002b36]" : "text-[#93a1a1] group-hover:text-[#586e75]"}`}>{s.name}</span>
                <span className="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full" style={{ backgroundColor: "#eee8d5" }} />
                <span
                  ref={(b) => {
                    barsRef.current[i] = b;
                  }}
                  className="absolute inset-x-1.5 bottom-0 h-[2px] origin-left rounded-full"
                  style={{ backgroundColor: DOTS[i % DOTS.length], transform: `scaleX(${i === scene ? ((POSTER_T - s.start) / (s.end - s.start)).toFixed(3) : 0})` }}
                />
              </button>
            </li>
          ))}
        </ol>
      </div>
      <figcaption key={scene} className="mt-2 min-h-[40px] text-left font-mono text-[13px] leading-relaxed text-[#657b83]" style={{ animation: "hf-cap 350ms cubic-bezier(0.16,1,0.3,1)" }}>
        <span className="text-[#002b36]">{active.name}.</span> {active.caption}
      </figcaption>
    </figure>
  );
}
