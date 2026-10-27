"use client";
// The guide player: one guide (tours/guides/types.ts) full screen. A strip of
// chapters along the top, the stage in the middle, and under it the chapter's
// title and what the current beat says. Beats play by themselves; a beat that
// asks for a press waits for it, and the stage lights the control to press.
// Arrows step, space pauses, a number jumps to a chapter, Esc closes. The
// last screen is the feature's switch (GuideFinale).
//
// The stage is drawn at one fixed size (STAGE_W x STAGE_H) and scaled to the
// window, so a scene lays out once and reads the same on a laptop and on a
// wide monitor.
import { useMemo, useRef, useState, type CSSProperties } from "react";
import { Pause, Play, X } from "lucide-react";
import { useEventListener } from "../../hooks/useEventListener";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useMountEffect } from "../../hooks/useMountEffect";
import { KeyCap } from "../../components/KeyboardShortcutsHelp";
import { endTour } from "../engine";
import { GuideFinale } from "./GuideFinale";
import { guideIcon } from "./guideIcons";
import type { GuideDef } from "./types";
import "./guides.css";

export const STAGE_W = 1040;
export const STAGE_H = 600;
const DEFAULT_HOLD = 3600;
const KEY_CAPTURE = { capture: true } as const;

type Pos = { chapter: number; beat: number };

export function GuidePlayer({ guide }: { guide: GuideDef }) {
  const chapters = guide.chapters;
  const [pos, setPos] = useState<Pos>({ chapter: 0, beat: 0 });
  const [playing, setPlaying] = useState(true);
  // Beats whose press the person has made, so stepping back over one does not
  // ask for it twice.
  const [acted, setActed] = useState<ReadonlySet<string>>(() => new Set());
  const finale = pos.chapter >= chapters.length;
  const chapter = finale ? null : chapters[pos.chapter];
  const beat = chapter?.beats[pos.beat] ?? null;
  const beatKey = `${pos.chapter}:${pos.beat}`;
  const waiting = !!beat?.act && !acted.has(beatKey);

  // The hold on an act's result: any step the person takes first replaces it.
  const actHold = useRef<number | null>(null);
  const clearActHold = () => { if (actHold.current !== null) { window.clearTimeout(actHold.current); actHold.current = null; } };
  const next = () => { clearActHold(); setPos(nextPos); };
  const nextPos = (p: Pos): Pos => {
    if (p.chapter >= chapters.length) return p;
    const ch = chapters[p.chapter];
    if (p.beat + 1 < ch.beats.length) return { chapter: p.chapter, beat: p.beat + 1 };
    return { chapter: p.chapter + 1, beat: 0 };
  };
  const back = () => { clearActHold(); setPos((p) => {
    if (p.chapter >= chapters.length) return { chapter: chapters.length - 1, beat: chapters[chapters.length - 1].beats.length - 1 };
    if (p.beat > 0) return { chapter: p.chapter, beat: p.beat - 1 };
    if (p.chapter === 0) return p;
    return { chapter: p.chapter - 1, beat: chapters[p.chapter - 1].beats.length - 1 };
  }); };
  const jump = (c: number) => { clearActHold(); setPos({ chapter: Math.max(0, Math.min(chapters.length, c)), beat: 0 }); setPlaying(true); };
  const act = () => {
    if (!waiting) return;
    setActed((s) => new Set(s).add(beatKey));
    setPlaying(true);
    // The press is the beat's payoff: hold on its result a moment.
    clearActHold();
    actHold.current = window.setTimeout(() => { actHold.current = null; setPos(nextPos); }, 1100);
  };
  const close = () => endTour(finale ? "finished" : "skipped");

  // The clock: a playing beat that asks for nothing moves on after its hold.
  useWatchEffect(() => {
    if (!playing || finale || waiting || !beat) return;
    const t = window.setTimeout(next, beat.hold ?? DEFAULT_HOLD);
    return () => window.clearTimeout(t);
  }, [playing, finale, waiting, beatKey]);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === "Escape") { handled(); close(); }
    else if (e.key === "ArrowRight") { handled(); if (waiting) act(); else next(); }
    else if (e.key === "ArrowLeft") { handled(); back(); }
    else if (e.key === " " && !finale) { handled(); if (waiting) act(); else setPlaying((p) => !p); }
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= chapters.length + 1) { handled(); jump(Number(e.key) - 1); }
  }, undefined, KEY_CAPTURE);

  const box = useRef<HTMLDivElement | null>(null);
  useMountEffect(() => { box.current?.focus({ preventScroll: true }); });
  const style = { "--guide-accent": guide.accent } as CSSProperties;
  const Icon = guideIcon(guide.feature);

  return (
    <div ref={box} tabIndex={-1} className="guide-root outline-none" role="dialog" aria-modal="true" aria-label={`${guide.name} guide`} style={style} data-guide={guide.id} data-guide-chapter={chapter?.id ?? "finale"} data-guide-beat={pos.beat}>
      <div className="guide-atmos" aria-hidden />
      <header className="guide-top">
        <div className="guide-mark">
          <span className="guide-mark-icon"><Icon className="w-4 h-4" strokeWidth={1.8} /></span>
          <span className="guide-mark-name">{guide.name}</span>
        </div>
        <nav className="guide-strip" aria-label="Chapters">
          {chapters.map((c, i) => {
            const state = i < pos.chapter ? "done" : i === pos.chapter ? "now" : "next";
            const fill = state === "done" ? 1 : state === "now" ? (pos.beat + (waiting ? 0.5 : 1)) / c.beats.length : 0;
            return (
              <button key={c.id} type="button" className="guide-strip-seg" data-state={state} onClick={() => jump(i)} title={`${i + 1}. ${c.title}`} data-guide-seg={c.id}>
                <span className="guide-strip-bar"><span className="guide-strip-fill" style={{ width: `${Math.round(fill * 100)}%` }} /></span>
                <span className="guide-strip-label">{c.title}</span>
              </button>
            );
          })}
          <button type="button" className="guide-strip-seg guide-strip-end" data-state={finale ? "now" : "next"} onClick={() => jump(chapters.length)} title={`Turn on ${guide.name}`} data-guide-seg="finale">
            <span className="guide-strip-bar"><span className="guide-strip-fill" style={{ width: finale ? "100%" : 0 }} /></span>
            <span className="guide-strip-label">Turn on</span>
          </button>
        </nav>
        <button type="button" onClick={close} aria-label="Close the guide" className="guide-close" data-guide-close><X className="w-4 h-4" /></button>
      </header>

      {finale ? (
        <GuideFinale guide={guide} onBack={back} onClose={close} />
      ) : (
        <>
          <ScaledStage>
            {chapter && <SceneFrame key={chapter.id} Scene={chapter.Scene} beat={pos.beat} act={act} waiting={waiting} />}
          </ScaledStage>
          <footer className="guide-caption">
            <div className="guide-caption-head">
              <span className="guide-caption-num">{pos.chapter + 1}</span>
              <h2 className="guide-caption-title">{chapter?.title}</h2>
            </div>
            <p key={beatKey} className="guide-say" data-guide-say>{beat?.say}</p>
            <div className="guide-controls">
              {waiting && beat?.act ? (
                <button type="button" className="guide-act-hint" onClick={act} data-guide-act>{beat.act}<span aria-hidden> →</span></button>
              ) : (
                <span className="guide-beats" aria-hidden>
                  {chapter?.beats.map((_, i) => <span key={i} data-on={i <= pos.beat ? "" : undefined} />)}
                </span>
              )}
              <div className="guide-buttons">
                <button type="button" onClick={back} className="guide-btn" disabled={pos.chapter === 0 && pos.beat === 0} data-guide-back>Back</button>
                <button type="button" onClick={() => (waiting ? act() : setPlaying((p) => !p))} className="guide-btn guide-btn-icon" aria-label={playing ? "Pause" : "Play"} data-guide-play>
                  {playing && !waiting ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                </button>
                <button type="button" onClick={() => (waiting ? act() : next())} className="guide-btn guide-btn-primary" data-guide-next>Next</button>
              </div>
            </div>
            <div className="guide-keys" aria-hidden>
              <span><KeyCap size="xs">←</KeyCap><KeyCap size="xs">→</KeyCap> step</span>
              <span><KeyCap size="xs">space</KeyCap> pause</span>
              <span><KeyCap size="xs">1</KeyCap>–<KeyCap size="xs">{String(Math.min(9, chapters.length + 1))}</KeyCap> chapter</span>
              <span><KeyCap size="xs">esc</KeyCap> close</span>
            </div>
          </footer>
        </>
      )}
    </div>
  );
}

/** The stage at its design size, scaled to fit what its box leaves it. */
export function ScaledStage({ children, max = 1.35, className = "guide-stage-wrap" }: { children: React.ReactNode; max?: number; className?: string }) {
  const outer = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useWatchEffect(() => {
    const el = outer.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setScale(Math.min(r.width / STAGE_W, r.height / STAGE_H, max));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, []);
  return (
    <div ref={outer} className={className}>
      <div className="guide-stage" style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }} data-guide-stage>
        {children}
      </div>
    </div>
  );
}

/** One scene, remounted per chapter so its entrance plays. */
function SceneFrame({ Scene, beat, act, waiting }: { Scene: GuideDef["chapters"][number]["Scene"]; beat: number; act: () => void; waiting: boolean }) {
  const props = useMemo(() => ({ beat, act, waiting }), [beat, act, waiting]);
  return <div className="guide-scene"><Scene {...props} /></div>;
}
