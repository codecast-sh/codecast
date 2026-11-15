"use client";

import type { CSSProperties } from "react";
import { SOL } from "../blogChrome";
import { FigureStyles, Stage, t } from "../figureKit";

/**
 * Illustrations for "The software factory", built on the shared figure kit
 * (../figureKit.tsx). FactoryFigure follows docs/architecture/the-line-end-to-end.md
 * (sense, attach, ground, admit, prove, build, verify, eval, review, card,
 * decide, ship, watch, learn); LoopFigure is the shipped `change` flow
 * (packages/cli/src/workflow/templates/change.cast).
 */

export { FigureStyles };

function Head({ x, y, dir, color, style }: { x: number; y: number; dir: "r" | "l" | "d" | "u"; color: string; style?: CSSProperties }) {
  const d = { r: `M${x} ${y}l-7 -4v8z`, l: `M${x} ${y}l7 -4v8z`, d: `M${x} ${y}l-4 -7h8z`, u: `M${x} ${y}l-4 7h8z` }[dir];
  return <path d={d} fill={color} className="bj-pop" style={style} />;
}

// ─── The factory ──────────────────────────────────────────────────────────

const SOURCES = ["errors", "analytics", "CI checks", "evals", "lessons"];
// Signals: many small marks, in rows, that collapse into a few problems.
const SIGNALS = Array.from({ length: 24 }, (_, i) => ({ x: 156 + (i % 6) * 13, y: 92 + Math.floor(i / 6) * 22 + ((i * 7) % 5) }));
const PROBLEMS = [
  { y: 98, r: 9 },
  { y: 132, r: 6 },
  { y: 162, r: 7.5 },
];
const STATIONS = ["Prove", "Build", "Check", "Review"];

export function FactoryFigure() {
  const top = 70;
  return (
    <Stage minWidth={660}>
      <svg viewBox="0 0 720 330" className="w-full block font-mono" role="img" aria-label="The factory: sources feed many signals; signals that share a root become a few problems; a live flow proves, builds, checks and reviews each one; a person decides; the change ships and is watched, and a signal that comes back reopens the problem.">
        {/* Column titles */}
        {[
          { x: 52, s: "sources" },
          { x: 188, s: "signals" },
          { x: 290, s: "problems" },
          { x: 430, s: "a live flow" },
          { x: 568, s: "you" },
          { x: 664, s: "live" },
        ].map((c, i) => (
          <text key={c.s} x={c.x} y={44} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(i * 0.15)}>{c.s}</text>
        ))}

        {/* Sources */}
        {SOURCES.map((s, i) => (
          <g key={s}>
            <rect x={8} y={top + i * 30} width={88} height={22} rx={6} fill={SOL.base2} className="bj-rise" style={t(0.1 + i * 0.07)} />
            <text x={52} y={top + i * 30 + 15} textAnchor="middle" fontSize="10" fill={SOL.base01} className="bj-rise" style={t(0.1 + i * 0.07)}>{s}</text>
            <path d={`M98 ${top + 11 + i * 30}H142`} pathLength={1} stroke={SOL.base1} strokeWidth={1} fill="none" className="bj-draw" style={t(0.6 + i * 0.05, 0.3)} />
          </g>
        ))}

        {/* Signals: many */}
        {SIGNALS.map((d, i) => (
          <circle key={i} cx={d.x} cy={d.y} r={3.2} fill={SOL.base0} className="bj-pop" style={t(0.9 + i * 0.025)} />
        ))}
        <text x={188} y={top + 166} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(1.5)}>one door,</text>
        <text x={188} y={top + 179} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(1.5)}>typed at source</text>

        {/* Attach: many into few */}
        {[100, 132, 164].map((y, i) => (
          <path key={y} d={`M234 ${y}C252 ${y} 258 ${PROBLEMS[i].y} 274 ${PROBLEMS[i].y}`} pathLength={1} stroke={SOL.base1} strokeWidth={1} fill="none" className="bj-draw" style={t(1.7 + i * 0.1, 0.4)} />
        ))}

        {/* Problems: few, sized by priority */}
        {PROBLEMS.map((p, i) => (
          <circle key={p.y} cx={290} cy={p.y} r={p.r} fill="none" stroke={SOL.orange} strokeWidth={2} className="bj-pop" style={t(2.1 + i * 0.12)} />
        ))}
        <text x={290} y={top + 166} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(2.4)}>one per root</text>
        <text x={290} y={top + 179} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(2.4)}>cause, by goal</text>

        {/* The flow */}
        <rect x={340} y={top + 6} width={180} height={128} rx={12} fill={SOL.base2} className="bj-fade" style={t(2.6)} />
        <path d={`M300 ${PROBLEMS[0].y}H336`} pathLength={1} stroke={SOL.orange} strokeWidth={1.6} fill="none" className="bj-draw" style={t(2.7, 0.3)} />
        <Head x={340} y={PROBLEMS[0].y} dir="r" color={SOL.orange} style={t(3.0)} />
        {STATIONS.map((s, i) => {
          const y = top + 26 + i * 28;
          return (
            <g key={s}>
              <circle cx={364} cy={y} r={6} fill={SOL.base3} stroke={i === 0 ? SOL.red : SOL.blue} strokeWidth={2} className="bj-pop" style={t(3.0 + i * 0.25)} />
              <text x={378} y={y + 4} fontSize="11" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(3.0 + i * 0.25)}>{s}</text>
              {i < STATIONS.length - 1 && <path d={`M364 ${y + 7}V${y + 21}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.2} fill="none" className="bj-draw" style={t(3.1 + i * 0.25, 0.2)} />}
            </g>
          );
        })}
        <text x={424} y={top + 26 + 4} fontSize="9.5" fill={SOL.red} className="bj-fade" style={t(3.2)}>fails first</text>
        <text x={424} y={top + 82 + 4} fontSize="9.5" fill={SOL.blue} className="bj-fade" style={t(3.6)}>then passes</text>

        {/* Decide */}
        <path d={`M520 ${top + 70}H550`} pathLength={1} stroke={SOL.violet} strokeWidth={1.6} fill="none" className="bj-draw" style={t(4.1, 0.3)} />
        <Head x={554} y={top + 70} dir="r" color={SOL.violet} style={t(4.4)} />
        <rect x={556} y={top + 48} width={28} height={44} rx={5} fill={SOL.base3} stroke={SOL.violet} strokeWidth={2} className="bj-pop" style={t(4.4)} />
        {[58, 66, 74, 82].map((dy, i) => (
          <path key={dy} d={`M562 ${top + dy}H${i === 0 ? 578 : 574 - (i % 2) * 4}`} stroke={SOL.violet} strokeWidth={i === 0 ? 2.4 : 1.4} strokeLinecap="round" className="bj-fade" style={t(4.5 + i * 0.05)} />
        ))}
        <text x={569} y={top + 112} textAnchor="middle" fontSize="9.5" fill={SOL.violet} className="bj-fade" style={t(4.6)}>one card</text>

        {/* Live */}
        <path d={`M584 ${top + 70}H644`} pathLength={1} stroke={SOL.green} strokeWidth={1.6} fill="none" className="bj-draw" style={t(4.8, 0.3)} />
        <text x={614} y={top + 62} textAnchor="middle" fontSize="9.5" fill={SOL.green} className="bj-fade" style={t(4.9)}>Ship</text>
        <circle cx={664} cy={top + 70} r={14} fill="none" stroke={SOL.green} strokeWidth={2.5} className="bj-pop" style={t(5.1)} />
        <circle cx={664} cy={top + 70} r={6} fill={SOL.green} className="bj-pop bj-pulse" style={t(5.2)} />
        <text x={664} y={top + 112} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(5.3)}>watched</text>
        <text x={664} y={top + 125} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(5.3)}>for 7 days</text>

        {/* Back to signals */}
        <path d={`M664 ${top + 134}V${top + 214}Q664 ${top + 226} 652 ${top + 226}H200Q188 ${top + 226} 188 ${top + 214}V${top + 190}`} pathLength={1} stroke={SOL.red} strokeWidth={1.4} fill="none" className="bj-draw" style={t(5.6, 1.0)} />
        <Head x={188} y={top + 187} dir="u" color={SOL.red} style={t(6.6)} />
        <text x={380} y={top + 218} textAnchor="middle" fontSize="10" fill={SOL.red} className="bj-fade" style={t(6.0)}>the same signal comes back: the problem reopens</text>
        <path d={`M569 ${top + 120}V${top + 226}`} pathLength={1} stroke={SOL.magenta} strokeWidth={1.2} fill="none" className="bj-draw" style={t(6.2, 0.4)} />
        <text x={562} y={top + 160} textAnchor="end" fontSize="9.5" fill={SOL.magenta} className="bj-fade" style={t(6.4)}>your note</text>
        <text x={562} y={top + 172} textAnchor="end" fontSize="9.5" fill={SOL.magenta} className="bj-fade" style={t(6.4)}>becomes a lesson</text>
      </svg>
    </Stage>
  );
}

// ─── A person's own change ────────────────────────────────────────────────

const CHANGE_STATIONS: { x: number; name: string; who: string; color: string }[] = [
  { x: 130, name: "Check", who: "automatic", color: SOL.blue },
  { x: 245, name: "Review", who: "an agent", color: SOL.orange },
  { x: 360, name: "Decide", who: "you", color: SOL.violet },
  { x: 475, name: "Land", who: "automatic", color: SOL.cyan },
  { x: 590, name: "Deploy", who: "waits", color: SOL.cyan },
  { x: 680, name: "Live", who: "dp-N", color: SOL.green },
];

const RETURNS: { x: number; what: string }[] = [
  { x: 130, what: "the output" },
  { x: 245, what: "the findings" },
  { x: 360, what: "your note" },
  { x: 475, what: "the conflict" },
];

const LINE_Y = 96;
const LANE_Y = 262;

export function LoopFigure() {
  return (
    <Stage minWidth={640}>
      <svg viewBox="0 0 720 330" className="w-full block font-mono" role="img" aria-label="The change flow: Check, Review, Decide, Land, Deploy, Live. A failed check, the reviewer's findings, your revise note and a rebase conflict each go back to the session that made the change, and the change goes through Check again.">
        <circle cx={40} cy={LINE_Y} r={9} fill={SOL.base02} className="bj-pop" style={t(0)} />
        <text x={40} y={LINE_Y - 20} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(0)}>Ship</text>

        <path d={`M49 ${LINE_Y}H668`} pathLength={1} stroke={SOL.base1} strokeWidth={2} fill="none" className="bj-draw" style={t(0.2, 1.4)} />
        {CHANGE_STATIONS.map((s, i) => {
          const at = 0.3 + i * 0.22;
          return (
            <g key={s.name}>
              <circle cx={s.x} cy={LINE_Y} r={13} fill={SOL.base3} stroke={s.color} strokeWidth={2.5} className="bj-pop" style={t(at)} />
              {s.name === "Live" && <circle cx={s.x} cy={LINE_Y} r={6} fill={s.color} className="bj-pop" style={t(at + 0.1)} />}
              <text x={s.x} y={LINE_Y - 24} textAnchor="middle" fontSize="12.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(at)}>{s.name}</text>
              <text x={s.x} y={LINE_Y + 32} textAnchor="middle" fontSize="10" fill={s.color} className="bj-fade" style={t(at + 0.1)}>{s.who}</text>
            </g>
          );
        })}

        <rect x={88} y={LANE_Y - 22} width={430} height={44} rx={10} fill={SOL.base2} className="bj-fade" style={t(1.8)} />
        <text x={303} y={LANE_Y - 2} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(1.8)}>the session that made the change</text>
        <text x={303} y={LANE_Y + 13} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.9)}>its own thread, its own checkout</text>

        {RETURNS.map((r, i) => {
          const at = 2.2 + i * 0.35;
          const x = r.x + 14;
          return (
            <g key={r.what}>
              <path d={`M${x} ${LINE_Y + 44}V${LANE_Y - 26}`} stroke={SOL.red} strokeWidth={1.4} strokeDasharray="4 3" fill="none" className="bj-fade" style={t(at)} />
              <Head x={x} y={LANE_Y - 24} dir="d" color={SOL.red} style={t(at + 0.2)} />
              <text x={x + 7} y={(LINE_Y + LANE_Y) / 2 + 4} fontSize="10" fill={SOL.red} className="bj-fade" style={t(at + 0.1)}>{r.what}</text>
            </g>
          );
        })}

        <path d={`M88 ${LANE_Y}H66Q54 ${LANE_Y} 54 ${LANE_Y - 12}V${LINE_Y + 14}Q54 ${LINE_Y} 68 ${LINE_Y}H104`} pathLength={1} stroke={SOL.green} strokeWidth={2} fill="none" className="bj-draw" style={t(3.8, 0.7)} />
        <Head x={112} y={LINE_Y} dir="r" color={SOL.green} style={t(4.5)} />
        <text x={20} y={LANE_Y + 44} fontSize="10" fill={SOL.green} className="bj-fade" style={t(4.2)}>fixed: Check, then every stage after it, again</text>
        <text x={700} y={LANE_Y + 44} textAnchor="end" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(4.4)}>at most 3 times each way back</text>
      </svg>
    </Stage>
  );
}
