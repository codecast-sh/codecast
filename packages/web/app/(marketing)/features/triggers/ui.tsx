"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, Whole } from "../kit";

export const ACCENT = SOL.orange;

/** One page section: a mono heading, a lede, and the section's own body. */
export function Section({ id, title, lede, children, tint = false }: { id?: string; title: ReactNode; lede?: ReactNode; children: ReactNode; tint?: boolean }) {
  return (
    <section id={id} className="py-16 sm:py-24" style={tint ? { backgroundColor: SOL.base2 } : undefined}>
      <div className="max-w-6xl mx-auto px-5 sm:px-6">
        <h2 className="max-w-3xl text-[28px] sm:text-4xl font-bold font-mono tracking-tight leading-[1.15]" style={{ color: SOL.base03 }}>{title}</h2>
        {lede && <p className="mt-4 max-w-2xl text-[17px] leading-8" style={{ color: SOL.base00 }}>{lede}</p>}
        <div className="mt-10">{children}</div>
      </div>
    </section>
  );
}

/** Inline code in body copy. */
/** Body paragraph sized for side columns. */
export function Body({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-[15.5px] leading-7 ${className}`} style={{ color: SOL.base01 }}>{children}</p>;
}

/** A small dark command block: `$ command` lines plus optional muted output. */
export function Shell({ lines, out, className = "" }: { lines: string[]; out?: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl font-mono text-[12px] leading-relaxed px-4 py-3 ${className}`} style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
      <pre className="whitespace-pre-wrap break-words">
        {lines.map((l) => (
          <span key={l}><span style={{ color: SOL.green }}>$</span> <Whole text={l} />{"\n"}</span>
        ))}
        {out}
      </pre>
    </div>
  );
}

/** "+ Trigger tr-41 in 30m: Title", the line `cast trigger add` prints. */
export function Added({ id, when, title }: { id: string; when: string; title: string }) {
  return (
    <span>
      <span style={{ color: SOL.green }}>+</span> Trigger <span style={{ color: SOL.cyan }}>{id}</span> {when}: <span className="font-semibold" style={{ color: SOL.base2 }}>{title}</span>{"\n"}
    </span>
  );
}

export { C };
