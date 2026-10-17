"use client";

import { Fragment, type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, V } from "./theme";

/**
 * A page section: a heading and lede, an optional margin note on wide screens,
 * then the section's figure.
 */
export function Section({ id, title, lede, children, tone = "paper", aside, dark = false }: {
  id: string; title: ReactNode; lede: ReactNode; children: ReactNode; tone?: "paper" | "sand" | "grid"; aside?: ReactNode; dark?: boolean;
}) {
  const bg = dark ? SOL.base03 : tone === "sand" ? SOL.base2 : SOL.base3;
  return (
    <section id={id} className={`scroll-mt-20 ${tone === "grid" ? "md-grid-bg" : ""}`} style={{ backgroundColor: bg }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_280px] gap-x-14 gap-y-5 items-end">
          <div className="min-w-0">
            <h2 className="font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em] max-w-3xl [text-wrap:balance]" style={{ color: dark ? SOL.base3 : SOL.base03 }}>
              {title}
            </h2>
            <div className="mt-4 text-[17px] leading-8 max-w-2xl space-y-4" style={{ color: dark ? SOL.base1 : SOL.base01 }}>{lede}</div>
          </div>
          {aside && (
            <div className="text-[14px] leading-6 pl-4 border-l-2" style={{ color: dark ? SOL.base1 : SOL.base00, borderColor: V }}>{aside}</div>
          )}
        </div>
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

/** Inline code in prose, tinted violet. */
export function C({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  const short = typeof children === "string" && children.length <= 26;
  return (
    <code
      className={`font-mono text-[0.86em] px-1.5 py-0.5 rounded ${short ? "whitespace-nowrap" : "[overflow-wrap:anywhere]"}`}
      style={{ backgroundColor: dark ? SOL.base02 : "rgba(108,113,196,.12)", color: dark ? SOL.base2 : SOL.base02 }}
    >
      {children}
    </code>
  );
}

/** A small mono label above a figure. */
export function Label({ children, color = DIM }: { children: ReactNode; color?: string }) {
  return <div className="font-mono text-[12px] mb-3" style={{ color }}>{children}</div>;
}

/** The app's window chrome around a mock: a title strip, then the body on the card surface. */
export function AppFrame({ title, right, children, className = "", style }: { title: ReactNode; right?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`rounded-xl border ${className}`} style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 24px 60px -34px rgba(0,43,54,.45)", ...style }}>
      <div className="h-9 px-3.5 rounded-t-xl flex items-center gap-2 border-b text-[11.5px] font-mono" style={{ borderColor: LINE, color: DIM, backgroundColor: "rgba(238,232,213,.45)" }}>
        <span className="flex gap-1.5 mr-1.5">
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgba(147,161,161,.45)" }} />
        </span>
        <span className="truncate">{title}</span>
        {right && <span className="ml-auto shrink-0">{right}</span>}
      </div>
      {children}
    </div>
  );
}

/* ── Code ────────────────────────────────────────────────────────────────── */

const KEYWORDS = new Set(["on", "async", "await", "return", "const", "export", "import", "from", "true", "false", "null"]);

/** A tiny highlighter for the page's TSX and JSON snippets, in Solarized dark. */
function Highlight({ line }: { line: string }) {
  if (/^\s*(\/\/|#)/.test(line)) return <span style={{ color: SOL.base01 }}>{line}</span>;
  const parts = line.match(/"[^"]*"|'[^']*'|`[^`]*`|<\/?[A-Z][A-Za-z]*|\b\d+(?:\.\d+)?\b|\b[a-z][A-Za-z]*\b|[^"'`<\w]+|./g) ?? [line];
  return (
    <>
      {parts.map((p, i) => {
        let color: string | undefined;
        if (/^["'`]/.test(p)) color = SOL.cyan;
        else if (/^<\/?[A-Z]/.test(p)) color = SOL.blue;
        else if (/^\d/.test(p)) color = SOL.magenta;
        else if (KEYWORDS.has(p)) color = SOL.green;
        else if (p.startsWith("$")) color = SOL.yellow;
        return <Fragment key={i}>{color ? <span style={{ color }}>{p}</span> : p}</Fragment>;
      })}
    </>
  );
}

/** A dark code panel with a file name strip. `mark` lines get a violet gutter. */
export function Code({ file, code, mark = [], className = "", size = 12.5 }: { file: string; code: string; mark?: number[]; className?: string; size?: number }) {
  const lines = code.replace(/\n$/, "").split("\n");
  return (
    <div className={`rounded-xl overflow-hidden border ${className}`} style={{ backgroundColor: SOL.base03, borderColor: "#0b4a5a", boxShadow: "0 24px 60px -32px rgba(0,0,0,.55)" }}>
      <div className="h-9 px-4 flex items-center border-b font-mono text-[11.5px]" style={{ borderColor: "#0b4a5a", color: SOL.base01, backgroundColor: SOL.base02 }}>
        {file}
      </div>
      <pre className="py-3.5 overflow-x-auto font-mono leading-[1.7]" style={{ fontSize: size, color: SOL.base0 }}>
        {lines.map((l, i) => (
          <div key={i} className="px-4 border-l-2" style={{ borderColor: mark.includes(i + 1) ? V : "transparent", backgroundColor: mark.includes(i + 1) ? "rgba(108,113,196,.12)" : undefined }}>
            <Highlight line={l || " "} />
          </div>
        ))}
      </pre>
    </div>
  );
}
