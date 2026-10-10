"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";

/** The page's accent: the yellow the product uses for a blocking ask (its pulsing dot, the primary option's border). */
export const Y = SOL.yellow;
/** The advisory accent, as the product draws it. */
export const B = SOL.blue;

/** A CSS custom property for an animation delay on a `.dq-in` element (seconds). */
export function at(d: number, extra?: CSSProperties): CSSProperties {
  return { ...(extra ?? {}), ["--d" as string]: `${d}s` } as CSSProperties;
}

/**
 * A page section. The heading sits beside a short margin note on wide
 * screens (what to take away) and above it on a phone.
 */
export function Section({ id, title, lede, children, tone = "paper", aside }: {
  id: string; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "paper" | "sand"; aside?: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20" style={{ backgroundColor: tone === "sand" ? SOL.base2 : SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-x-14 gap-y-5 items-end">
          <div className="min-w-0">
            <h2 className="font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em] max-w-3xl [text-wrap:balance]" style={{ color: SOL.base03 }}>
              {title}
            </h2>
            <p className="mt-4 text-[17px] leading-8 max-w-2xl" style={{ color: SOL.base01 }}>{lede}</p>
          </div>
          {aside && (
            <div className="text-[14px] leading-6 pl-4 border-l-2" style={{ color: SOL.base00, borderColor: Y }}>{aside}</div>
          )}
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

/** Inline code in prose. */
export function C({ children }: { children: ReactNode }) {
  // Short flags never break at their hyphens; long commands may wrap on a phone.
  const short = typeof children === "string" && children.length <= 26;
  return (
    <code className={`font-mono text-[0.86em] px-1.5 py-0.5 rounded ${short ? "whitespace-nowrap" : "[overflow-wrap:anywhere]"}`} style={{ backgroundColor: "rgba(181,137,0,.12)", color: SOL.base02 }}>
      {children}
    </code>
  );
}

/** A short supporting paragraph. */
export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[15px] leading-7 ${className}`} style={{ color: SOL.base01 }}>{children}</p>;
}

/** A small mono label above a mock. */
export function Label({ children, color = SOL.base1 }: { children: ReactNode; color?: string }) {
  return <div className="font-mono text-[12px] mb-3" style={{ color }}>{children}</div>;
}

/** The product's state dot: a pulsing yellow for a blocking ask on a live session, dim when the session is not running, blue for advisory. */
export function Dot({ tier, still = false }: { tier: 1 | 2 | 3 | "ok"; still?: boolean }) {
  const color = tier === 1 ? Y : tier === 2 ? SOL.base1 : tier === 3 ? B : SOL.green;
  return <span className={`inline-block w-1.5 h-1.5 shrink-0 rounded-full ${tier === 1 && !still ? "dq-pulse" : ""}`} style={{ backgroundColor: color }} />;
}
