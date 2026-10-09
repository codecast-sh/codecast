"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Sheet } from "../figureParts";

/**
 * The figure for the Codex Cloud guide: how several attempts at one prompt
 * become branches of one session.
 */

// ─── Attempts as branches ──────────────────────────────────────────────────

/** Three attempts at one prompt: the session forks at the prompt; each branch keeps its own follow-ups. */
export function AttemptsFigure() {
  const PROMPT = { x: 70, y: 150 };
  const ys = [70, 150, 230];
  const colors = [SOL.blue, SOL.magenta, SOL.cyan];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={300} label="A first message with three attempts forks the session into three branches at the shared prompt; a follow-up on attempt 2 continues that attempt, while the task's own line stays on attempt 1">
        <g className="bj-pop" style={t(0.2)}>
          <rect x={20} y={PROMPT.y - 30} width={150} height={60} rx={8} fill={SOL.base03} />
          <text x={34} y={PROMPT.y - 8} fontSize="10" fill={SOL.base1}>first message</text>
          <text x={34} y={PROMPT.y + 8} fontSize="11" fill={SOL.base3}>"port the v1 routes"</text>
          <text x={34} y={PROMPT.y + 22} fontSize="10" fill={SOL.orange}>attempts: 3</text>
        </g>
        {ys.map((y, i) => (
          <g key={i}>
            <path d={`M172 ${PROMPT.y}C220 ${PROMPT.y} 220 ${y} 268 ${y}`} pathLength={1} fill="none" stroke={colors[i]} strokeWidth={1.8} className="bj-draw" style={t(0.6 + i * 0.15, 0.4)} />
            <g className="bj-pop" style={t(1.0 + i * 0.15)}>
              <rect x={268} y={y - 16} width={200} height={32} rx={6} fill={SOL.base3} stroke={colors[i]} strokeWidth={1.4} />
              <text x={280} y={y + 4} fontSize="11" fill={SOL.base02}>{`attempt ${i + 1}`}</text>
              <text x={456} y={y + 4} fontSize="10" textAnchor="end" fill={SOL.base1}>{i === 0 ? "the task's line" : "a branch"}</text>
            </g>
          </g>
        ))}
        {/* follow-up on attempt 2 */}
        <path d={`M470 ${ys[1]}H520`} pathLength={1} stroke={colors[1]} strokeWidth={1.8} className="bj-draw" style={t(1.8, 0.3)} />
        <g className="bj-pop" style={t(2.1)}>
          <rect x={520} y={ys[1] - 16} width={220} height={32} rx={6} fill={`${SOL.magenta}14`} stroke={colors[1]} strokeWidth={1.4} />
          <text x={532} y={ys[1] + 4} fontSize="11" fill={SOL.base02}>"keep the old route too"</text>
        </g>
        <text x={520} y={ys[1] + 34} fontSize="10" fill={SOL.magenta} className="bj-fade" style={t(2.3)}>sent on a branch: continues attempt 2</text>
        <path d={`M470 ${ys[0]}H520`} pathLength={1} stroke={colors[0]} strokeWidth={1.8} strokeDasharray="3 3" className="bj-draw" style={t(2.6, 0.3)} />
        <text x={528} y={ys[0] + 4} fontSize="10" fill={SOL.blue} className="bj-fade" style={t(2.8)}>the task's own line stays here</text>
        <text x={20} y={286} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.1)}>
          Switch between attempts under the shared prompt. Stopping the session cancels the whole task, every attempt at once.
        </text>
      </Sheet>
    </Stage>
  );
}
