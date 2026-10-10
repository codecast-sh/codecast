"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Arrow, Sheet } from "../figureParts";

/** Figures for the messaging guide: where the inbox gestures move a session. */

// ─── The inbox gestures ────────────────────────────────────────────────────

/** Where a session sits in the human's inbox, and what moves it. */
export function InboxGesturesFigure() {
  const node = (x: number, y: number, w: number, title: string, sub: string, color: string, at: number) => (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={w} height={54} rx={10} fill={`${color}14`} stroke={color} strokeWidth={1.5} />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>{title}</text>
      <text x={x + w / 2} y={y + 39} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{sub}</text>
    </g>
  );
  const label = (x: number, y: number, text: string, color: string, at: number, anchor: "start" | "middle" | "end" = "middle") => (
    <text x={x} y={y} textAnchor={anchor} fontSize="10" fill={color} stroke={SOL.base3} strokeWidth={4} paintOrder="stroke" className="bj-fade" style={t(at)}>{text}</text>
  );
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={300} label="Stash moves a session out of the inbox while it keeps running; a scheduled wake brings a plain stash back; a hidden stash returns only when it needs you; kill tears it down; Restore brings the card back">
        {(arrow) => (
          <>
            {node(300, 20, 160, "inbox", "you see it", SOL.blue, 0.1)}
            {node(30, 150, 210, "stashed", "agent keeps running", SOL.cyan, 0.5)}
            {node(275, 150, 210, "stashed and hidden", "agent keeps running", SOL.violet, 0.8)}
            {node(520, 150, 210, "killed", "torn down, triggers off", SOL.red, 1.1)}

            <Arrow head={arrow()} d="M298 56C200 60 170 100 165 144" at={0.6} />
            {label(198, 112, "Stash", SOL.base02, 0.7, "start")}
            <Arrow head={arrow()} d="M365 78V144" at={0.9} />
            {label(358, 116, "Stash and hide", SOL.base02, 1.0, "end")}
            <Arrow head={arrow()} d="M462 56C560 60 590 100 595 144" at={1.2} />
            {label(562, 112, "Kill", SOL.base02, 1.3, "end")}

            <Arrow head={arrow()} d="M90 148C90 80 180 36 296 34" at={1.6} color={SOL.cyan} dashed />
            <Arrow head={arrow()} d="M400 148V82" at={1.9} color={SOL.violet} dashed />
            <Arrow head={arrow()} d="M680 148C680 80 580 36 464 34" at={2.2} color={SOL.base1} dashed />

            {[
              { x: 135, color: SOL.cyan, lines: ["back when a scheduled wake fires,", "or it asks for you"] },
              { x: 380, color: SOL.violet, lines: ["back only when it needs you:", "blocked, flagged, or stalled"] },
              { x: 625, color: SOL.base01, lines: ["back on Restore", "(the card, not the agent)"] },
            ].map((c, i) => (
              <text key={i} x={c.x} y={226} textAnchor="middle" fontSize="10" fill={c.color} className="bj-fade" style={t(1.7 + i * 0.3)}>
                <tspan x={c.x}>{c.lines[0]}</tspan>
                <tspan x={c.x} dy={14}>{c.lines[1]}</tspan>
              </text>
            ))}
            {label(380, 284, "dashed: what brings a session back to the inbox", SOL.base1, 2.6)}
          </>
        )}
      </Sheet>
    </Stage>
  );
}
