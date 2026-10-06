"use client";

import type { ReactNode } from "react";
import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for "share a session": which of the three needs each tool covers,
 * and what each one shows across the life of one session.
 */

// ─── Three needs, four tools ───────────────────────────────────────────────

const TOOLS = ["Claude Code sharing", "Lore", "Remote Control", "codecast"];
const NEEDS: { need: string; cells: (string | null)[] }[] = [
  { need: "Read a finished conversation", cells: ["cloud sessions only", "a link per thread", null, "every session, by link too"] },
  { need: "Watch a session while it runs", cells: [null, null, "one session, from your phone", "every session, live"] },
  { need: "Every session visible by default", cells: [null, null, null, "per directory, no step to share"] },
];

/** Which tool answers which need. A blank cell is a need the tool does not cover. */
export function ShareNeedsFigure() {
  return (
    <Stage minWidth={640}>
      <div className="p-4 sm:p-5 font-mono">
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "1.25fr repeat(4, 1fr)" }}>
          <div />
          {TOOLS.map((tool, i) => (
            <div key={tool} className="text-[11px] font-bold px-2 pb-1 bj-fade" style={{ ...t(0.1 + i * 0.08), color: i === 3 ? SOL.cyan : SOL.base02 }}>{tool}</div>
          ))}
          {NEEDS.map((row, r) => (
            <div key={row.need} className="contents">
              <div className="text-[12px] px-2 py-2 self-center bj-rise" style={{ ...t(0.4 + r * 0.5), color: SOL.base02 }}>{row.need}</div>
              {row.cells.map((cell, c) => (
                <div
                  key={c}
                  className={`rounded-md px-2 py-2 text-[10.5px] leading-snug ${cell ? "bj-pop" : "bj-fade"}`}
                  style={{
                    ...t(0.6 + r * 0.5 + c * 0.1),
                    backgroundColor: cell ? (c === 3 ? `${SOL.cyan}1a` : `${SOL.green}14`) : "transparent",
                    border: `1px ${cell ? "solid" : "dashed"} ${cell ? (c === 3 ? `${SOL.cyan}66` : `${SOL.green}55`) : SOL.base2}`,
                    color: cell ? SOL.base01 : SOL.base1,
                  }}
                >
                  {cell ? (
                    <>
                      <span className="font-bold mr-1" style={{ color: c === 3 ? SOL.cyan : SOL.green }}>✓</span>
                      {cell}
                    </>
                  ) : (
                    "no"
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Stage>
  );
}

// ─── One session's life, seen through each tool ────────────────────────────

/** A session runs from START to END; each lane shows when, and what, a reader can see of it. */
export function SessionLifeFigure() {
  const X0 = 170;
  const W = 560;
  const START = 0.08;
  const END = 0.62;
  const x = (f: number) => X0 + f * W;
  const SWEEP = 3.6;
  const at = (f: number) => 0.2 + SWEEP * f;
  const lanes: { name: string; sub: string; ink: Ink; draw: (y: number) => ReactNode }[] = [
    {
      name: "Claude Code link",
      sub: "cloud sessions",
      ink: "orange",
      draw: (y) => (
        <>
          <circle cx={x(0.3)} cy={y + 9} r={5} fill={SOL.orange} className="bj-pop" style={t(at(0.3))} />
          <Label x={x(0.3) - 6} y={y + 30} lines={["opened: the latest state, no live updates"]} ink="orange" size={10} className="bj-fade" style={t(at(0.3) + 0.1)} />
          <circle cx={x(0.88)} cy={y + 9} r={5} fill={SOL.orange} className="bj-pop" style={t(at(0.88))} />
          <Label x={x(0.88) + 6} y={y + 30} anchor="end" lines={["opened again"]} ink="orange" size={10} className="bj-fade" style={t(at(0.88) + 0.1)} />
        </>
      ),
    },
    {
      name: "Remote Control",
      sub: "claude --rc",
      ink: "violet",
      draw: (y) => (
        <>
          <rect x={x(START)} y={y + 3} width={(END - START) * W} height={12} rx={3} fill={`${SOL.violet}55`} className="bj-grow" style={t(at(START), SWEEP * (END - START))} />
          <Label x={x(END) + 10} y={y + 13} lines={["gone when the session ends"]} ink="violet" size={10} className="bj-fade" style={t(at(END))} />
        </>
      ),
    },
    {
      name: "codecast",
      sub: "daemon sync",
      ink: "cyan",
      draw: (y) => (
        <>
          <rect x={x(START)} y={y + 3} width={(END - START) * W} height={12} rx={3} fill={`${SOL.cyan}88`} className="bj-grow" style={t(at(START), SWEEP * (END - START))} />
          <rect x={x(END)} y={y + 3} width={(1 - END) * W} height={12} rx={3} fill={`${SOL.cyan}2a`} stroke={SOL.cyan} strokeOpacity={0.4} className="bj-grow" style={t(at(END), SWEEP * (1 - END))} />
          <Label x={x(START) + 8} y={y + 32} lines={["live, for the team"]} ink="cyan" size={10} className="bj-fade" style={t(at(0.2))} />
          <Label x={X0 + W} y={y + 32} anchor="end" lines={["kept: search, ask, blame"]} ink="cyan" size={10} className="bj-fade" style={t(at(0.75))} />
        </>
      ),
    },
  ];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={246} label="A shared link shows the latest state when opened, Remote Control is live only while the session runs, codecast streams it live and keeps it afterwards">
        {() => (
          <>
            <text x={16} y={30} fontSize="11" fontWeight={700} fill={SOL.base02}>the session</text>
            <rect x={x(START)} y={20} width={(END - START) * W} height={16} rx={4} fill={SOL.base02} className="bj-grow" style={t(at(START), SWEEP * (END - START))} />
            <text x={x(START) + 8} y={32} fontSize="10" fill={SOL.base3} className="bj-fade" style={t(at(START) + 0.3)}>running</text>
            <text x={x(END) + 8} y={32} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(at(END))}>finished</text>
            {lanes.map((l, i) => {
              const y = 66 + i * 52;
              return (
                <g key={l.name}>
                  <text x={16} y={y + 10} fontSize="11" fontWeight={700} fill={SOL[l.ink]}>{l.name}</text>
                  <text x={16} y={y + 24} fontSize="9.5" fill={SOL.base1}>{l.sub}</text>
                  <line x1={X0} x2={X0 + W} y1={y + 9} y2={y + 9} stroke={SOL.base2} />
                  {l.draw(y)}
                </g>
              );
            })}
            <line x1={X0} x2={X0} y1={16} y2={226} stroke={SOL.base02} strokeWidth={1.2} className="bj-sweep" style={t(0.2, SWEEP, { "--to": `${W}px` })} />
            <text x={X0} y={238} fontSize="9.5" fill={SOL.base1}>time</text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
