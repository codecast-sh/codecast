"use client";

import { type CSSProperties, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { CURSOR_ORANGE, type TermLine } from "./data";
import { C } from "../kit";

export { useStillMode } from "../kit";

/**
 * A section whose heading reads like a line of the tree cast computer prints:
 * a dim index and role, then the name. The page is the window, each section an
 * element in it.
 */
export function Section({ id, index, role, title, lede, children, tone = "light", wide = false }: {
  id: string;
  index: number;
  role: string;
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  tone?: "light" | "paper" | "dark";
  wide?: boolean;
}) {
  const bg = tone === "dark" ? SOL.base03 : tone === "paper" ? "#f6efda" : SOL.base3;
  const ink = tone === "dark" ? SOL.base2 : SOL.base03;
  const sub = tone === "dark" ? SOL.base1 : SOL.base00;
  return (
    <section id={id} className="cx-section relative scroll-mt-20" style={{ backgroundColor: bg }}>
      <div className={`${wide ? "max-w-7xl" : "max-w-6xl"} mx-auto px-5 sm:px-8 py-20 sm:py-28`}>
        <h2 className="font-mono font-bold tracking-[-0.03em] text-[28px] sm:text-[38px] leading-[1.1] max-w-4xl [text-wrap:balance]" style={{ color: ink }}>
          <span className="cx-treeidx inline-block mr-3 align-[0.42em] text-[0.46em] font-normal tracking-normal" style={{ color: tone === "dark" ? SOL.base01 : SOL.base1 }}>
            <span style={{ color: SOL.magenta }}>{index}</span> {role}
          </span>
          {title}
        </h2>
        {lede && <p className="mt-5 max-w-2xl text-[17px] leading-[1.7]" style={{ color: sub }}>{lede}</p>}
        <div className="mt-12">{children}</div>
      </div>
    </section>
  );
}

const LINE_COLOR: Record<TermLine["t"], string> = {
  cmd: SOL.base2,
  head: SOL.base1,
  out: SOL.base0,
  dim: SOL.base01,
  add: SOL.green,
  rem: SOL.red,
  ok: SOL.cyan,
  bad: SOL.yellow,
  ask: SOL.base2,
};

/** One printed line: commands get the green prompt; tabs become tree guides. */
export function TermLineView({ line, className = "", style }: { line: TermLine; className?: string; style?: CSSProperties }) {
  const depth = /^\t*/.exec(line.s)?.[0].length ?? 0;
  const text = line.s.slice(depth);
  return (
    <div className={`cx-tl ${className}`} style={{ color: LINE_COLOR[line.t], paddingLeft: `${depth * 1.6 + (line.t === "cmd" || line.t === "ask" ? 1.2 : 0)}ch`, textIndent: line.t === "cmd" || line.t === "ask" ? "-1.2ch" : undefined, ...(line.t === "ask" ? { marginBottom: "0.9em" } : null), ...style }}>
      {line.t === "cmd" && <span style={{ color: SOL.green }}>$ </span>}
      {line.t === "ask" && <span style={{ color: SOL.blue }}>&gt; </span>}
      {text}
    </div>
  );
}

/** The site's terminal card, with lines instead of a <pre>, so long output wraps with a hanging indent. */
export function Term({ label, children, className = "", bodyClassName = "" }: { label: string; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <div className={`rounded-xl border overflow-hidden shadow-[0_24px_60px_-28px_rgba(0,43,54,0.55)] ${className}`} style={{ backgroundColor: SOL.base03, borderColor: "#094959" }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
        <div className="flex gap-1.5" aria-hidden>
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.red }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.yellow }} />
          <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SOL.green }} />
        </div>
        <span className="text-[11px] font-mono ml-2 truncate" style={{ color: SOL.base01 }}>{label}</span>
      </div>
      <div className={`p-4 font-mono text-[12px] leading-[1.65] break-words ${bodyClassName}`}>{children}</div>
    </div>
  );
}

/**
 * The agent's own pointer, drawn the way AgentCursor.swift draws it: an orange
 * arrow with a white edge and a dark "agent" tag beside the tip.
 */
export function AgentCursorGlyph({ size = 1, tag = true }: { size?: number; tag?: boolean }) {
  return (
    <span className="relative inline-block" style={{ width: `${2.2 * size}em`, height: `${2.6 * size}em` }} aria-hidden>
      <svg viewBox="0 0 22 26" className="absolute inset-0 w-full h-full overflow-visible" style={{ filter: "drop-shadow(0 0.15em 0.25em rgba(0,0,0,0.35))" }}>
        <path d="M2 1.5 L2 21 L7 16.4 L10.4 24 L13.6 22.6 L10.3 15.2 L17 15.2 Z" fill={CURSOR_ORANGE} stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
      {tag && (
        <span className="cx-tag absolute font-sans font-semibold whitespace-nowrap rounded-[0.35em] px-[0.45em] py-[0.1em]" style={{ left: `${1.7 * size}em`, top: `${1.85 * size}em`, fontSize: `${0.95 * size}em`, color: "#fff", backgroundColor: "rgba(33,33,41,0.92)" }}>
          agent
        </span>
      )}
    </span>
  );
}

/** The plain black pointer the human is holding. */
export function HumanCursorGlyph() {
  return (
    <svg viewBox="0 0 22 26" className="w-[1.9em] h-[2.25em] overflow-visible" aria-hidden style={{ filter: "drop-shadow(0 0.1em 0.15em rgba(0,0,0,0.3))" }}>
      <path d="M2 1.5 L2 21 L7 16.4 L10.4 24 L13.6 22.6 L10.3 15.2 L17 15.2 Z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/** macOS traffic lights; an inactive window's are grey, as on a real Mac. */
export function Lights({ active }: { active: boolean }) {
  const c = active ? ["#ff5f57", "#febc2e", "#28c840"] : ["#d6d1c4", "#d6d1c4", "#d6d1c4"];
  return (
    <span className="flex gap-[0.55em]" aria-hidden>
      {c.map((col, i) => <span key={i} className="block w-[1.15em] h-[1.15em] rounded-full" style={{ backgroundColor: col, boxShadow: "inset 0 0 0 0.06em rgba(0,0,0,0.12)" }} />)}
    </span>
  );
}

export { C };
