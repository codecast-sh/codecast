"use client";

import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { Person, Tile } from "./kit";
import { DIM, INK, LINE, MUTED, PAPER, SOL, TEXT, person, tint } from "./model";
import { DAY, clock, dur, type DayKind, type DayMark } from "./anatomyData";

/*
 * One day of the Release Captain on a 24-hour line: its checks (two of them
 * stopped by the precheck and spent nothing), a worker asking for input, a
 * message from Maya, the workers it started with their durations, and the
 * dated line its brief gained. It draws itself once, in reading order, the
 * first time it scrolls into view; before JS runs, under ?static and under
 * reduced motion it is simply there. Pointing at a mark names what happened.
 */

const W = 1000;
const H = 322;
const LINE_Y = 104;
const LANE_Y = [208, 278];
const LABEL_Y = [70, 46, 22];
/** Night hours (before 06:00, after 21:00) run at half width so the day gets the room. */
const NIGHT = 0.5;
const span = (h: number) => Math.min(h, 6) * NIGHT + Math.max(0, Math.min(h, 21) - 6) + Math.max(0, h - 21) * NIGHT;
const x = (h: number) => 28 + (span(h) / span(24)) * (W - 56);
/** Labels below the line (row -1) sit here, two lines tall. */
const BELOW_Y = 138;
const pct = (v: number, of: number) => `${(v / of) * 100}%`;

/** When each mark lands as the line draws left to right. */
const SWEEP = 1.5;
const tOf = (h: number) => 0.15 + (span(h) / span(24)) * SWEEP;

const KIND: Record<DayKind, { color: string; word: string }> = {
  check: { color: SOL.green, word: "check" },
  skip: { color: SOL.base1, word: "skipped · 0 tokens" },
  needs: { color: SOL.yellow, word: "needs input" },
  maya: { color: SOL.base02, word: "message" },
  brief: { color: SOL.violet, word: "brief" },
};

const CSS = `
.og-d[data-armed]:not([data-in]) .og-d-a { opacity: 0; }
.og-d[data-armed]:not([data-in]) .og-d-grow { transform: scaleX(0); }
.og-d[data-in] .og-d-pop { animation: og-d-pop .5s cubic-bezier(.3,1.4,.5,1) var(--d) both; }
.og-d[data-in] .og-d-fade { animation: og-d-fade .45s ease var(--d) both; }
.og-d[data-in] .og-d-grow { transform-origin: left center; animation: og-d-grow .6s cubic-bezier(.2,.7,.2,1) var(--d) both; }
.og-d[data-in] .og-d-draw { stroke-dasharray: 1; animation: og-d-draw .45s ease-out var(--d) both; }
@keyframes og-d-pop { from { opacity: 0; transform: scale(.4); } to { opacity: 1; transform: none; } }
@keyframes og-d-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes og-d-grow { from { transform: scaleX(0); } to { transform: none; } }
@keyframes og-d-draw { from { stroke-dashoffset: 1; opacity: 1; } to { stroke-dashoffset: 0; opacity: 1; } }
.og-d-mark { transition: transform .15s ease; }
.og-d-btn:hover .og-d-mark, .og-d-btn:focus-visible .og-d-mark, .og-d-mark[data-on="true"] { transform: scale(1.3); }
.og-d-btn:focus-visible { outline: 2px solid ${SOL.blue}; outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .og-d .og-d-a, .og-d .og-d-grow { animation: none !important; opacity: 1 !important; transform: none !important; } .og-d-mark { transition: none; } }
.og-root[data-static] .og-d .og-d-a, .og-root[data-static] .og-d .og-d-grow { animation: none !important; opacity: 1 !important; transform: none !important; }
`;

/** An element centred on a stage point. */
function At({ px, py, children, style }: { px: number; py: number; children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="absolute" style={{ left: pct(px, W), top: pct(py, H), transform: "translate(-50%, -50%)", ...style }}>
      {children}
    </div>
  );
}

function Glyph({ m }: { m: DayMark }) {
  const c = KIND[m.kind].color;
  if (m.kind === "maya") return <Person p={person("maya")} size={22} />;
  if (m.kind === "brief") {
    return (
      <span className="inline-flex w-[18px] h-[20px] rounded-[4px] flex-col justify-center gap-[3px] px-[4px]" style={{ backgroundColor: tint(c, 18), boxShadow: `inset 0 0 0 1.5px ${c}` }}>
        {[1, 0.7, 0.85].map((w, i) => <span key={i} className="block h-[1.5px] rounded" style={{ width: `${w * 100}%`, backgroundColor: c }} />)}
      </span>
    );
  }
  if (m.kind === "skip") return <span className="block w-[14px] h-[14px] rounded-full" style={{ backgroundColor: PAPER, boxShadow: `inset 0 0 0 2px ${c}` }} />;
  return <span className="block w-[16px] h-[16px] rounded-full" style={{ backgroundColor: c, boxShadow: `0 0 0 3px ${PAPER}, 0 0 0 4.5px ${tint(c, 40, PAPER)}` }} />;
}

const WORKERS = DAY.flatMap((m, i) => (m.worker ? [{ i, m, w: m.worker }] : []));
const RAN = DAY.filter((m) => m.kind !== "brief" && m.kind !== "skip").length;
const SKIPPED = DAY.filter((m) => m.kind === "skip").length;

function Stage({ on, setOn }: { on: number | null; setOn: (i: number | null) => void }) {
  const ticks = [0, 6, 9, 12, 15, 18, 21, 24];
  return (
    <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }} onMouseLeave={() => setOn(null)}>
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden>
        {ticks.map((h) => (
          <line key={h} x1={x(h)} x2={x(h)} y1={16} y2={H - 26} stroke={LINE} strokeWidth={1} />
        ))}
        {/* Night, drawn at half width: before 06:00 and after 21:00. */}
        <rect x={x(0)} y={16} width={x(6) - x(0)} height={H - 42} fill={tint(SOL.blue, 5, "transparent")} />
        <rect x={x(21)} y={16} width={x(24) - x(21)} height={H - 42} fill={tint(SOL.blue, 5, "transparent")} />
        <line x1={x(0)} x2={x(24)} y1={LINE_Y} y2={LINE_Y} stroke={SOL.base1} strokeWidth={2} className="og-d-grow" style={{ ["--d" as string]: "0s", transformBox: "fill-box" } as CSSProperties} />
        {DAY.map((m, i) => m.row !== 0 && (
          <line key={i} x1={x(m.h)} x2={x(m.h)} y1={m.row < 0 ? LINE_Y + 13 : LABEL_Y[m.row] + 9} y2={m.row < 0 ? BELOW_Y - 14 : LINE_Y - 12} stroke={tint(KIND[m.kind].color, 45, PAPER)} strokeWidth={1} className="og-d-a og-d-fade" style={{ ["--d" as string]: `${tOf(m.h) + 0.1}s` } as CSSProperties} />
        ))}
        {WORKERS.map(({ i, m, w }) => {
          const ly = LANE_Y[w.lane];
          return (
            <path
              key={i}
              d={`M${x(m.h)} ${LINE_Y + 9} C ${x(m.h)} ${LINE_Y + 40}, ${x(w.from)} ${ly - 40}, ${x(w.from)} ${ly}`}
              pathLength={1}
              stroke={tint(SOL.cyan, 70, PAPER)}
              strokeWidth={1.5}
              className="og-d-a og-d-draw"
              style={{ ["--d" as string]: `${tOf(m.h) + 0.2}s` } as CSSProperties}
            />
          );
        })}
      </svg>

      {ticks.map((h) => (
        <At key={h} px={x(h)} py={H - 12}>
          <span className="font-mono text-meta" style={{ color: DIM }}>{clock(h)}</span>
        </At>
      ))}

      {WORKERS.map(({ i, m, w }) => {
        const ly = LANE_Y[w.lane];
        const t = tOf(m.h) + 0.5;
        return (
          <div key={i} onMouseEnter={() => setOn(i)}>
            <div
              className="absolute og-d-grow rounded-full"
              style={{ left: pct(x(w.from), W), width: pct(x(w.to) - x(w.from), W), top: pct(ly - 4.5, H), height: 9, backgroundColor: SOL.cyan, ["--d" as string]: `${t}s` } as CSSProperties}
            />
            <At px={x(w.from)} py={ly}>
              <span className="og-d-a og-d-pop block w-[13px] h-[13px] rounded-full" style={{ backgroundColor: SOL.cyan, boxShadow: `0 0 0 2.5px ${PAPER}`, ["--d" as string]: `${t - 0.1}s` } as CSSProperties} />
            </At>
            <div className="absolute og-d-a og-d-fade whitespace-nowrap font-mono leading-[15px]" style={{ left: pct(x(w.from) - 4, W), top: pct(ly - 42, H), ["--d" as string]: `${t + 0.25}s` } as CSSProperties}>
              <span className="block text-[12.5px]" style={{ color: TEXT }}>{w.title}</span>
              <span className="block text-meta font-semibold" style={{ color: SOL.cyan }}>{dur(w)}</span>
            </div>
          </div>
        );
      })}

      {DAY.map((m, i) => (
        <At key={`l${i}`} px={x(m.h)} py={m.row < 0 ? BELOW_Y : LABEL_Y[m.row]}>
          <span className="og-d-a og-d-fade block whitespace-nowrap font-mono text-meta text-center leading-tight" style={{ color: m.kind === "skip" ? DIM : KIND[m.kind].color, ["--d" as string]: `${tOf(m.h) + 0.1}s` } as CSSProperties}>
            <span style={{ color: DIM }}>{clock(m.h)}</span>{m.row < 0 ? <br /> : " "}{m.label}
          </span>
        </At>
      ))}

      {DAY.map((m, i) => (
        <At key={`m${i}`} px={x(m.h)} py={LINE_Y}>
          <button
            type="button"
            aria-label={`${clock(m.h)} ${KIND[m.kind].word}: ${m.line}`}
            className="og-d-btn og-d-a og-d-pop flex items-center justify-center w-7 h-7 rounded-full"
            style={{ ["--d" as string]: `${tOf(m.h)}s` } as CSSProperties}
            onMouseEnter={() => setOn(i)}
            onFocus={() => setOn(i)}
            onClick={() => setOn(i)}
          >
            <span className="og-d-mark inline-flex" data-on={on === i}><Glyph m={m} /></span>
          </button>
        </At>
      ))}
    </div>
  );
}

export function AnatomyDay() {
  const [on, setOn] = useState<number | null>(null);
  const [armed, setArmed] = useState(false);
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMountEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches || new URLSearchParams(window.location.search).has("static");
    const el = ref.current;
    if (still || !el || typeof IntersectionObserver === "undefined") return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) return; // already on screen: leave it at rest
    setArmed(true);
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  });
  const m = on === null ? null : DAY[on];
  return (
    <div className="mt-20">
      <style>{CSS}</style>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2 mb-5">
        <h3 className="font-mono font-bold text-[20px] sm:text-[24px] tracking-[-0.03em] flex items-center gap-2.5" style={{ color: INK }}>
          <Tile k="rocket launch" size={26} /> A day in the life of the Release Captain
        </h3>
        <span className="font-mono text-[12px] pb-1" style={{ color: MUTED }}>Thursday, Nov 5 · check every 6h, skipped when main has no new merges</span>
      </div>
      <div className="rounded-2xl border overflow-hidden" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 30px 70px -40px rgba(0,43,54,.45)" }}>
        <div className="px-4 sm:px-5 min-h-[46px] py-2.5 border-b flex items-center gap-3 font-mono text-[12px]" style={{ borderColor: LINE, backgroundColor: tint(PAPER, 60, "#fffdf6") }} aria-live="polite">
          {m ? (
            <>
              <span className="shrink-0" style={{ color: DIM }}>{clock(m.h)}</span>
              <span className="shrink-0 font-semibold" style={{ color: m.kind === "skip" ? MUTED : KIND[m.kind].color }}>{KIND[m.kind].word}</span>
              <span className="min-w-0" style={{ color: TEXT }}>{m.line}</span>
            </>
          ) : (
            <span className="flex flex-wrap gap-x-4 gap-y-1" style={{ color: MUTED }}>
              <span><b style={{ color: INK }}>{RAN}</b> wakes that ran</span>
              <span><b style={{ color: INK }}>{SKIPPED}</b> checks skipped, 0 tokens</span>
              <span><b style={{ color: INK }}>{WORKERS.length}</b> workers started</span>
              <span><b style={{ color: INK }}>1</b> new brief line</span>
            </span>
          )}
        </div>
        <div className="overflow-x-auto">
          <div ref={ref} className="og-d min-w-[900px] px-3 sm:px-4 pt-2 pb-3" data-armed={armed ? "" : undefined} data-in={seen ? "" : undefined}>
            <Stage on={on} setOn={setOn} />
          </div>
        </div>
      </div>
    </div>
  );
}
