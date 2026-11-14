"use client";

import type { CSSProperties } from "react";
import { SOL } from "../blogChrome";
import { FigureStyles, Stage, t } from "../figureKit";

/**
 * Illustrations for "One question per change", built on the shared figure kit
 * (../figureKit.tsx). The stations and the routes back are the shipped
 * `change` flow (packages/cli/src/workflow/templates/change.cast): every stop
 * a session can fix goes back to it as a message, and the change goes through
 * Check again.
 */

export { FigureStyles };

const STATIONS: { x: number; name: string; who: string; color: string }[] = [
  { x: 130, name: "Check", who: "automatic", color: SOL.blue },
  { x: 245, name: "Review", who: "an agent", color: SOL.orange },
  { x: 360, name: "Decide", who: "you", color: SOL.violet },
  { x: 475, name: "Land", who: "automatic", color: SOL.cyan },
  { x: 590, name: "Deploy", who: "waits", color: SOL.cyan },
  { x: 680, name: "Live", who: "dp-N", color: SOL.green },
];

/** What each fixable stop sends back to the session, by station x. */
const RETURNS: { x: number; what: string }[] = [
  { x: 130, what: "the output" },
  { x: 245, what: "the findings" },
  { x: 360, what: "your note" },
  { x: 475, what: "the conflict" },
];

const LINE_Y = 96;
const LANE_Y = 262;

function Head({ x, y, dir, color, style }: { x: number; y: number; dir: "r" | "d"; color: string; style?: CSSProperties }) {
  const d = { r: `M${x} ${y}l-7 -4v8z`, d: `M${x} ${y}l-4 -7h8z` }[dir];
  return <path d={d} fill={color} className="bj-pop" style={style} />;
}

export function LoopFigure() {
  return (
    <Stage minWidth={640}>
      <svg viewBox="0 0 720 330" className="w-full block font-mono" role="img" aria-label="The change flow: Check, Review, Decide, Land, Deploy, Live. A failed check, the reviewer's findings, your revise note and a rebase conflict each go back to the session that made the change, and the change goes through Check again.">
        {/* The start: the Ship press. */}
        <circle cx={40} cy={LINE_Y} r={9} fill={SOL.base02} className="bj-pop" style={t(0)} />
        <text x={40} y={LINE_Y - 20} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(0)}>Ship</text>

        {/* The passing path. */}
        <path d={`M49 ${LINE_Y}H668`} pathLength={1} stroke={SOL.base1} strokeWidth={2} fill="none" className="bj-draw" style={t(0.2, 1.4)} />
        {STATIONS.map((s, i) => {
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

        {/* The session that made the change: every fixable stop comes back here. */}
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

        {/* Fixed: the new snapshot goes through Check again. */}
        <path d={`M88 ${LANE_Y}H66Q54 ${LANE_Y} 54 ${LANE_Y - 12}V${LINE_Y + 14}Q54 ${LINE_Y} 68 ${LINE_Y}H104`} pathLength={1} stroke={SOL.green} strokeWidth={2} fill="none" className="bj-draw" style={t(3.8, 0.7)} />
        <Head x={112} y={LINE_Y} dir="r" color={SOL.green} style={t(4.5)} />
        <text x={20} y={LANE_Y + 44} fontSize="10" fill={SOL.green} className="bj-fade" style={t(4.2)}>fixed: Check, then every stage after it, again</text>
        <text x={700} y={LANE_Y + 44} textAnchor="end" fontSize="10" fill={SOL.base1} className="bj-fade" style={t(4.4)}>at most 3 times each way back</text>
      </svg>
    </Stage>
  );
}
