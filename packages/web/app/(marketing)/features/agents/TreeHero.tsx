"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { AGENT_COLOR, AgentTag } from "./parts";

/**
 * The hero: one conversation drawn as the tree it becomes. The trunk is the
 * thread you steer. A fork leaves it as a solid line in the same color (it
 * carries the history); a worker leaves as a dashed line in its backend's
 * color (it starts fresh); settled workers return as one message; a switch
 * recolors the trunk in place. Every row is a faithful command or message.
 */

const LANE_W = 22;
const NODE_Y = 22;
const BRANCH_Y = 46;
const LANES = 4;
const x = (lane: number) => 11 + lane * LANE_W;

const BLUE = AGENT_COLOR.claude;
const CODEX = AGENT_COLOR.codex;
const GEMINI = AGENT_COLOR.gemini;

type Line = { lane: number; from: "top" | "node" | "branch"; to: "bottom" | "node"; color: string; dashed?: boolean; fade?: boolean };
type Curve = { lane: number; dir: "out" | "in"; color: string; dashed?: boolean };
type Node = { lane: number; color: string; kind?: "dot" | "ring" | "diamond" | "msg" };
type Row = { lines: Line[]; curves?: Curve[]; node: Node; content: ReactNode; doneAt?: number };

function yOf(p: Line["from"] | Line["to"]): string | number {
  return p === "top" ? 0 : p === "node" ? NODE_Y : p === "branch" ? BRANCH_Y : "100%";
}

function RowRail({ row, i }: { row: Row; i: number }) {
  const { lines, curves = [], node } = row;
  return (
    <svg className="absolute left-0 top-0 h-full overflow-visible" width={LANES * LANE_W} aria-hidden>
      <defs>
        <linearGradient id={`agx-fade-${i}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={SOL.blue} stopOpacity={1} />
          <stop offset="1" stopColor={SOL.blue} stopOpacity={0} />
        </linearGradient>
      </defs>
      {lines.map((l, k) => (
        <line key={k} className="agx-rail-line" style={{ ["--i" as string]: i }}
          x1={x(l.lane)} x2={x(l.lane)} y1={yOf(l.from)} y2={yOf(l.to)}
          stroke={l.fade ? `url(#agx-fade-${i})` : l.color} strokeWidth={2.2} strokeLinecap="round"
          strokeDasharray={l.dashed ? "4 5" : undefined} opacity={l.fade ? 0.7 : 1} />
      ))}
      {curves.map((c, k) => {
        const x0 = x(0), xk = x(c.lane);
        const d = c.dir === "out"
          ? `M${x0} ${NODE_Y} C${x0} ${NODE_Y + 16}, ${xk} ${BRANCH_Y - 16}, ${xk} ${BRANCH_Y}`
          : `M${xk} 0 C${xk} ${NODE_Y - 4}, ${x0 + 6} ${NODE_Y - 10}, ${x0} ${NODE_Y}`;
        return <path key={k} className="agx-rail-line" style={{ ["--i" as string]: i }} d={d} fill="none" stroke={c.color} strokeWidth={2.2} strokeLinecap="round" strokeDasharray={c.dashed ? "4 5" : undefined} />;
      })}
      {node.kind === "diamond" ? (
        <rect x={x(node.lane) - 5.5} y={NODE_Y - 5.5} width={11} height={11} rx={2} transform={`rotate(45 ${x(node.lane)} ${NODE_Y})`} fill={SOL.base3} stroke={node.color} strokeWidth={2.2} />
      ) : node.kind === "ring" ? (
        <circle cx={x(node.lane)} cy={NODE_Y} r={5.5} fill={SOL.base3} stroke={node.color} strokeWidth={2.2} />
      ) : node.kind === "msg" ? (
        <>
          <circle className="agx-node-ping" cx={x(node.lane)} cy={NODE_Y} r={6} fill="none" stroke={SOL.cyan} strokeWidth={1.5} />
          <circle cx={x(node.lane)} cy={NODE_Y} r={6} fill={SOL.cyan} stroke={SOL.base3} strokeWidth={2} />
        </>
      ) : (
        <circle cx={x(node.lane)} cy={NODE_Y} r={5} fill={node.color} stroke={SOL.base3} strokeWidth={2} />
      )}
    </svg>
  );
}

function Who({ who, children }: { who: string; children: ReactNode }) {
  const human = who === "you";
  return (
    <div className="text-[13px] leading-[1.55]" style={{ color: SOL.base01 }}>
      <span className="mr-2 font-mono text-[11px] font-semibold" style={{ color: human ? SOL.orange : AGENT_COLOR[who] }}>{who}</span>
      {children}
    </div>
  );
}

function CmdLine({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div>
      <div className="agx-card inline-block max-w-full rounded-md px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.5] [overflow-wrap:anywhere]" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
        <span style={{ color: SOL.green }}>$ </span>{children}
      </div>
      {note && <div className="mt-1 text-[11.5px] leading-[1.5]" style={{ color: SOL.base1 }}>{note}</div>}
    </div>
  );
}

function WorkerCard({ agent, title, doneAt, result }: { agent: string; title: string; doneAt: number; result: string }) {
  const c = AGENT_COLOR[agent];
  return (
    <div className="agx-card rounded-lg px-3 py-2" style={{ backgroundColor: "#fffdf6", border: `1px dashed ${c}88` }}>
      <div className="flex flex-wrap items-center gap-2">
        <AgentTag agent={agent} size="xs" />
        <span className="font-mono text-[12px] font-medium" style={{ color: SOL.base02 }}>{title}</span>
        <span className="agx-chips ml-auto" style={{ ["--done" as string]: doneAt }}>
          <span className="agx-chip-working inline-flex items-center gap-1 font-mono text-[10px]" style={{ color: SOL.yellow }}>
            <span className="agx-pulse h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.yellow }} />working
          </span>
          <span className="agx-chip-done inline-flex items-center gap-1 font-mono text-[10px]" style={{ color: SOL.green }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />done
          </span>
        </span>
      </div>
      <div className="mt-1 text-[12px] leading-[1.5]" style={{ color: SOL.base00 }}>{result}</div>
    </div>
  );
}

const ROWS: Row[] = [
  {
    node: { lane: 0, color: SOL.orange },
    lines: [{ lane: 0, from: "node", to: "bottom", color: BLUE }],
    content: <Who who="you">Webhook retries pile up under load. Find out why and fix it.</Who>,
  },
  {
    node: { lane: 0, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }],
    content: <Who who="claude">Two suspects: the backoff never grows, and retries share the request worker. Worth trying both.</Who>,
  },
  {
    node: { lane: 0, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "branch", to: "bottom", color: BLUE }],
    curves: [{ lane: 1, dir: "out", color: BLUE }],
    content: <CmdLine note={<>This thread takes the backoff. A branch with the whole history takes the queue.</>}>cast fork &quot;fix the backoff&quot; &quot;move retries to a queue&quot;</CmdLine>,
  },
  {
    node: { lane: 0, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE }, { lane: 2, from: "branch", to: "bottom", color: CODEX, dashed: true }],
    curves: [{ lane: 2, dir: "out", color: CODEX, dashed: true }],
    content: <CmdLine>cast spawn --subagent --agent codex -- &quot;write a load test that reproduces the pileup&quot;</CmdLine>,
  },
  {
    node: { lane: 0, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE }, { lane: 2, from: "top", to: "bottom", color: CODEX, dashed: true }, { lane: 3, from: "branch", to: "bottom", color: GEMINI, dashed: true }],
    curves: [{ lane: 3, dir: "out", color: GEMINI, dashed: true }],
    content: <CmdLine>cast spawn --subagent --agent gemini -- &quot;audit every caller of enqueue()&quot;</CmdLine>,
  },
  {
    node: { lane: 2, color: CODEX, kind: "ring" },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE }, { lane: 2, from: "top", to: "bottom", color: CODEX, dashed: true }, { lane: 3, from: "top", to: "bottom", color: GEMINI, dashed: true }],
    content: <WorkerCard agent="codex" title="Load test" doneAt={3300} result="Reproduces it: 400 retries queue behind 12 workers." />,
  },
  {
    node: { lane: 3, color: GEMINI, kind: "ring" },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE }, { lane: 2, from: "top", to: "bottom", color: CODEX, dashed: true }, { lane: 3, from: "top", to: "bottom", color: GEMINI, dashed: true }],
    content: <WorkerCard agent="gemini" title="enqueue() audit" doneAt={3700} result="Three callers retry on their own. Listed with file and line." />,
  },
  {
    node: { lane: 1, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE }, { lane: 2, from: "top", to: "bottom", color: CODEX, dashed: true }, { lane: 3, from: "top", to: "bottom", color: GEMINI, dashed: true }],
    content: (
      <div className="agx-card rounded-lg px-3 py-2" style={{ backgroundColor: "#fffdf6", border: `1px solid ${BLUE}55` }}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[11px] font-semibold" style={{ color: BLUE }}>branch</span>
          <span className="font-mono text-[12px] font-medium" style={{ color: SOL.base02 }}>move retries to a queue</span>
          <span className="ml-auto font-mono text-[10px]" style={{ color: SOL.base1 }}>its own inbox card</span>
        </div>
        <div className="mt-1 text-[12px]" style={{ color: SOL.base00 }}>Prototype works. Needs a schema change, so it waits for you.</div>
      </div>
    ),
  },
  {
    node: { lane: 0, color: SOL.cyan, kind: "msg" },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }, { lane: 1, from: "top", to: "bottom", color: BLUE, fade: true }, { lane: 2, from: "top", to: "node", color: CODEX, dashed: true }, { lane: 3, from: "top", to: "node", color: GEMINI, dashed: true }],
    curves: [{ lane: 2, dir: "in", color: CODEX, dashed: true }, { lane: 3, dir: "in", color: GEMINI, dashed: true }],
    content: (
      <div className="agx-card rounded-md px-3 py-1.5" style={{ borderLeft: `2px solid ${SOL.cyan}`, backgroundColor: "rgba(42,161,152,0.07)" }}>
        <div className="font-mono text-[11.5px] font-semibold" style={{ color: SOL.cyan }}>2 workers settled</div>
        <div className="text-[12px]" style={{ color: SOL.base01 }}>Read the result with <span className="font-mono">cast read &lt;id&gt;</span> and act on it.</div>
      </div>
    ),
  },
  {
    node: { lane: 0, color: BLUE },
    lines: [{ lane: 0, from: "top", to: "bottom", color: BLUE }],
    content: <Who who="claude">Backoff now doubles up to 60s and the three callers go through it. Load test passes.</Who>,
  },
  {
    node: { lane: 0, color: CODEX, kind: "diamond" },
    lines: [{ lane: 0, from: "top", to: "node", color: BLUE }, { lane: 0, from: "node", to: "bottom", color: CODEX }],
    content: (
      <div>
        <CmdLine>cast switch --agent codex</CmdLine>
        <div className="mt-2 flex items-center gap-2 font-mono text-[10.5px]" style={{ color: SOL.base1 }}>
          <span className="h-px flex-1" style={{ backgroundColor: SOL.base2 }} />
          now using Codex
          <span className="h-px flex-1" style={{ backgroundColor: SOL.base2 }} />
        </div>
      </div>
    ),
  },
  {
    node: { lane: 0, color: CODEX },
    lines: [{ lane: 0, from: "top", to: "node", color: CODEX }],
    content: <Who who="codex">Read the whole thread. Reviewed the diff against the load test and fixed two edge cases.</Who>,
  },
];

export function TreeHero() {
  return (
    <div className="relative rounded-2xl overflow-hidden" style={{ backgroundColor: "#fbf4df", border: `1px solid ${SOL.base2}`, boxShadow: "0 30px 60px -36px rgba(0,43,54,0.45)" }} role="img" aria-label="One conversation fanning out: a fork that carries the history, two workers on Codex and Gemini that report back, and a switch that continues the same thread on Codex">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5" style={{ borderBottom: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
        <span className="font-mono text-[12px] font-semibold" style={{ color: SOL.base02 }}>Webhook retries</span>
        <AgentTag agent="claude" size="xs" />
        <span className="ml-auto flex items-center gap-3 font-mono text-[10px]" style={{ color: SOL.base1 }}>
          <span className="flex items-center gap-1.5"><svg width="18" height="4" aria-hidden><line x1="1" x2="17" y1="2" y2="2" stroke={SOL.base00} strokeWidth="2" strokeLinecap="round" /></svg>carries history</span>
          <span className="flex items-center gap-1.5"><svg width="18" height="4" aria-hidden><line x1="1" x2="17" y1="2" y2="2" stroke={SOL.base00} strokeWidth="2" strokeDasharray="3 4" strokeLinecap="round" /></svg>starts fresh</span>
        </span>
      </div>
      <div className="agx-grid-bg px-3 sm:px-5 pt-4 pb-5">
        {ROWS.map((row, i) => (
          <div key={i} className="agx-tree-row relative" style={{ minHeight: 52 }}>
            <RowRail row={row} i={i} />
            <div className="agx-row relative pb-3.5" style={{ ["--i" as string]: i, paddingLeft: LANES * LANE_W + 6, paddingTop: 12 }}>
              {row.content}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
