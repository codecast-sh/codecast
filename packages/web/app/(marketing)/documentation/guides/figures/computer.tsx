"use client";

import type { ReactNode } from "react";
import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Sheet, Term } from "../figureParts";

/**
 * Figures for the computer guide: the read, act, read loop with an index that
 * goes stale, the exit code against the verdict, and which input reaches a
 * window that is not in front.
 */

// ─── Read, act, read ───────────────────────────────────────────────────────

const Shell = ({ children }: { children: ReactNode }) => (
  <Term size={11} leading={1.75} space="mx-4 mb-4 mt-3 p-3">{children}</Term>
);

const Line = ({ at, color, children }: { at: number; color?: string; children: ReactNode }) => (
  <div className="bj-rise whitespace-pre" style={{ ...t(at), color }}>{children}</div>
);

/** One tree, one action that prints its change, and an index that went stale. */
export function ReadActFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 md:grid-cols-3">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="1 · read" sub="get-app-state: the window as an indexed tree. The gaps are noise it dropped." color={SOL.blue} />
          <Shell>
            <Line at={0.2} color={SOL.base3}>$ cast computer get-app-state \</Line>
            <Line at={0.2} color={SOL.base3}>    --app TextEdit</Line>
            <Line at={0.5}>[1] window "Untitled"</Line>
            <Line at={0.62}>  [4] toolbar</Line>
            <Line at={0.74}>    [9] button "Bold"</Line>
            <Line at={0.86} color={SOL.yellow}>  [12] text area ""</Line>
            <Line at={0.98}>  [42] button "Save"</Line>
          </Shell>
        </div>
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="2 · act, see the change" sub="The action prints what changed in the tree, so no read is needed between steps." color={SOL.green} />
          <Shell>
            <Line at={1.4} color={SOL.base3}>$ cast computer set-value \</Line>
            <Line at={1.4} color={SOL.base3}>    --app TextEdit \</Line>
            <Line at={1.4} color={SOL.base3}>    --element-index 12 --value hello</Line>
            <Line at={1.9} color={SOL.green}>Set value completed via</Line>
            <Line at={1.9} color={SOL.green}>accessibility, verified (value).</Line>
            <Line at={2.05}>Changes: 1 added, 1 removed</Line>
            <Line at={2.1} color={SOL.red}>- [12] text area ""</Line>
            <Line at={2.2} color={SOL.green}>+ [12] text area "hello"</Line>
          </Shell>
        </div>
        <div>
          <PanelHead title="3 · the window moved" sub="A sheet opened and the numbers changed. The old index fails instead of clicking whatever is there now." color={SOL.red} />
          <Shell>
            <Line at={2.8} color={SOL.base3}>$ cast computer click \</Line>
            <Line at={2.8} color={SOL.base3}>    --app TextEdit \</Line>
            <Line at={2.8} color={SOL.base3}>    --element-index 42</Line>
            <Line at={3.3} color={SOL.red}>element_not_found</Line>
            <Line at={3.5}>Take a fresh snapshot and</Line>
            <Line at={3.5}>use its numbers.</Line>
          </Shell>
        </div>
      </div>
    </Stage>
  );
}

// ─── Exit code and verdict ─────────────────────────────────────────────────

const VERDICTS: { verb: string; path: string; verdict: string; good: boolean }[] = [
  { verb: "set-value", path: "accessibility write, read back", verdict: "verified", good: true },
  { verb: "set-value", path: "read back, but different", verdict: "value_mismatch", good: false },
  { verb: "click on a press", path: "accessibility press", verdict: "accessibility_action_unasserted", good: false },
  { verb: "type-text, in front", path: "key events", verdict: "synthetic_input", good: false },
  { verb: "type-text, behind", path: "the app's own event queue", verdict: "background_input", good: false },
  { verb: "paste-text", path: "the clipboard", verdict: "clipboard_paste", good: false },
];

/** Every row exits 0. Only a change the helper read back opens with "completed". */
export function VerdictFigure() {
  const top = 64;
  const gap = 36;
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={300} label="Six actions that all exit 0; only the one whose value was read back reports completed">
        <g fontSize="10" fill={SOL.base1}>
          <text x={20} y={34}>verb</text>
          <text x={186} y={34}>path</text>
          <text x={398} y={34}>exit</text>
          <text x={448} y={34}>verification</text>
          <text x={740} y={34} textAnchor="end">output opens with</text>
        </g>
        {VERDICTS.map((v, i) => {
          const y = top + i * gap;
          const at = 0.3 + i * 0.42;
          const color = v.good ? SOL.green : SOL.yellow;
          return (
            <g key={i}>
              <text x={20} y={y} fontSize="11.5" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(at)}>{v.verb}</text>
              <path d={`M${178} ${y - 4}H${390}`} pathLength={1} stroke={SOL.base2} strokeWidth={1.2} className="bj-draw" style={t(at + 0.05, 0.3)} />
              <text x={186} y={y - 8} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(at + 0.1)}>{v.path}</text>
              <g className="bj-pop" style={t(at + 0.3)}>
                <rect x={396} y={y - 15} width={30} height={18} rx={4} fill={SOL.base2} />
                <text x={411} y={y - 2} fontSize="10.5" textAnchor="middle" fill={SOL.base01}>0</text>
              </g>
              <text x={448} y={y - 2} fontSize="11" fill={v.good ? SOL.green : SOL.base02} className="bj-fade" style={t(at + 0.35)}>
                {v.good ? "verified (value)" : v.verdict}
              </text>
              <g className="bj-pop" style={t(at + 0.45)}>
                <rect x={v.good ? 662 : 664} y={y - 15} width={v.good ? 78 : 76} height={18} rx={9} fill={`${color}22`} stroke={color} />
                <text x={v.good ? 701 : 702} y={y - 2} fontSize="10.5" textAnchor="middle" fill={color}>{v.good ? "completed" : "attempted"}</text>
              </g>
            </g>
          );
        })}
        <text x={20} y={top + VERDICTS.length * gap + 6} fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(3.2)}>
          An attempted action also prints the get-app-state command that settles it.
        </text>
      </Sheet>
    </Stage>
  );
}

// ─── Input to a window behind ──────────────────────────────────────────────

/** Keys reach a background window through its app's queue; a mouse press there is refused, not misdelivered. */
export function FocusFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={300} label="The human works in a front window; the agent's keys reach the background TextEdit window through its own event queue, while a mouse press fails with window_not_focused">
        {(arrow) => (
          <>

            {/* the background window */}
            <g className="bj-fade" style={t(0.1)}>
              <rect x={300} y={34} width={300} height={170} rx={9} fill={SOL.base3} stroke={SOL.base1} />
              <text x={316} y={54} fontSize="10.5" fill={SOL.base1}>TextEdit · behind</text>
              <rect x={316} y={66} width={268} height={86} rx={4} fill={SOL.base2} opacity={0.6} />
              <rect x={518} y={164} width={66} height={24} rx={5} fill={SOL.base2} />
              <text x={551} y={180} fontSize="10.5" textAnchor="middle" fill={SOL.base01}>Save</text>
            </g>
            {/* the human's front window */}
            <g className="bj-fade" style={t(0.3)}>
              <rect x={220} y={110} width={250} height={150} rx={9} fill={SOL.base3} stroke={SOL.blue} strokeWidth={1.6} />
              <text x={236} y={130} fontSize="10.5" fill={SOL.blue}>the human's app · in front</text>
              <text x={236} y={160} fontSize="11" fill={SOL.base02}>still typing here,</text>
              <text x={236} y={177} fontSize="11" fill={SOL.base02}>keyboard untouched</text>
              <rect x={354} y={167} width={1.6} height={13} fill={SOL.blue} className="bj-pulse" />
            </g>

            {/* keys */}
            <g className="bj-rise" style={t(0.8)}>
              <rect x={20} y={46} width={160} height={40} rx={6} fill={SOL.base3} stroke={SOL.green} />
              <text x={32} y={63} fontSize="11" fontWeight={700} fill={SOL.base02}>type-text "hello"</text>
              <text x={32} y={78} fontSize="10" fill={SOL.base01}>keys</text>
            </g>
            <path d="M182 66C240 66 262 92 318 92" pathLength={1} fill="none" stroke={SOL.green} strokeWidth={1.6} markerEnd={arrow()} className="bj-draw" style={t(1.1, 0.8)} />
            <text x={326} y={97} fontSize="13" fill={SOL.green} className="bj-fade" style={t(1.9)}>hello</text>
            <text x={612} y={56} fontSize="10.5" fill={SOL.green} className="bj-fade" style={t(2.0)}>
              <tspan x={612}>into the app's own</tspan>
              <tspan x={612} dy={14}>event queue, without</tspan>
              <tspan x={612} dy={14}>activating it</tspan>
              <tspan x={612} dy={18} fontWeight={700}>background_input</tspan>
            </text>

            {/* mouse */}
            <g className="bj-rise" style={t(2.6)}>
              <rect x={20} y={214} width={160} height={40} rx={6} fill={SOL.base3} stroke={SOL.red} />
              <text x={32} y={231} fontSize="11" fontWeight={700} fill={SOL.base02}>click --mouse</text>
              <text x={32} y={246} fontSize="10" fill={SOL.base01}>a real press</text>
            </g>
            <path d="M182 234C230 234 248 226 266 214" pathLength={1} fill="none" stroke={SOL.red} strokeWidth={1.4} strokeDasharray="4 3" className="bj-draw" style={t(2.9, 0.4)} />
            <g className="bj-pop" style={t(3.3)}>
              <circle cx={272} cy={208} r={9} fill={SOL.red} />
              <path d="M268 204l8 8M276 204l-8 8" stroke={SOL.base3} strokeWidth={1.8} strokeLinecap="round" />
            </g>
            <text x={612} y={222} fontSize="10.5" fill={SOL.red} className="bj-fade" style={t(3.4)}>
              <tspan x={612} fontWeight={700}>window_not_focused</tspan>
              <tspan x={612} dy={14} fill={SOL.base01}>nothing delivered to</tspan>
              <tspan x={612} dy={14} fill={SOL.base01}>the wrong app</tspan>
            </text>
            <text x={20} y={284} fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(3.8)}>
              Next: a route with no mouse (set-value, a Secondary Action), or ask once with --restore-window.
            </text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
