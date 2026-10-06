"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";

/**
 * SVG primitives shared by the guides' figures (figures/<slug>.tsx), on top of
 * the blog's animation kit: the dotted sheet every diagram sits on, an
 * arrowhead in each ink, a labeled box and a multi-line label. Animation stays
 * with the kit's classes; pass `className` and `style={t(at)}` through.
 */

export type Ink = keyof typeof SOL;

/** A diagram on the dotted grid. `children` receives `arrow(ink)`, the
 *  markerEnd url for an arrowhead in that ink. Ids are per instance, so two
 *  sheets on one page never share a pattern or a marker. */
export function Sheet({ w, h, label, children }: { w: number; h: number; label: string; children: (arrow: (ink?: Ink) => string) => ReactNode }) {
  const id = `fs${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const arrow = (ink: Ink = "base1") => `url(#${id}-a-${ink})`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full block font-mono" role="img" aria-label={label}>
      <defs>
        <pattern id={`${id}-grid`} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
        </pattern>
        {(Object.keys(SOL) as Ink[]).map((k) => (
          <marker key={k} id={`${id}-a-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L8 4L0 8z" fill={SOL[k]} />
          </marker>
        ))}
      </defs>
      <rect width={w} height={h} fill={`url(#${id}-grid)`} />
      {children(arrow)}
    </svg>
  );
}

type Anim = { className?: string; style?: CSSProperties };

/** A rounded box with a bold title and an optional sub line, centered. */
export function Box({ x, y, w, h, title, sub, ink = "base1", fill = SOL.base3, dashed, bold = 1.1, className, style }: {
  x: number; y: number; w: number; h: number; title: string; sub?: string; ink?: Ink; fill?: string; dashed?: boolean; bold?: number;
} & Anim) {
  const cy = y + h / 2;
  return (
    <g className={className} style={style}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={fill} stroke={SOL[ink]} strokeWidth={bold} strokeDasharray={dashed ? "4 3" : undefined} />
      <text x={x + w / 2} y={sub ? cy - 3 : cy + 4} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>{title}</text>
      {sub && <text x={x + w / 2} y={cy + 13} textAnchor="middle" fontSize="10" fill={SOL.base01}>{sub}</text>}
    </g>
  );
}

/** Lines of mono text starting at (x, y), 13px apart. */
export function Label({ x, y, lines, ink = "base01", size = 10.5, anchor = "start", weight, className, style }: {
  x: number; y: number; lines: string[]; ink?: Ink; size?: number; anchor?: "start" | "middle" | "end"; weight?: number;
} & Anim) {
  return (
    <text x={x} y={y} fontSize={size} fill={SOL[ink]} textAnchor={anchor} fontWeight={weight} className={className} style={style}>
      {lines.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : size + 2.5}>{l}</tspan>
      ))}
    </text>
  );
}

/** A small dark terminal block for the command half of a two-panel figure. */
export function Term({ lines, className, style }: { lines: { text: string; dim?: boolean }[] } & Anim) {
  return (
    <pre className={`m-4 p-4 rounded-lg font-mono text-[12px] leading-[1.7] overflow-x-auto ${className ?? ""}`} style={{ backgroundColor: SOL.base03, color: SOL.base1, ...style }}>
      {lines.map((l, i) => (
        <div key={i} style={{ color: l.dim ? SOL.base01 : SOL.base2 }}>{l.text || " "}</div>
      ))}
    </pre>
  );
}
