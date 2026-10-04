"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C } from "../kit";

export const ACCENT = SOL.cyan;
export const PAPER = "#fffaf0";

/** The delay variables the hero's clock reads (pr.css). */
export function at(d: number, d2?: number): CSSProperties {
  return { ["--d" as string]: `${d}s`, ...(d2 !== undefined ? { ["--d2" as string]: `${d2}s` } : {}) } as CSSProperties;
}

/** Mirrors EntityIdPill for a session: blue tint, a speech glyph, the short id or title. */
export function SessionPill({ children, size = "sm" }: { children: ReactNode; size?: "sm" | "md" }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-[1px] font-mono align-baseline whitespace-nowrap ${size === "md" ? "text-[12px]" : "text-[10.5px]"}`}
      style={{ backgroundColor: "rgba(38,139,210,0.09)", color: SOL.blue, borderColor: "rgba(38,139,210,0.22)" }}
    >
      <svg className="h-2.5 w-2.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke={SOL.blue} strokeWidth={2.4}>
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
      {children}
    </span>
  );
}

/** Mirrors EntityIdPill for a task: yellow tint, a status ring, the title. */
export function TaskPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border px-1.5 py-[1px] text-[10.5px] font-mono whitespace-nowrap" style={{ backgroundColor: "rgba(181,137,0,0.1)", color: SOL.yellow, borderColor: "rgba(181,137,0,0.25)" }}>
      <svg className="h-2.5 w-2.5" viewBox="0 0 24 24" fill="none" stroke={SOL.yellow} strokeWidth={2.5}><circle cx="12" cy="12" r="9" /></svg>
      {children}
    </span>
  );
}

/** A person's GitHub face: a filled circle with an initial. */
export function Face({ name, color, size = 20 }: { name: string; color: string; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.45, backgroundColor: color }} title={name}>
      {name[0].toUpperCase()}
    </span>
  );
}

export const PEOPLE = {
  lena: SOL.violet,
  omar: SOL.orange,
};

/** The pull request glyph (lucide GitPullRequest), as the PR page draws it. */
export function PrIcon({ color = SOL.green, className = "h-4 w-4" }: { color?: string; className?: string }) {
  return (
    <svg className={`${className} shrink-0`} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M13 6h3a2 2 0 0 1 2 2v7" /><line x1="6" y1="9" x2="6" y2="21" />
    </svg>
  );
}

/** The shepherd glyph (lucide Radio). */
export function RadioIcon({ color, className = "h-3 w-3" }: { color: string; className?: string }) {
  return (
    <svg className={`${className} shrink-0`} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round">
      <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" /><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" /><circle cx="12" cy="12" r="2" /><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" /><path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
    </svg>
  );
}

/** A light framed surface for product mocks. */
export function Frame({ children, className = "", style, label }: { children: ReactNode; className?: string; style?: CSSProperties; label?: string }) {
  return (
    <div
      className={`rounded-xl overflow-hidden font-mono text-left ${className}`}
      style={{ backgroundColor: PAPER, border: `1px solid ${SOL.base2}`, boxShadow: "0 18px 40px -28px rgba(0,43,54,0.45)", ...style }}
      role={label ? "img" : undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}

/** A browser chrome around a mock: dots and a URL. */
export function Browser({ url, children, className = "" }: { url: string; children: ReactNode; className?: string }) {
  return (
    <Frame className={className}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ backgroundColor: SOL.base2 + "aa", borderBottom: `1px solid ${SOL.base2}` }}>
        <span className="flex gap-1">
          {[SOL.red, SOL.yellow, SOL.green].map((c) => <span key={c} className="h-2 w-2 rounded-full opacity-70" style={{ backgroundColor: c }} />)}
        </span>
        <span className="ml-1 min-w-0 flex-1 truncate rounded px-2 py-[2px] text-[10.5px]" style={{ backgroundColor: PAPER, color: SOL.base00 }}>{url}</span>
      </div>
      {children}
    </Frame>
  );
}

/**
 * A section opens like an added line in a diff: a gutter with its number and
 * a plus, then the heading on a green band. The page's one recurring motif.
 */
export function Section({ id, n, title, lede, children, tone = "light", wide = false }: {
  id: string;
  n: number;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  tone?: "light" | "paper";
  wide?: boolean;
}) {
  return (
    <section id={id} className="scroll-mt-20" style={{ backgroundColor: tone === "paper" ? "rgba(238,232,213,0.5)" : undefined }}>
      <div className={`${wide ? "max-w-7xl" : "max-w-6xl"} mx-auto px-5 sm:px-8 py-16 sm:py-24`}>
        <h2 className="flex items-stretch font-mono rounded-md overflow-hidden mb-6" style={{ backgroundColor: "rgba(133,153,0,0.09)" }}>
          <span className="flex shrink-0 items-start gap-2 px-2.5 sm:px-3 pt-[0.55em] text-[12px] sm:text-[13px] tabular-nums select-none" style={{ backgroundColor: "rgba(133,153,0,0.14)", color: "rgba(88,110,117,0.7)" }} aria-hidden>
            <span className="w-4 text-right">{n}</span>
            <span style={{ color: SOL.green }}>+</span>
          </span>
          <span className="px-3 sm:px-4 py-2 text-[23px] sm:text-[30px] font-bold leading-[1.2] tracking-tight" style={{ color: SOL.base03 }}>{title}</span>
        </h2>
        {lede && <div className="max-w-3xl text-[16.5px] leading-[1.7] space-y-3 mb-10" style={{ color: SOL.base01 }}>{lede}</div>}
        {children}
      </div>
    </section>
  );
}

/** A dark Solarized terminal: a title bar, then lines. Lines scroll sideways rather than wrap. */
export function Term({ title, children, className = "", minH, wrap = false }: { title: string; children: ReactNode; className?: string; minH?: number; wrap?: boolean }) {
  return (
    <div className={`rounded-xl overflow-hidden border text-left ${className}`} style={{ backgroundColor: SOL.base03, borderColor: "#094959", boxShadow: "0 18px 40px -26px rgba(0,43,54,0.6)" }}>
      <div className="flex items-center gap-2 px-4 py-2" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
        <span className="flex gap-1.5">
          {[SOL.red, SOL.yellow, SOL.green].map((c) => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c }} />)}
        </span>
        <span className="ml-2 truncate font-mono text-[11px]" style={{ color: SOL.base01 }}>{title}</span>
      </div>
      <div className="overflow-x-auto">
        <pre className={`p-4 font-mono text-[11.5px] sm:text-[12px] leading-[1.75]${wrap ? " whitespace-pre-wrap break-words" : ""}`} style={{ color: SOL.base0, minHeight: minH }}>{children}</pre>
      </div>
    </div>
  );
}

/** A prompt line inside <Term>. */
export function Prompt({ children }: { children: ReactNode }) {
  return (
    <span>
      <span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base2 }}>{children}</span>
      {"\n"}
    </span>
  );
}

/** Colored spans for terminal output. */
export const T = {
  cyan: (s: ReactNode) => <span style={{ color: SOL.cyan }}>{s}</span>,
  green: (s: ReactNode) => <span style={{ color: SOL.green }}>{s}</span>,
  red: (s: ReactNode) => <span style={{ color: SOL.red }}>{s}</span>,
  yellow: (s: ReactNode) => <span style={{ color: SOL.yellow }}>{s}</span>,
  blue: (s: ReactNode) => <span style={{ color: SOL.blue }}>{s}</span>,
  magenta: (s: ReactNode) => <span style={{ color: SOL.magenta }}>{s}</span>,
  dim: (s: ReactNode) => <span style={{ color: SOL.base01 }}>{s}</span>,
  bright: (s: ReactNode) => <span style={{ color: SOL.base2 }}>{s}</span>,
  label: (s: ReactNode) => <span style={{ color: SOL.base1, fontWeight: 600 }}>{s}</span>,
};

export { C };
