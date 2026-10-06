"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { t } from "../../blog/figureKit";

/**
 * SVG primitives shared by the guides' figures (figures/<slug>.tsx), on top of
 * the blog's animation kit: the dotted sheet every diagram sits on, an
 * arrowhead in each ink, a labeled box, a connector arrow, a multi-line label
 * and a dark terminal block. Animation stays with the kit's classes; pass
 * `className` and `style={t(at)}` through, or `at` where a part offers it.
 */

export type Ink = keyof typeof SOL;

/** A diagram on the dotted grid. A function child receives `arrow(ink)`, the
 *  markerEnd url for an arrowhead in that ink. Ids are per instance, so two
 *  sheets on one page never share a pattern or a marker. */
export function Sheet({ w, h, label, children }: { w: number; h: number; label: string; children: ReactNode | ((arrow: (ink?: Ink) => string) => ReactNode) }) {
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
      {typeof children === "function" ? children(arrow) : children}
    </svg>
  );
}

type Anim = { className?: string; style?: CSSProperties };

/** A rounded box with a bold title and an optional sub line, centered. `dark`
 *  inverts it; `at` pops it in at that time unless `className` says otherwise. */
export function Box({ x, y, w, h = 50, title, sub, ink, fill, dark, dashed, bold = 1.1, size = 12, at, className, style }: {
  x: number; y: number; w: number; h?: number; title: ReactNode; sub?: ReactNode; ink?: Ink; fill?: string; dark?: boolean; dashed?: boolean; bold?: number; size?: number; at?: number;
} & Anim) {
  const cy = y + h / 2;
  const lift = (12 - size) * 2; // a smaller title lifts the pair to stay centered
  const timed = at !== undefined;
  return (
    <g className={className ?? (timed ? "bj-pop" : undefined)} style={style ?? (timed ? t(at) : undefined)}>
      <rect x={x} y={y} width={w} height={h} rx={8} fill={fill ?? (dark ? SOL.base03 : SOL.base3)} stroke={SOL[ink ?? (dark ? "base03" : "base1")]} strokeWidth={bold} strokeDasharray={dashed ? "4 3" : undefined} />
      <text x={x + w / 2} y={sub ? cy - 3 - lift : cy + 4} textAnchor="middle" fontSize={size} fontWeight={700} fill={dark ? SOL.base3 : SOL.base02}>{title}</text>
      {sub && <text x={x + w / 2} y={cy + 13 - lift} textAnchor="middle" fontSize="10" fill={dark ? SOL.base1 : SOL.base01}>{sub}</text>}
    </g>
  );
}

/** A connector that draws itself from `at`. A dashed one fades in instead and
 *  keeps its real length: bj-draw and pathLength would take over its dash
 *  array. `head` is the sheet's `arrow(ink)`; leave it out for a bare line. */
export function Arrow({ d, at, head, color = SOL.base1, width = 1.4, dashed, dur = 0.35 }: {
  d: string; at: number; head?: string; color?: string; width?: number; dashed?: boolean; dur?: number;
}) {
  return (
    <path d={d} pathLength={dashed ? undefined : 1} stroke={color} strokeWidth={width} strokeDasharray={dashed ? "4 3" : undefined} fill="none" markerEnd={head} className={dashed ? "bj-fade" : "bj-draw"} style={t(at, dur)} />
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

/** A dark terminal block for the command half of a two-panel figure: either
 *  `lines` (dim ones in a quieter ink) or children of its own. `space` is its
 *  margin and padding. */
export function Term({ lines, children, size = 12, leading = 1.7, space = "m-4 p-4", className, style }: {
  lines?: { text: string; dim?: boolean }[]; children?: ReactNode; size?: number; leading?: number; space?: string;
} & Anim) {
  return (
    <pre className={`${space} rounded-lg font-mono overflow-x-auto ${className ?? ""}`} style={{ backgroundColor: SOL.base03, color: SOL.base1, fontSize: size, lineHeight: leading, ...style }}>
      {lines?.map((l, i) => (
        <div key={i} style={{ color: l.dim ? SOL.base01 : SOL.base2 }}>{l.text || " "}</div>
      ))}
      {children}
    </pre>
  );
}

/** A diagonal-stripe fill, referenced as `url(#id)`, for time spent waiting,
 *  parked or lost. */
export function Hatch({ id, ink = "base1", opacity, stripe = 2 }: { id: string; ink?: Ink; opacity: number; stripe?: number }) {
  return (
    <defs>
      <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width={stripe} height="6" fill={SOL[ink]} opacity={opacity} />
      </pattern>
    </defs>
  );
}
