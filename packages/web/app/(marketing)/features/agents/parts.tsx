"use client";

import { type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { C, Whole } from "../kit";

/** One color per backend, extending the landing mocks' agent palette. */
export const AGENT_COLOR: Record<string, string> = {
  claude: SOL.blue,
  codex: SOL.green,
  cursor: SOL.yellow,
  gemini: SOL.magenta,
  grok: SOL.orange,
  opencode: SOL.violet,
  pi: SOL.cyan,
  muse: SOL.red,
};

export const ACCENT = SOL.green;

export function AgentTag({ agent, size = "sm" }: { agent: string; size?: "sm" | "xs" }) {
  const c = AGENT_COLOR[agent] ?? SOL.base00;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full font-mono font-medium ${size === "xs" ? "px-1.5 text-[10px]" : "px-2 py-0.5 text-[11px]"}`}
      style={{ color: c, backgroundColor: `${c}18`, border: `1px solid ${c}33` }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: c }} />
      {agent}
    </span>
  );
}

/**
 * The shape each primitive leaves in a conversation tree, as a small glyph:
 * a worker hangs off you dashed (fresh history), a fork splits solid (carries
 * history), a switch keeps one line and changes its color, exec goes out and
 * comes straight back, a handoff ends one line and starts a linked one.
 */
export type Shape = "worker" | "spawn" | "fork" | "switch" | "exec" | "handoff" | "send" | "room" | "worktree";

export function ShapeGlyph({ shape, size = 40, color = ACCENT }: { shape: Shape; size?: number; color?: string }) {
  const s = size;
  const sw = 2.2;
  const common = { fill: "none", stroke: color, strokeWidth: sw, strokeLinecap: "round" as const };
  const dot = (cx: number, cy: number, r = 3.2, fill = color) => <circle cx={cx} cy={cy} r={r} fill={fill} />;
  let body: ReactNode = null;
  switch (shape) {
    case "worker":
      body = <>
        <path d="M12 6 V34" {...common} />
        <path d="M12 14 C12 22, 28 18, 28 26 V34" {...common} strokeDasharray="3 3.5" />
        {dot(12, 14)}{dot(28, 30, 3, SOL.base3)}<circle cx={28} cy={30} r={3} fill="none" stroke={color} strokeWidth={1.8} />
      </>;
      break;
    case "spawn":
      body = <>
        <path d="M12 6 V34" {...common} />
        <path d="M28 18 V34" {...common} strokeDasharray="3 3.5" />
        <path d="M16 14 L24 14" {...common} strokeWidth={1.4} strokeDasharray="1.5 2.5" />
        {dot(12, 14)}{dot(28, 18)}
      </>;
      break;
    case "fork":
      body = <>
        <path d="M12 6 V34" {...common} />
        <path d="M12 16 C12 24, 28 20, 28 28 V34" {...common} />
        <path d="M12 16 C12 22, 20 22, 20 28 V34" {...common} opacity={0.55} />
        {dot(12, 16)}
      </>;
      break;
    case "switch":
      body = <>
        <path d="M20 6 V20" fill="none" stroke={SOL.blue} strokeWidth={sw} strokeLinecap="round" />
        <path d="M20 20 V34" {...common} />
        <rect x={15.5} y={15.5} width={9} height={9} rx={1.5} transform="rotate(45 20 20)" fill={SOL.base3} stroke={color} strokeWidth={1.8} />
      </>;
      break;
    case "exec":
      body = <>
        <path d="M12 6 V34" {...common} />
        <path d="M12 14 C20 14, 30 14, 30 20 C30 26, 20 26, 12 26" {...common} strokeDasharray="3 3.5" />
        {dot(12, 14)}{dot(12, 26)}{dot(30, 20, 2.4)}
      </>;
      break;
    case "handoff":
      body = <>
        <path d="M12 6 V18" fill="none" stroke={SOL.blue} strokeWidth={sw} strokeLinecap="round" />
        <path d="M28 22 V34" {...common} />
        <path d="M14 20 L26 22" {...common} strokeWidth={1.4} strokeDasharray="1.5 2.5" />
        {dot(12, 19, 3.4, SOL.blue)}{dot(28, 22)}
      </>;
      break;
    case "send":
      body = <>
        <path d="M10 6 V34" {...common} />
        <path d="M30 6 V34" fill="none" stroke={SOL.cyan} strokeWidth={sw} strokeLinecap="round" />
        <path d="M10 14 L30 20" {...common} strokeWidth={1.6} />
        <path d="M30 26 L10 32" fill="none" stroke={SOL.cyan} strokeWidth={1.6} strokeLinecap="round" />
        {dot(10, 14)}{dot(30, 26, 3.2, SOL.cyan)}
      </>;
      break;
    case "room":
      body = <>
        <path d="M8 6 V34" {...common} />
        <path d="M20 6 V34" {...common} opacity={0.7} />
        <path d="M32 6 V34" {...common} opacity={0.45} />
        <path d="M4 20 H36" stroke={SOL.base1} strokeWidth={1} strokeDasharray="2 3" />
      </>;
      break;
    case "worktree":
      body = <>
        <path d="M20 4 V14" {...common} />
        <path d="M20 14 C20 20, 9 18, 9 24" {...common} />
        <path d="M20 14 V24" {...common} />
        <path d="M20 14 C20 20, 31 18, 31 24" {...common} />
        <rect x={5} y={25} width={8} height={9} rx={1.5} fill="none" stroke={color} strokeWidth={1.8} />
        <rect x={16} y={25} width={8} height={9} rx={1.5} fill="none" stroke={color} strokeWidth={1.8} />
        <rect x={27} y={25} width={8} height={9} rx={1.5} fill="none" stroke={color} strokeWidth={1.8} />
      </>;
      break;
  }
  return <svg width={s} height={s} viewBox="0 0 40 40" aria-hidden>{body}</svg>;
}

/** A section hanging off the page's trunk: a node on the rail carrying the primitive's glyph. */
export function RailSection({ id, shape, title, lede, children, color = ACCENT }: { id: string; shape: Shape; title: ReactNode; lede?: ReactNode; children: ReactNode; color?: string }) {
  return (
    <section id={id} className="relative pl-12 sm:pl-20 pt-16 sm:pt-24 scroll-mt-20">
      <div className="absolute left-0 top-16 sm:top-24 -translate-x-[3px] sm:translate-x-0">
        <div className="relative flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full" style={{ backgroundColor: SOL.base3, border: `2px solid ${color}`, boxShadow: `0 0 0 6px ${SOL.base3}` }}>
          <ShapeGlyph shape={shape} size={30} color={color} />
        </div>
      </div>
      <h2 className="font-mono text-[26px] sm:text-[34px] font-bold leading-[1.15] tracking-[-0.02em] max-w-3xl [text-wrap:balance]" style={{ color: SOL.base03 }}>
        {title}
      </h2>
      {lede && <p className="mt-4 max-w-2xl text-[16.5px] leading-[1.7]" style={{ color: SOL.base00 }}>{lede}</p>}
      <div className="mt-9">{children}</div>
    </section>
  );
}

/** A small titled note: what lands where, a fact worth pinning. */
export function Fact({ label, children, color = ACCENT }: { label: string; children: ReactNode; color?: string }) {
  return (
    <div className="pl-3.5" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="font-mono text-[12px] font-semibold mb-1" style={{ color }}>{label}</div>
      <div className="text-[14px] leading-[1.65]" style={{ color: SOL.base01 }}>{children}</div>
    </div>
  );
}

/** Dark terminal body for scripted captures, matching blogChrome's Terminal but without its outer margin. */
export function Term({ label, wrap = false, children }: { label: string; wrap?: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl overflow-hidden shadow-[0_18px_40px_-24px_rgba(0,43,54,0.55)]" style={{ backgroundColor: SOL.base03, border: "1px solid #094959" }}>
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOL.red }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOL.yellow }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: SOL.green }} />
        </div>
        <span className="ml-2 font-mono text-[11px]" style={{ color: SOL.base01 }}>{label}</span>
      </div>
      <div className="overflow-x-auto">
        <pre className={`p-4 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap${wrap ? "" : " sm:whitespace-pre"}`} style={{ color: SOL.base0 }}>{children}</pre>
      </div>
    </div>
  );
}

/** The CLI form of a section, demoted under the app story: a small label, then the terminal. */
export function ForScripts({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[11.5px] font-semibold uppercase tracking-wide" style={{ color: SOL.base1 }}>For scripts and agents</div>
      {note && <p className="mb-3 text-[13.5px] leading-[1.6]" style={{ color: SOL.base01 }}>{note}</p>}
      {children}
    </div>
  );
}

/** Pieces for building terminal captures. */
export const T = {
  cmd: (s: string) => <span><span style={{ color: SOL.green }}>$</span><span style={{ color: SOL.base2 }}> <Whole text={s} /></span>{"\n"}</span>,
  dim: (s: string) => <span style={{ color: SOL.base01 }}>{s}</span>,
  c: (s: string, color: string) => <span style={{ color }}>{s}</span>,
};

export { C };
