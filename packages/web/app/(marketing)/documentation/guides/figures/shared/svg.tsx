"use client";

import type { ReactNode } from "react";
import { SOL } from "../../../../blog/blogChrome";
import { t } from "../../../../blog/figureKit";

/**
 * SVG pieces several guides' figures share: the dotted grid with an arrow
 * marker, a labeled box that pops in, and an arrow that draws itself.
 * Each figure passes its own `id` so patterns never collide on one page.
 * A dashed arrow fades in and keeps its real length: bj-draw and pathLength
 * both take over the dash array.
 */

export function Grid({ id, w, h }: { id: string; w: number; h: number }) {
  return (
    <>
      <defs>
        <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
        </pattern>
        <marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L8 4L0 8z" fill={SOL.base1} />
        </marker>
      </defs>
      <rect width={w} height={h} fill={`url(#${id})`} />
    </>
  );
}

export function Box({ x, y, w, h = 50, title, sub, at, dark, stroke }: {
  x: number; y: number; w: number; h?: number; title: ReactNode; sub?: ReactNode; at: number; dark?: boolean; stroke?: string;
}) {
  const mid = sub ? y + h / 2 - 4 : y + h / 2 + 4;
  return (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={dark ? SOL.base03 : SOL.base3} stroke={stroke ?? (dark ? SOL.base03 : SOL.base1)} strokeWidth={stroke ? 1.5 : 1} />
      <text x={x + w / 2} y={mid} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={dark ? SOL.base3 : SOL.base02}>{title}</text>
      {sub && <text x={x + w / 2} y={mid + 16} textAnchor="middle" fontSize="10" fill={dark ? SOL.base1 : SOL.base01}>{sub}</text>}
    </g>
  );
}

export function Arrow({ d, at, grid, color = SOL.base1, dashed, dur = 0.35, head = true }: {
  d: string; at: number; grid: string; color?: string; dashed?: boolean; dur?: number; head?: boolean;
}) {
  return (
    <path d={d} pathLength={dashed ? undefined : 1} stroke={color} strokeWidth={1.4} strokeDasharray={dashed ? "4 3" : undefined} fill="none" markerEnd={head ? `url(#${grid}-arrow)` : undefined} className={dashed ? "bj-fade" : "bj-draw"} style={t(at, dur)} />
  );
}
