"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";

/**
 * Figures for "share a session": which of the three needs each tool covers.
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
