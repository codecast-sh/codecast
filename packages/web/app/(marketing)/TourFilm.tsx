"use client";

import { useRef, useState } from "react";
import { track } from "@/lib/analytics";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { DOTS } from "./chapterDots";

// The hand drawn tour (videos/codecast-explainer), hosted on media.codecast.sh
// and played by the same <cast-player> published pages use. One chapter per
// file; the player runs them back to back as one film.
const MEDIA = "https://media.codecast.sh/media/";
const TOUR_CHAPTERS = [
  { title: "Prologue: five steps out of the dark", duration: 120.3, file: "55f1381fa127e7ed37592e6a1e7f997890d70cf3df345552f5505cb6abe25e59" },
  { title: "Setup", duration: 40.6, file: "4d0722e7c34931c0b94d88c6ac7fde48fbebaa323a6c45ea0c602e46395ebb29" },
  { title: "The inbox", duration: 57.2, file: "cce83398d750f7578a3f1e082c335fb5c6dd98364ef8fed87b509d7ae195bf29" },
  { title: "The conversation", duration: 56.4, file: "970581a5b4aac48db350f03be42104f77fc5e38c84355f7840a158ab1bf8cbb8" },
  { title: "Memory", duration: 66.5, file: "ea24a0484996aae883cf7dfc635068b273043cd7b8f2d5288bd23ff141bcb8f5" },
  { title: "Your team", duration: 45.1, file: "2112d87a9a6e23b24c8052be88ab51d9c8f11930e9b6c492ed133e5b730678de" },
  { title: "Agents together", duration: 49.9, file: "5af9c14fc72be4f21f366d0c4126fa494486e4e1d7be1fd216f7a665bb32b319" },
  { title: "Tasks, plans and docs", duration: 47.3, file: "1109437c989e01b68c0db826e95529aaa06db7e5a23ac82bb4ee40d252f81903" },
  { title: "Triggers and workflows", duration: 44.2, file: "3b9748e3688de3f224e21b08ed822b1fac415f4d2ffd7eee35272c72b48401c3" },
  { title: "Show the work", duration: 39.3, file: "7def33d5e6d5a0329216d9f73b9920a6c5b3e8289e0ea2c94b996ae93918ae7c" },
  { title: "Everywhere", duration: 30.0, file: "78d69cbf2380312c4c680a578612e0da3d8ec4ac04112d5598649e44103c9ba2" },
  { title: "Back to our little agent", duration: 30.1, file: "a1ea055a294857e47a51f6c7fd598551f18c9b3bc77a5c534868ea94fcb23a33" },
];
const STARTS = TOUR_CHAPTERS.map((_, i) => TOUR_CHAPTERS.slice(0, i).reduce((t, c) => t + c.duration, 0));
const TOTAL = STARTS[STARTS.length - 1] + TOUR_CHAPTERS[TOUR_CHAPTERS.length - 1].duration;

type CastPlayerEl = HTMLElement & {
  goTo(i: number): void;
  play(): void;
  chapterIndex: number;
  currentTime: number;
};

// The one film on the page. Links further down ("watch this part") reach it here.
let film: CastPlayerEl | null = null;

// The element's code, served same-origin by plugins/castPlayerScript.ts. The
// element upgrades itself whenever the script lands, before or after mount.
function loadCastPlayer() {
  if (customElements.get("cast-player") || document.querySelector('script[src="/cast-player.js"]')) return;
  const s = document.createElement("script");
  s.src = "/cast-player.js";
  s.async = true;
  document.head.appendChild(s);
}

function clock(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

function playChapter(i: number, from: "chapter_list" | "section_link") {
  track("landing_tour_chapter", { chapter: i, from });
  const el = film;
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus({ preventScroll: true });
  void customElements.whenDefined("cast-player").then(() => {
    el.goTo(i);
    el.play();
  });
}

export function TourSection() {
  const host = useRef<HTMLDivElement>(null);
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  const [active, setActive] = useState(0);

  useWatchEffect(() => {
    loadCastPlayer();
    const el = document.createElement("cast-player") as CastPlayerEl;
    el.setAttribute("poster", "/tour/poster.jpg");
    el.setAttribute("title", "Codecast, the tour");
    for (const c of TOUR_CHAPTERS) {
      const ch = document.createElement("cast-chapter");
      ch.setAttribute("src", MEDIA + c.file + ".mp4");
      ch.setAttribute("title", c.title);
      ch.setAttribute("duration", String(c.duration));
      el.appendChild(ch);
    }
    let started = false;
    const onTime = () => {
      const k = el.chapterIndex;
      const into = (el.currentTime - STARTS[k]) / TOUR_CHAPTERS[k].duration;
      bars.current.forEach((b, i) => {
        if (b) b.style.transform = `scaleX(${i === k ? Math.min(1, Math.max(0, into)) : 0})`;
      });
      if (!started && el.currentTime > 0.5) {
        started = true;
        track("landing_tour_started", { chapter: k });
      }
    };
    const onChapter = () => setActive(el.chapterIndex);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("chapterchange", onChapter);
    host.current?.appendChild(el);
    film = el;
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("chapterchange", onChapter);
      el.remove();
      if (film === el) film = null;
    };
  }, []);

  return (
    <section id="tour" className="max-w-6xl mx-auto px-6 pb-20 scroll-mt-20">
      <div className="text-center max-w-2xl mx-auto mb-10">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md mb-4" style={{ backgroundColor: "rgba(203,75,22,0.1)", color: "#cb4b16" }}>
          <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.6.6 0 0 0 .9.5l6.1-3.8a.6.6 0 0 0 0-1L2.9.7a.6.6 0 0 0-.9.5z" /></svg>
          <span className="tracking-wider font-mono text-[11px] uppercase font-medium">The tour &middot; {Math.round(TOTAL / 60)} minutes, drawn by hand</span>
        </div>
        <h2 className="text-3xl font-bold text-[#002b36] mb-4 font-mono">
          From one agent in the dark to a team that remembers
        </h2>
        <p className="text-lg text-[#657b83] leading-relaxed">
          Five steps take a single isolated session to agents that search and talk to each other.
          Then every part of the product, in order. Press play and it runs straight through, or
          jump to the chapter you care about.
        </p>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px] gap-8 lg:gap-10 items-start">
        <div className="relative">
          <div className="absolute -inset-4 bg-gradient-to-r from-[#268bd2]/15 via-[#6c71c4]/15 to-[#cb4b16]/15 rounded-2xl blur-xl opacity-60" />
          <div className="relative rounded-xl p-2.5 sm:p-3" style={{ backgroundColor: "#fffdf6", border: "1px solid #eee8d5", boxShadow: "0 24px 50px -28px rgba(0,43,54,0.45)" }}>
            <span aria-hidden className="absolute -top-3 left-[12%] w-28 h-6 -rotate-3 z-10" style={{ backgroundColor: "rgba(181,137,0,0.22)", clipPath: "polygon(2% 10%, 98% 0, 100% 90%, 0 100%)" }} />
            <span aria-hidden className="absolute -bottom-3 right-[10%] w-24 h-6 rotate-2 z-10" style={{ backgroundColor: "rgba(42,161,152,0.22)", clipPath: "polygon(0 0, 100% 12%, 97% 100%, 3% 88%)" }} />
            <div
              ref={host}
              className="[&>cast-player]:block aspect-video rounded-lg overflow-hidden"
              style={{ backgroundColor: "#1b1740", ["--cast-accent" as string]: "#cb4b16", ["--cast-radius" as string]: "8px", ["--cast-bg" as string]: "#1b1740" }}
            />
          </div>
        </div>

        <ol className="flex lg:flex-col lg:justify-between lg:self-stretch lg:py-1 gap-1 overflow-x-auto lg:overflow-visible -mx-6 px-6 lg:mx-0 lg:px-0 pb-2 lg:pb-0 snap-x scroll-px-6 lg:scroll-px-0">
          {TOUR_CHAPTERS.map((c, i) => (
            <li key={c.file} className="shrink-0 snap-start">
              <button
                type="button"
                onClick={() => playChapter(i, "chapter_list")}
                className="group relative w-52 lg:w-full text-left rounded-md pl-3 pr-2.5 py-1.5 overflow-hidden transition-colors hover:bg-[#eee8d5]/70"
                style={i === active ? { backgroundColor: "#eee8d5" } : undefined}
                aria-current={i === active ? "true" : undefined}
              >
                <span className="flex items-baseline gap-2.5">
                  <span className="font-mono text-[11px] w-4 text-right shrink-0" style={{ color: DOTS[i % DOTS.length] }}>{i}</span>
                  <span className={`flex-1 min-w-0 text-sm leading-snug truncate lg:whitespace-normal ${i === active ? "text-[#002b36] font-medium" : "text-[#586e75]"}`}>{c.title}</span>
                  <span className="font-mono text-[11px] text-[#93a1a1] tabular-nums shrink-0">{clock(STARTS[i])}</span>
                </span>
                <span
                  ref={(b) => { bars.current[i] = b; }}
                  aria-hidden
                  className="absolute left-0 bottom-0 h-[2px] w-full origin-left"
                  style={{ backgroundColor: "#cb4b16", transform: "scaleX(0)" }}
                />
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A quiet "watch this part" link beside a section of the page, playing its chapter in the tour above. */
export function WatchChapter({ title, tone = "light" }: { title: string; tone?: "light" | "dark" }) {
  const i = TOUR_CHAPTERS.findIndex((c) => c.title === title);
  const c = TOUR_CHAPTERS[i];
  const color = tone === "dark" ? "#93a1a1" : "#657b83";
  return (
    <button
      type="button"
      onClick={() => playChapter(i, "section_link")}
      className="group inline-flex items-center gap-2.5 font-mono text-sm transition-colors"
      style={{ color }}
    >
      <span className="w-7 h-7 rounded-full flex items-center justify-center transition-transform group-hover:scale-110" style={{ backgroundColor: "rgba(203,75,22,0.14)", color: "#cb4b16" }}>
        <svg className="w-2.5 h-2.5 ml-0.5" viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.6.6 0 0 0 .9.5l6.1-3.8a.6.6 0 0 0 0-1L2.9.7a.6.6 0 0 0-.9.5z" /></svg>
      </span>
      <span className="underline decoration-dotted underline-offset-4 decoration-[#93a1a1] group-hover:decoration-[#cb4b16] group-hover:text-[#cb4b16]">
        Watch &ldquo;{c.title}&rdquo;
      </span>
      <span className="text-[11px] text-[#93a1a1] tabular-nums">{clock(c.duration)}</span>
    </button>
  );
}
