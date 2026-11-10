"use client";

import type { CSSProperties, ReactNode } from "react";
import { ROLE_ICON_TILE, roleIconStroke, roleIconSvg, type RoleIcon } from "@codecast/shared/contracts/roleIcon";
import { ICONS, type IconKey } from "./icons";
import { ACCENT, BODY, INK, LINE, MUTED, PAPER, SAND, SOL, STATE, TEXT, tint, type PersonRow, type SessionState } from "./model";

/*
 * The org page's shared components: the faces (role tiles, people, sessions)
 * and the section frame. Values (colours, the illustrative org, motion CSS)
 * live in model.ts.
 *
 * Role faces are the app's drawn icon tiles (RoleIconTile, .role-tile in
 * globals.css), redrawn here with fixed light-theme colours so a reader whose
 * app is in dark mode still sees the page's light tiles. The mix ratios match
 * .role-tile exactly.
 */

// ---- Faces -----------------------------------------------------------------

/**
 * A role's face: its drawn icon on a rounded-square tile tinted with the icon's
 * accent. The rounded square means "standing role"; people and sessions are
 * circles, exactly as in the app.
 */
export function Tile({ k, size = 28, className = "", style, title, ring }: {
  k: IconKey; size?: number; className?: string; style?: CSSProperties; title?: string;
  /** Draw a focus ring in the tile's accent (a role that is lit up). */
  ring?: boolean;
}) {
  const icon = ICONS[k] as RoleIcon;
  const accent = ACCENT[icon.accent];
  const svg = roleIconSvg(icon, { strokeWidth: roleIconStroke(size) });
  return (
    <span
      role="img"
      aria-label={title ?? icon.concept}
      title={title}
      className={`inline-flex items-center justify-center shrink-0 ${className}`}
      style={{
        width: size, height: size,
        borderRadius: size * ROLE_ICON_TILE.radius,
        background: tint(accent, 20, SAND),
        boxShadow: `inset 0 0 0 1px ${tint(accent, 45, PAPER)}${ring ? `, 0 0 0 3px ${PAPER}, 0 0 0 5px ${accent}` : ""}`,
        color: `color-mix(in srgb, ${accent} 55%, ${TEXT})`,
        verticalAlign: "middle",
        ...style,
      }}
    >
      <span
        aria-hidden
        className="block [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
        style={{ width: `${ROLE_ICON_TILE.glyph * 100}%`, height: `${ROLE_ICON_TILE.glyph * 100}%` }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </span>
  );
}

/** A person: a circle with their initials. */
export function Person({ p, size = 28, className = "", style }: { p: PersonRow; size?: number; className?: string; style?: CSSProperties }) {
  return (
    <span
      role="img"
      aria-label={p.name}
      className={`inline-flex items-center justify-center shrink-0 rounded-full font-mono font-semibold ${className}`}
      style={{
        width: size, height: size, fontSize: size * 0.38,
        background: p.color, color: PAPER, letterSpacing: "-0.02em",
        boxShadow: `0 0 0 2px ${PAPER}`,
        ...style,
      }}
    >
      {p.initials}
    </span>
  );
}

/** A working session: a small circle in its state's colour. */
export function SessionDot({ state, size = 8, className = "" }: { state: SessionState; size?: number; className?: string }) {
  return <span className={`inline-block rounded-full shrink-0 ${className}`} style={{ width: size, height: size, backgroundColor: STATE[state].color }} />;
}

// ---- Layout ----------------------------------------------------------------

/** A section: a title column and a lede, then the demo full width under them. */
export function Section({ id, title, lede, children, band = false, dark = false }: {
  id: string; title: ReactNode; lede: ReactNode; children: ReactNode; band?: boolean; dark?: boolean;
}) {
  const bg = dark ? INK : band ? SAND : "transparent";
  return (
    <section id={id} className="relative scroll-mt-16 py-20 sm:py-28" style={{ backgroundColor: bg }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16 mb-12 items-start">
          <h2 className="font-mono font-bold text-[28px] sm:text-[38px] leading-[1.08] tracking-[-0.035em]" style={{ color: dark ? PAPER : INK }}>{title}</h2>
          <div className="text-[16px] sm:text-[17px] leading-[1.7] space-y-4" style={{ color: dark ? SOL.base1 : BODY }}>{lede}</div>
        </div>
        <div className="min-w-0">{children}</div>
      </div>
    </section>
  );
}

/** A framed piece of product UI on the page. */
export function Frame({ children, className = "", style, label }: { children: ReactNode; className?: string; style?: CSSProperties; label?: ReactNode }) {
  return (
    <div className={`rounded-2xl border overflow-hidden ${className}`} style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 30px 70px -40px rgba(0,43,54,.45)", ...style }}>
      {label && <div className="px-4 h-9 flex items-center gap-2 border-b text-meta font-mono" style={{ borderColor: LINE, color: MUTED, backgroundColor: tint(SAND, 50) }}>{label}</div>}
      {children}
    </div>
  );
}

