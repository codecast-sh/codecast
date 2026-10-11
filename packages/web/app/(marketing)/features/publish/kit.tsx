"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C as SharedC } from "../kit";

export const CYAN = SOL.cyan;
export const SITE = "codecast.sh/a/";

/** Inline style that sets an animation delay (seconds) on a `.pb-anim` element. */
export function delay(d: number, extra?: CSSProperties): CSSProperties {
  return { ...(extra ?? {}), ["--d" as string]: `${d}s` } as CSSProperties;
}

/** A page section: a number tab on the left rail, the heading, a lede, then the body. */
export function Section({ id, n, title, lede, children, tone = "paper" }: {
  id: string; n: string; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "paper" | "sand";
}) {
  return (
    <section id={id} className="scroll-mt-20" style={{ backgroundColor: tone === "sand" ? SOL.base2 : SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-28">
        <div className="grid lg:grid-cols-[88px_1fr] gap-x-6">
          <div className="hidden lg:block pt-1.5">
            <span className="font-mono text-[13px] font-semibold tabular-nums" style={{ color: CYAN }}>{n}</span>
            <div className="mt-3 w-px h-16" style={{ backgroundColor: "rgba(42,161,152,.35)" }} />
          </div>
          <div className="min-w-0">
            <h2 className="font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em] max-w-3xl [text-wrap:balance]" style={{ color: SOL.base03 }}>
              {title}
            </h2>
            <p className="mt-4 text-[17px] leading-8 max-w-2xl" style={{ color: SOL.base01 }}>{lede}</p>
            <div className="mt-12">{children}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Inline code in prose: the shared chip, tinted with this page's cyan. */
export function C({ children }: { children: ReactNode }) {
  return <SharedC tint={CYAN}>{children}</SharedC>;
}

/** A short supporting paragraph under a mock. */
export function Note({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[15px] leading-7 ${className}`} style={{ color: SOL.base01 }}>{children}</p>;
}

/** A small mono caption with a cyan tick. */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 font-mono text-[12px] leading-5 mt-3" style={{ color: SOL.base1 }}>
      <span className="mt-[7px] h-px w-3 shrink-0" style={{ backgroundColor: CYAN }} />
      <span>{children}</span>
    </div>
  );
}

function LogoGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={SOL.base03} strokeWidth={2.4} aria-hidden>
      <path d="M16 7a6 6 0 1 0 0 10" strokeLinecap="round" />
      <circle cx="18.5" cy="12" r="1.6" fill={SOL.base03} stroke="none" />
    </svg>
  );
}

/**
 * The bar codecast pins to the top of every published page: brand, title, the
 * session that published it, the date, the version chip, discussion, menu.
 * `version` may be a node so the hero can animate the chip's label.
 */
export function PageBar({ title, session, when, version, comments, old = false, compact = false }: {
  title: string; session?: string; when: string; version: ReactNode; comments?: number; old?: boolean; compact?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 h-[34px] px-2.5 font-mono text-[11px] border-b" style={{ backgroundColor: "rgba(253,252,250,.95)", borderColor: "rgba(88,110,117,.22)", color: SOL.base01 }}>
      <span className="mr-1.5 opacity-85 flex"><LogoGlyph /></span>
      <span className="flex-1 min-w-0 truncate font-medium" style={{ color: SOL.base03, opacity: 0.82 }}>{title}</span>
      {session && !compact && (
        <span className="hidden sm:inline truncate max-w-[16ch] px-1.5" style={{ color: SOL.blue, opacity: 0.85 }}>{session}</span>
      )}
      {!compact && <span className="hidden md:inline px-1.5 whitespace-nowrap" style={{ color: "rgba(0,43,54,.48)" }}>{when}</span>}
      <span
        className="relative inline-flex items-center gap-1 rounded-full border px-2 py-[2px] font-semibold whitespace-nowrap"
        style={{ color: old ? "#c07a28" : SOL.base03, borderColor: old ? "rgba(192,122,40,.45)" : "rgba(88,110,117,.28)" }}
      >
        {version}
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </span>
      {comments !== undefined && (
        <span className="inline-flex items-center gap-1 px-1.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>
          {comments > 0 && <span className="text-[10px] font-semibold" style={{ color: "rgba(0,43,54,.48)" }}>{comments}</span>}
        </span>
      )}
      <span className="px-1 opacity-60" aria-hidden>···</span>
    </div>
  );
}

/** Browser chrome around a mock page: dots and an address field. */
export function BrowserFrame({ url, children, className = "", style, urlNode }: {
  url: string; children: ReactNode; className?: string; style?: CSSProperties; urlNode?: ReactNode;
}) {
  return (
    <div className={`rounded-xl border overflow-hidden bg-white ${className}`} style={{ borderColor: "rgba(88,110,117,.25)", boxShadow: "0 30px 60px -30px rgba(0,43,54,.45), 0 2px 6px rgba(0,43,54,.06)", ...style }}>
      <div className="flex items-center gap-3 px-3 h-9 border-b" style={{ backgroundColor: SOL.base2, borderColor: "rgba(88,110,117,.2)" }}>
        <div className="flex gap-1.5 shrink-0">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.red, opacity: 0.8 }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.yellow, opacity: 0.8 }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.green, opacity: 0.8 }} />
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-1.5 rounded-md px-2.5 h-6 font-mono text-[11px] truncate" style={{ backgroundColor: SOL.base3, color: SOL.base01 }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={SOL.base1} strokeWidth={2.4} aria-hidden><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
          {urlNode ?? <span className="truncate">{url}</span>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Flag token used in tables and gate rows. */
export function Flag({ children, color = CYAN }: { children: ReactNode; color?: string }) {
  return (
    <code className="font-mono text-[12px] font-semibold whitespace-nowrap px-1.5 py-0.5 rounded" style={{ color, backgroundColor: "rgba(0,43,54,.05)" }}>
      {children}
    </code>
  );
}

