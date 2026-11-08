"use client";

import { Fragment, useState, type CSSProperties, type SVGProps } from "react";
import { flattenRoleIconPath, roleIconStroke, roleIconSvg, ROLE_ICON_MAX_SHAPES, ROLE_ICON_TILE, type RoleIconShape, type RoleIconSegment } from "@codecast/shared/contracts/roleIcon";
import { ROLES, SOL } from "./model";
import type { IconKey } from "./icons";
import { accentHex, glow, iconOf } from "./facesData";

/*
 * The faces section's parts: a role tile drawn for the dark band, the shape
 * geometry the inspector measures, and the inspector itself (the icon huge on
 * its 24 grid, its shapes listed, and the same icon at sidebar sizes).
 */

/** A role tile for the dark band: the app's tile geometry, tinted over base02 and glowing in its accent. */
export function DarkTile({ k, size, className = "", style, gray = false }: { k: IconKey; size: number; className?: string; style?: CSSProperties; gray?: boolean }) {
  const c = accentHex(k);
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 ${className}`}
      style={{
        width: size, height: size, borderRadius: size * ROLE_ICON_TILE.radius,
        background: `color-mix(in srgb, ${c} 24%, ${SOL.base02})`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 55%, ${SOL.base03})`,
        color: glow(c), filter: gray ? "grayscale(1)" : undefined,
        ...style,
      }}
    >
      <Glyph k={k} px={size} />
    </span>
  );
}

/** The icon's canonical markup from roleIconSvg, in the tile's glyph box. */
export function Glyph({ k, px }: { k: IconKey; px: number }) {
  return (
    <span
      aria-hidden
      className="block [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
      style={{ width: `${ROLE_ICON_TILE.glyph * 100}%`, height: `${ROLE_ICON_TILE.glyph * 100}%` }}
      dangerouslySetInnerHTML={{ __html: roleIconSvg(iconOf(k), { strokeWidth: roleIconStroke(px) }) }}
    />
  );
}

// ---- Geometry --------------------------------------------------------------

function ring(cx: number, cy: number, rx: number, ry: number): RoleIconSegment[] {
  const out: RoleIconSegment[] = [];
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2, b = ((i + 1) / 48) * Math.PI * 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a), cx + rx * Math.cos(b), cy + ry * Math.sin(b)]);
  }
  return out;
}

function runs(p: number[], close: boolean): RoleIconSegment[] {
  const out: RoleIconSegment[] = [];
  for (let i = 0; i + 3 < p.length; i += 2) out.push([p[i], p[i + 1], p[i + 2], p[i + 3]]);
  if (close && p.length >= 4) out.push([p[p.length - 2], p[p.length - 1], p[0], p[1]]);
  return out;
}

/** A shape as straight segments on the grid, the way validation reads it. */
function segmentsOf(s: RoleIconShape): RoleIconSegment[] {
  switch (s.t) {
    case "path": return flattenRoleIconPath(s.d);
    case "circle": return ring(s.cx, s.cy, s.r, s.r);
    case "ellipse": return ring(s.cx, s.cy, s.rx, s.ry);
    case "rect": return runs([s.x, s.y, s.x + s.width, s.y, s.x + s.width, s.y + s.height, s.x, s.y + s.height], true);
    case "line": return [[s.x1, s.y1, s.x2, s.y2]];
    case "polyline": return runs(s.points, false);
    case "polygon": return runs(s.points, true);
  }
}

type Box = { x0: number; y0: number; x1: number; y1: number };
function boundsOf(segs: RoleIconSegment[]): Box {
  const b = { x0: 24, y0: 24, x1: 0, y1: 0 };
  for (const [a, c, d, e] of segs) {
    b.x0 = Math.min(b.x0, a, d); b.x1 = Math.max(b.x1, a, d);
    b.y0 = Math.min(b.y0, c, e); b.y1 = Math.max(b.y1, c, e);
  }
  return b;
}

/** Where the ink sits: the length-weighted centre of every stroke. */
function inkCentre(segs: RoleIconSegment[]): [number, number] {
  let L = 0, x = 0, y = 0;
  for (const [a, b, c, d] of segs) {
    const l = Math.hypot(c - a, d - b);
    L += l; x += l * (a + c) / 2; y += l * (b + d) / 2;
  }
  return L ? [x / L, y / L] : [12, 12];
}

const n = (v: number) => String(Math.round(v * 10) / 10);

/** One glanceable line of a shape's geometry. */
function summary(s: RoleIconShape): string {
  switch (s.t) {
    case "path": return s.d.replace(/\s+/g, " ").trim();
    case "circle": return `${n(s.cx)},${n(s.cy)}  r ${n(s.r)}${s.fill ? "  dot" : ""}`;
    case "ellipse": return `${n(s.cx)},${n(s.cy)}  ${n(s.rx)} x ${n(s.ry)}`;
    case "rect": return `${n(s.x)},${n(s.y)}  ${n(s.width)} x ${n(s.height)}${s.rx ? `  r ${n(s.rx)}` : ""}`;
    case "line": return `${n(s.x1)},${n(s.y1)} to ${n(s.x2)},${n(s.y2)}`;
    case "polyline": case "polygon": return `${s.points.length / 2} points`;
  }
}

/** A shape as an SVG element on the 24 grid. */
function ShapeEl({ s, ...rest }: { s: RoleIconShape } & Omit<SVGProps<SVGElement>, "ref">) {
  switch (s.t) {
    case "path": return <path d={s.d} {...rest} />;
    case "circle": return <circle cx={s.cx} cy={s.cy} r={s.r} {...rest} {...(s.fill ? { fill: "currentColor", stroke: "none" } : {})} />;
    case "ellipse": return <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} {...rest} />;
    case "rect": return <rect x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} {...rest} />;
    case "line": return <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...rest} />;
    case "polyline": return <polyline points={s.points.join(" ")} {...rest} />;
    case "polygon": return <polygon points={s.points.join(" ")} {...rest} />;
  }
}

// ---- Inspector -------------------------------------------------------------

const RULE = "rgba(147,161,161,.16)";
const SIZES = [18, 22, 44];

/** The picked icon huge on its grid, its shapes, and the sizes it must read at. */
export function Inspector({ k, drawKey }: { k: IconKey; drawKey: string }) {
  const [hi, setHi] = useState<number | null>(null);
  const icon = iconOf(k);
  const c = accentHex(k);
  const per = icon.shapes.map(segmentsOf);
  const all = boundsOf(per.flat());
  const [ix, iy] = inkCentre(per.flat());
  const inside = all.x0 >= 2 && all.y0 >= 2 && all.x1 <= 22 && all.y1 <= 22;
  const wearer = ROLES.find((r) => r.k === k);
  const hb = hi === null ? null : boundsOf(per[hi]);

  return (
    <div className="og-faces-panel rounded-2xl grid gap-8 p-5 sm:p-7 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)_264px] lg:gap-10" style={{ ["--fc" as string]: c }}>
      {/* The construction canvas */}
      <div className="min-w-0">
        <div className="og-faces-canvas relative w-full max-w-[340px] aspect-square rounded-xl mx-auto lg:mx-0">
          <svg viewBox="-2 -2 28 28" className="absolute inset-0 w-full h-full" role="img" aria-label={`${icon.concept}, drawn on its 24 unit grid`}>
            {Array.from({ length: 25 }, (_, i) => (
              <g key={i} stroke={i % 12 === 0 ? "rgba(147,161,161,.42)" : "rgba(147,161,161,.13)"} strokeWidth={i % 12 === 0 ? 0.05 : 0.03}>
                <line x1={i} y1={0} x2={i} y2={24} />
                <line x1={0} y1={i} x2={24} y2={i} />
              </g>
            ))}
            <rect x={2} y={2} width={20} height={20} fill="none" stroke={glow(c, 60)} strokeWidth={0.07} strokeDasharray="0.4 0.3" opacity={0.7} />
            {[0, 2, 12, 22, 24].map((v) => (
              <text key={v} x={v} y={-0.4} textAnchor="middle" className="og-faces-num">{v}</text>
            ))}
            {[2, 12, 22].map((v) => (
              <text key={v} x={-0.45} y={v + 0.32} textAnchor="end" className="og-faces-num">{v}</text>
            ))}
            {/* Optical centre */}
            <g stroke={SOL.base1} strokeWidth={0.06} opacity={0.8}>
              <line x1={10.6} y1={12} x2={13.4} y2={12} />
              <line x1={12} y1={10.6} x2={12} y2={13.4} />
              <circle cx={12} cy={12} r={0.55} fill="none" />
            </g>
            {/* The shapes, drawn on when picked */}
            <g key={drawKey} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ color: glow(c, 80) }}>
              {icon.shapes.map((s, i) => (
                <ShapeEl
                  key={i}
                  s={s}
                  pathLength={1}
                  className={`og-faces-a ${s.t === "circle" && s.fill ? "og-faces-dot" : "og-faces-draw"}`}
                  style={{ ["--d" as string]: `${0.1 + i * 0.16}s`, opacity: hi === null || hi === i ? 1 : 0.14, color: hi === i ? glow(c, 96) : undefined, filter: hi === i ? `drop-shadow(0 0 0.7px ${c})` : undefined, transition: "opacity .2s ease, color .2s ease", cursor: "pointer" }}
                  onMouseEnter={() => setHi(i)}
                  onMouseLeave={() => setHi(null)}
                />
              ))}
            </g>
            {hb && (
              <g pointerEvents="none">
                <rect x={hb.x0} y={hb.y0} width={Math.max(hb.x1 - hb.x0, 0.01)} height={Math.max(hb.y1 - hb.y0, 0.01)} fill="none" stroke={SOL.base3} strokeWidth={0.06} strokeDasharray="0.3 0.25" />
                <text x={hb.x0} y={hb.y0 - 0.4} className="og-faces-num" style={{ fill: SOL.base3 }}>{icon.shapes[hi!].t}</text>
              </g>
            )}
            {/* Ink centre */}
            <circle cx={ix} cy={iy} r={0.32} fill={SOL.base3} stroke={SOL.base03} strokeWidth={0.08} pointerEvents="none" />
          </svg>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 justify-center lg:justify-start font-mono text-[11px]" style={{ color: SOL.base0 }}>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-[2px] border border-dashed" style={{ borderColor: glow(c, 60) }} />live area 2..22</span>
          <span className="inline-flex items-center gap-1.5"><span className="og-faces-cross" />centre 12,12</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2 h-2 rounded-full" style={{ background: SOL.base3 }} />ink {n(ix)},{n(iy)}</span>
        </div>
      </div>

      {/* Name, checks and the shape list */}
      <div className="min-w-0">
        <div key={k} className="og-faces-a og-faces-swap flex items-center gap-3">
          <DarkTile k={k} size={40} />
          <div className="min-w-0">
            <div className="font-mono font-bold text-[22px] leading-tight tracking-[-0.02em]" style={{ color: glow(c, 78) }}>{icon.concept}</div>
            <div className="font-mono text-[12px] mt-0.5" style={{ color: SOL.base0 }}>{wearer ? <>worn by {wearer.title} <span style={{ color: SOL.base01 }}>{wearer.handle}</span></> : <>{icon.accent}</>}</div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 font-mono text-[11.5px]">
          <Check ok label="24 grid" />
          <Check ok label="stroke 2, round" />
          <Check ok={icon.shapes.length <= ROLE_ICON_MAX_SHAPES} label={`${icon.shapes.length} of ${ROLE_ICON_MAX_SHAPES} shapes`} />
          <Check ok={inside} label={`ink ${n(all.x0)}..${n(all.x1)} x ${n(all.y0)}..${n(all.y1)}`} />
          <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md" style={{ background: `color-mix(in srgb, ${c} 18%, transparent)`, color: glow(c, 80) }}>
            <span className="w-2 h-2 rounded-full" style={{ background: c }} />{icon.accent}
          </span>
          <Fact label="stored as shapes, never SVG" />
          <Fact label="same markup on web and phone" />
          <Fact label="about $0.10 to draw" />
        </div>
        <ol className="mt-5 rounded-xl overflow-hidden" style={{ border: `1px solid ${RULE}` }}>
          {icon.shapes.map((s, i) => (
            <li
              key={`${k}-${i}`}
              onMouseEnter={() => setHi(i)}
              onMouseLeave={() => setHi(null)}
              className="flex items-center gap-3 px-3 h-10 font-mono text-[12.5px] cursor-default"
              style={{ borderTop: i ? `1px solid ${RULE}` : undefined, background: hi === i ? `color-mix(in srgb, ${c} 16%, transparent)` : undefined, transition: "background-color .15s ease" }}
            >
              <span className="w-4 text-right shrink-0" style={{ color: SOL.base01 }}>{i + 1}</span>
              <span className="shrink-0 w-[68px] px-1.5 py-0.5 rounded text-center text-[11px]" style={{ background: "rgba(147,161,161,.12)", color: hi === i ? glow(c, 85) : SOL.base1 }}>{s.t}</span>
              <span className="truncate" title={summary(s)} style={{ color: hi === i ? SOL.base3 : SOL.base0 }}>{summary(s)}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* The sizes it has to read at */}
      <div className="min-w-0">
        <div className="font-mono text-[12px] mb-4" style={{ color: SOL.base1 }}>At size</div>
        <div className="grid grid-cols-[64px_repeat(3,minmax(0,1fr))] items-center gap-y-4 rounded-xl px-4 py-4 mb-4" style={{ border: `1px solid ${RULE}` }}>
          <span />
          {SIZES.map((px) => (
            <span key={px} className="text-center font-mono text-[11.5px]" style={{ color: SOL.base0 }}>{px} px</span>
          ))}
          {[false, true].map((gray) => (
            <Fragment key={String(gray)}>
              <span className="font-mono text-[11.5px]" style={{ color: SOL.base0 }}>{gray ? "gray" : "colour"}</span>
              {SIZES.map((px) => (
                <span key={px} className="flex items-center justify-center h-[48px]"><DarkTile k={k} size={px} gray={gray} /></span>
              ))}
            </Fragment>
          ))}
        </div>
        <div className="rounded-lg px-2.5 py-2 flex items-center gap-2" style={{ background: SOL.base3 }}>
          <span className="inline-flex items-center justify-center shrink-0" style={{ width: 18, height: 18, borderRadius: 18 * ROLE_ICON_TILE.radius, background: `color-mix(in srgb, ${c} 20%, ${SOL.base2})`, boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 45%, ${SOL.base3})`, color: `color-mix(in srgb, ${c} 55%, ${SOL.base02})` }}>
            <Glyph k={k} px={18} />
          </span>
          <span className="font-mono text-[11.5px] truncate" style={{ color: SOL.base02 }}>{wearer?.handle ?? `@${icon.concept.split(" ")[0]}`}</span>
          <span className="ml-auto font-mono text-[10.5px]" style={{ color: SOL.base1 }}>light</span>
        </div>
      </div>
    </div>
  );
}

function Fact({ label }: { label: string }) {
  return <span className="inline-flex items-center h-7 px-2.5 rounded-md" style={{ boxShadow: `inset 0 0 0 1px ${RULE}`, color: SOL.base0 }}>{label}</span>;
}

function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md" style={{ background: "rgba(147,161,161,.1)", color: SOL.base1 }}>
      <svg viewBox="0 0 12 12" width={11} height={11} fill="none" stroke={ok ? SOL.green : SOL.red} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {ok ? <path d="M2.5 6.3l2.3 2.2 4.7-5" /> : <path d="M3 3l6 6M9 3l-6 6" />}
      </svg>
      {label}
    </span>
  );
}
