"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet } from "../figureParts";

/**
 * Figures for the orchestration guide. The review verdicts, round limits and
 * critic sweep are the /orchestrate skill's (packages/cli/orchestration);
 * the per-wave cap is `cast plan autopilot --max` (default 3).
 */

// ─── Waves through a dependency graph ──────────────────────────────────────

const COLS = [40, 290, 540];
const TW = 180;
const TH = 38;
const WAVE_AT = [0.4, 2.2, 4.0];
const RUN = 1.1;

const TASKS = [
  { id: "a", wave: 0, row: 0, title: "events table" },
  { id: "b", wave: 0, row: 1, title: "retry worker" },
  { id: "c", wave: 0, row: 2, title: "HMAC signing" },
  { id: "d", wave: 1, row: 0, title: "POST /retry", deps: ["a", "b"] },
  { id: "e", wave: 1, row: 1, title: "failed list view", deps: ["a"] },
  { id: "f", wave: 1, row: 2, title: "dead-letter queue", deps: ["b", "c"] },
  { id: "g", wave: 2, row: 0, title: "retry button", deps: ["d", "e"] },
  { id: "h", wave: 2, row: 2, title: "on-call page", deps: ["f"] },
];
const rowY = (r: number) => 58 + r * 66;
const byId = Object.fromEntries(TASKS.map((x) => [x.id, x]));

/** Every task whose dependencies are done runs now, one agent each. */
export function WavesFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={290} label="Three waves: three independent tasks run first; their completion unlocks three more; those unlock the last two">
        {(arrow) => (
          <>
            {COLS.map((x, w) => (
              <text key={w} x={x + TW / 2} y={30} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base01} className="bj-fade" style={t(WAVE_AT[w] - 0.2)}>
                wave {w + 1}
              </text>
            ))}
            {TASKS.flatMap((task) =>
              (task.deps ?? []).map((d) => {
                const from = byId[d];
                const x1 = COLS[from.wave] + TW + 3;
                const y1 = rowY(from.row) + TH / 2;
                const x2 = COLS[task.wave] - 5;
                const y2 = rowY(task.row) + TH / 2;
                const mx = (x1 + x2) / 2;
                return (
                  <path key={`${d}-${task.id}`} d={`M${x1} ${y1}C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(WAVE_AT[task.wave] - 0.45, 0.35)} />
                );
              }),
            )}
            {TASKS.map((task) => {
              const x = COLS[task.wave];
              const y = rowY(task.row);
              const at = WAVE_AT[task.wave];
              return (
                <g key={task.id}>
                  <Box x={x} y={y} w={TW} h={TH} title={task.title} className="bj-pop" style={t(at + task.row * 0.08)} />
                  <rect x={x + 8} y={y + TH - 6} width={TW - 16} height={3} rx={1.5} fill={SOL.blue} className="bj-grow" style={t(at + 0.2, RUN)} />
                  <g className="bj-pop" style={t(at + 0.25 + RUN)}>
                    <circle cx={x + TW - 2} cy={y + 2} r={8} fill={SOL.green} />
                    <path d={`M${x + TW - 6} ${y + 2}l3 3 5-6`} stroke={SOL.base3} strokeWidth={1.8} fill="none" strokeLinecap="round" />
                  </g>
                </g>
              );
            })}
            <Label x={40} y={262} lines={["One implementer agent per running task, at most --max at a time (3 by default).", "A task starts the moment every task it depends on is done."]} ink="base01" size={10.5} className="bj-fade" style={t(5.6)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── One task: implement, review, merge ────────────────────────────────────

/** An implementer works on its own branch; a reviewer's verdict decides what happens to it. */
export function ReviewVerdictFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={260} label="An implementer works in its own worktree. A reviewer returns pass, needs changes, or reject. Pass merges to main, needs changes goes back with the review, reject goes to a person">
        {(arrow) => (
          <>
            <Box x={20} y={92} w={170} h={56} title="implementer" sub="own worktree + branch" ink="blue" className="bj-pop" style={t(0.1)} />
            <Box x={290} y={92} w={160} h={56} title="reviewer" sub="diff vs. the task" ink="violet" className="bj-pop" style={t(0.6)} />
            <Box x={570} y={36} w={170} h={46} title="merge to main" sub="next wave unlocks" ink="green" className="bj-pop" style={t(1.5)} />
            <Box x={570} y={170} w={170} h={46} title="you" sub="with the rationale" ink="red" className="bj-pop" style={t(2.9)} />

            <path d="M193 120H286" pathLength={1} stroke={SOL.base1} strokeWidth={1.4} fill="none" markerEnd={arrow()} className="bj-draw" style={t(0.4, 0.25)} />
            <Label x={240} y={112} lines={["done"]} anchor="middle" className="bj-fade" style={t(0.5)} />

            <path d="M452 108Q520 60 566 59" pathLength={1} stroke={SOL.green} strokeWidth={1.6} fill="none" markerEnd={arrow("green")} className="bj-draw" style={t(1.2, 0.3)} />
            <Label x={500} y={66} lines={["PASS"]} ink="green" weight={700} anchor="end" className="bj-fade" style={t(1.3)} />

            <path d="M370 150C370 222 105 222 105 152" pathLength={1} stroke={SOL.orange} strokeWidth={1.6} fill="none" markerEnd={arrow("orange")} className="bj-draw" style={t(2.0, 0.5)} />
            <Label x={238} y={228} lines={["NEEDS_CHANGES: the review goes back with it"]} ink="orange" anchor="middle" className="bj-fade" style={t(2.2)} />

            <path d="M452 132Q520 190 566 192" pathLength={1} stroke={SOL.red} strokeWidth={1.6} fill="none" markerEnd={arrow("red")} className="bj-draw" style={t(2.7, 0.3)} />
            <Label x={500} y={192} lines={["REJECT"]} ink="red" weight={700} anchor="end" className="bj-fade" style={t(2.8)} />

            <Label x={20} y={34} lines={["Escalate, don't loop:", "3 implementation attempts, 2 review rounds,", "then a person decides."]} ink="base01" size={10.5} className="bj-fade" style={t(3.3)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Critic rounds after the graph completes ───────────────────────────────

const CRITICS = [
  { y: 30, focus: "correctness" },
  { y: 92, focus: "security, edge cases" },
  { y: 154, focus: "UX, completeness" },
];

/** Critics sweep the integrated result; serious findings become a new wave. */
export function CriticRoundFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={250} label="When every task passes, two or three critics review the integrated code in parallel. Critical or major findings become fix tasks that run as a new wave; minor findings or none mean the plan is ready">
        {(arrow) => (
          <>
            <Box x={20} y={88} w={150} h={52} title="integrated main" sub="every task passed" ink="base01" className="bj-pop" style={t(0.1)} />
            {CRITICS.map((c, i) => (
              <g key={c.focus}>
                <path d={`M173 114C210 114 210 ${c.y + 22} 246 ${c.y + 22}`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(0.4 + i * 0.1, 0.3)} />
                <Box x={250} y={c.y} w={170} h={44} title={`critic ${i + 1}`} sub={c.focus} ink="magenta" className="bj-pop" style={t(0.6 + i * 0.12)} />
                <path d={`M423 ${c.y + 22}C460 ${c.y + 22} 460 114 494 114`} pathLength={1} fill="none" stroke={SOL.magenta} strokeWidth={1.2} markerEnd={arrow("magenta")} className="bj-draw" style={t(1.3 + i * 0.1, 0.3)} />
              </g>
            ))}
            <Box x={498} y={88} w={110} h={52} title="findings" sub="by severity" ink="magenta" className="bj-pop" style={t(1.7)} />

            <Box x={640} y={24} w={104} h={46} title="fix tasks" sub="a new wave" ink="orange" className="bj-pop" style={t(2.3)} />
            <path d="M610 104Q630 70 650 72" pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.4} markerEnd={arrow("orange")} className="bj-draw" style={t(2.1, 0.25)} />
            <Label x={606} y={84} lines={["critical,", "major"]} ink="orange" anchor="end" size={10} className="bj-fade" style={t(2.2)} />
            <path d="M692 22V10H95V84" pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.2} strokeDasharray="4 3" markerEnd={arrow("orange")} className="bj-draw" style={t(2.6, 0.8)} />

            <Box x={640} y={160} w={104} h={46} title="ready" sub="plan can close" ink="green" className="bj-pop" style={t(3.4)} />
            <path d="M610 126Q630 160 650 160" pathLength={1} fill="none" stroke={SOL.green} strokeWidth={1.4} markerEnd={arrow("green")} className="bj-draw" style={t(3.2, 0.25)} />
            <Label x={606} y={150} lines={["minor,", "or none"]} ink="green" anchor="end" size={10} className="bj-fade" style={t(3.3)} />

            <Label x={20} y={234} lines={["Each round repeats the sweep on the new main, until the critics find nothing serious."]} ink="base01" size={10.5} className="bj-fade" style={t(3.8)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
