"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import type { Speaker } from "./data";

/** A person's face: a filled circle with their initial. */
export function Face({ p, size = 24, ring }: { p: Speaker; size?: number; ring?: string }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white"
      style={{ width: size, height: size, fontSize: size * 0.42, backgroundColor: p.color, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined }}
      title={p.name}
    >
      {p.initials}
    </span>
  );
}

/** An agent's mark: a rounded square, so it never reads as a person. */
export function AgentMark({ size = 24 }: { size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[6px]" style={{ width: size, height: size, backgroundColor: SOL.magenta }} title="agent">
      <svg viewBox="0 0 24 24" style={{ width: size * 0.62, height: size * 0.62 }} fill="none" stroke="#fff" strokeWidth={2.2}>
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M12 8V4M8.5 13.5h.01M15.5 13.5h.01" />
      </svg>
    </span>
  );
}

/** Mirrors EntityIdPill for tasks: yellow tint, status ring, the short id or title. */
export function TaskChip({ id, title }: { id: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10.5px] font-mono" style={{ backgroundColor: "rgba(181,137,0,0.1)", color: SOL.yellow, borderColor: "rgba(181,137,0,0.25)" }}>
      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke={SOL.yellow} strokeWidth={2.5}><circle cx="12" cy="12" r="9" /></svg>
      {title ?? id}
    </span>
  );
}

/** A call reference pill, the way cl-42 renders inside a message. */
export function CallPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[11px] font-mono align-baseline" style={{ backgroundColor: "rgba(211,54,130,0.08)", color: SOL.magenta, borderColor: "rgba(211,54,130,0.25)" }}>
      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke={SOL.magenta} strokeWidth={2}><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z" /><path d="M19 11a7 7 0 0 1-14 0M12 18v3" /></svg>
      {children}
    </span>
  );
}

/** A light framed surface for product mocks. */
export function Frame({ children, className = "", style, label }: { children: ReactNode; className?: string; style?: CSSProperties; label?: string }) {
  return (
    <div className={`rounded-xl overflow-hidden font-mono text-left ${className}`} style={{ backgroundColor: "#fffaf0", border: `1px solid ${SOL.base2}`, ...style }} role={label ? "img" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

/** Section scaffold: a numbered heading with its lede, then the content. */
export function Section({ id, n, title, lede, children, tone = "light" }: { id: string; n: string; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "light" | "paper" }) {
  return (
    <section id={id} className="scroll-mt-20" style={{ backgroundColor: tone === "paper" ? SOL.base2 + "80" : undefined }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-14 mb-9">
          <h2 className="font-mono text-[26px] sm:text-[32px] font-bold leading-[1.15] tracking-tight" style={{ color: SOL.base03 }}>
            <span className="mr-3 inline-block align-[0.2em] rounded-full px-2 py-[1px] text-[13px] font-semibold" style={{ backgroundColor: "rgba(211,54,130,0.1)", color: SOL.magenta }}>{n}</span>
            {title}
          </h2>
          <div className="text-[15.5px] leading-[1.7] space-y-3 lg:pt-1" style={{ color: SOL.base01 }}>{lede}</div>
        </div>
        {children}
      </div>
    </section>
  );
}

/** Inline code in prose. */
export function C({ children }: { children: ReactNode }) {
  return <code className="font-mono whitespace-nowrap text-[0.88em] px-1.5 py-[1px] rounded" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>{children}</code>;
}

export function Dim({ children }: { children: ReactNode }) {
  return <span style={{ color: SOL.base01 }}>{children}</span>;
}
