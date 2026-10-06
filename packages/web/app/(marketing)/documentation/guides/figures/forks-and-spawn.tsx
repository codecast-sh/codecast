"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Arrow, Sheet } from "../figureParts";

/**
 * Figures for the forks and spawn guide: whose inbox a launch lands in, how
 * settling workers wake their parent, and where a fork branches.
 */

// ─── Where a launch lands ──────────────────────────────────────────────────

function Card({ title, sub, at, nested, color = SOL.blue }: { title: string; sub: string; at: number; nested?: boolean; color?: string }) {
  return (
    <div className={`bj-rise flex items-center gap-2 rounded-md border px-2.5 py-1.5 ${nested ? "ml-6" : ""}`} style={{ ...t(at), borderColor: nested ? SOL.base2 : `${color}88`, backgroundColor: nested ? "transparent" : SOL.base3 }}>
      {nested && <span className="font-mono text-[11px]" style={{ color: SOL.base1 }}>└</span>}
      <span className="inline-block w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} />
      <span className="font-mono text-[11.5px] font-bold truncate" style={{ color: SOL.base02 }}>{title}</span>
      <span className="font-mono text-[10px] ml-auto shrink-0" style={{ color: SOL.base1 }}>{sub}</span>
    </div>
  );
}

/** A worker nests under the session that launched it; an independent spawn or
 *  a fork branch is a card of its own in the human's inbox. */
export function OwnershipFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="cast spawn --subagent" sub="The parent owns the result. One card; the workers live under it." color={SOL.cyan} />
          <div className="m-4 rounded-lg p-3 space-y-1.5" style={{ backgroundColor: `${SOL.base2}66` }}>
            <div className="font-mono text-[10px] mb-1" style={{ color: SOL.base1 }}>the human's inbox</div>
            <Card title="Retry rollout" sub="working" at={0.2} color={SOL.cyan} />
            <Card title="audit the auth module" sub="worker" at={0.6} nested color={SOL.cyan} />
            <Card title="review the billing diff" sub="worker" at={0.75} nested color={SOL.cyan} />
            <Card title="Onboarding email copy" sub="done" at={0.3} color={SOL.green} />
          </div>
          <div className="px-5 pb-4 text-[12px] leading-snug bj-fade" style={{ ...t(1.0), color: SOL.base01 }}>
            The parent reads their results and reports once.
          </div>
        </div>
        <div>
          <PanelHead title="cast spawn, cast fork" sub="The human owns each one. Every launch is its own card." color={SOL.orange} />
          <div className="m-4 rounded-lg p-3 space-y-1.5" style={{ backgroundColor: `${SOL.base2}66` }}>
            <div className="font-mono text-[10px] mb-1" style={{ color: SOL.base1 }}>the human's inbox</div>
            <Card title="Retry rollout" sub="working" at={1.3} color={SOL.cyan} />
            <Card title="audit the auth module" sub="new" at={1.7} color={SOL.orange} />
            <Card title="review the billing diff" sub="new" at={1.85} color={SOL.orange} />
            <Card title="Onboarding email copy" sub="done" at={1.4} color={SOL.green} />
          </div>
          <div className="px-5 pb-4 text-[12px] leading-snug bj-fade" style={{ ...t(2.1), color: SOL.base01 }}>
            Each needs the human to read and steer it. Use only when they asked.
          </div>
        </div>
      </div>
    </Stage>
  );
}

// ─── Workers settling ──────────────────────────────────────────────────────

const SEC = 0.3;
const WORKERS = [
  { name: "worker A", end: 4, state: "done", color: SOL.green },
  { name: "worker B", end: 8, state: "blocked", color: SOL.red },
  { name: "worker C", end: 8.5, state: "done", color: SOL.green },
];
const GRACE = 0.8;

/** The parent parks after launching; each settle wakes it a short grace later,
 *  and workers that settle together arrive as one message. */
export function WorkerSettleFigure() {
  const X0 = 110;
  const PX = 52;
  const x = (u: number) => X0 + u * PX;
  const laneY = (i: number) => 120 + i * 38;
  const wakes = [
    { at: 4 + GRACE, text: "1 worker settled", ids: [0] },
    { at: 8.5 + GRACE, text: "2 workers settled", ids: [1, 2] },
  ];
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={300} label="A parent launches three workers and parks; worker A settles and wakes the parent; workers B and C settle close together and wake it with one message">
        {(arrow) => (
          <>
            <text x={14} y={56} fontSize="10.5" fontWeight={700} fill={SOL.base02}>parent</text>
            <rect x={x(0)} y={46} width={0.6 * PX} height={16} rx={3} fill={SOL.cyan} opacity={0.8} className="bj-grow" style={t(0, 0.6 * SEC)} />
            <rect x={x(0.6)} y={46} width={(10 - 0.6) * PX} height={16} rx={3} fill="none" stroke={SOL.base1} strokeDasharray="3 3" className="bj-fade" style={t(0.6 * SEC)} />
            <text x={x(1.2)} y={58} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(0.7 * SEC)}>dormant: its turn has ended</text>

            {WORKERS.map((w, i) => {
              const y = laneY(i);
              return (
                <g key={w.name}>
                  <text x={14} y={y + 12} fontSize="10.5" fill={SOL.base01}>{w.name}</text>
                  <Arrow head={arrow()} d={`M${x(0.5)} 64V${y - 2}`} at={0.4 * SEC} color={SOL.cyan} dur={0.3} />
                  <rect x={x(0.5)} y={y} width={(w.end - 0.5) * PX} height={16} rx={3} fill={SOL.cyan} opacity={0.45} className="bj-grow" style={t(0.5 * SEC, (w.end - 0.5) * SEC)} />
                  <g className="bj-pop" style={t(w.end * SEC)}>
                    <circle cx={x(w.end)} cy={y + 8} r={7} fill={w.color} />
                    <text x={x(w.end)} y={y + 31} textAnchor="middle" fontSize="9.5" fill={w.color}>{w.state}</text>
                  </g>
                </g>
              );
            })}

            {wakes.map((wk, i) => (
              <g key={wk.at}>
                {wk.ids.map((id) => (
                  <path key={id} d={`M${x(WORKERS[id].end)} ${laneY(id)}C${x(WORKERS[id].end)} 90 ${x(wk.at)} 90 ${x(wk.at)} 66`} stroke={SOL.orange} strokeWidth={1.3} strokeDasharray="3 3" fill="none" className="bj-fade" style={t(wk.at * SEC)} />
                ))}
                <g className="bj-pop" style={t(wk.at * SEC + 0.1)}>
                  <rect x={x(wk.at) - 6} y={46} width={12} height={16} rx={3} fill={SOL.orange} />
                </g>
                <g className="bj-rise" style={t(wk.at * SEC + 0.2)}>
                  <rect x={x(wk.at) - (i === 0 ? 70 : 120)} y={12} width={i === 0 ? 140 : 150} height={22} rx={4} fill={SOL.base03} />
                  <text x={x(wk.at) - (i === 0 ? 0 : 45)} y={27} textAnchor="middle" fontSize="10" fill={SOL.base3}>{wk.text}</text>
                </g>
              </g>
            ))}

            <g className="bj-fade" style={t(10 * SEC)}>
              <line x1={14} x2={746} y1={240} y2={240} stroke={SOL.base2} />
              <text x={14} y={262} fontSize="10" fill={SOL.base01}>
                <tspan fontWeight={700} fill={SOL.base02}>Wakes the parent: </tspan>done, blocked, stopped, waiting on a permission prompt, or ended.
              </text>
              <text x={14} y={280} fontSize="10" fill={SOL.base01}>A worker that goes dormant or is waiting on its own wake does not.</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Where a fork branches ─────────────────────────────────────────────────

const MSGS = ["you", "agent", "you", "agent", "you", "agent", "you"];

/** The default fork point sits just before the latest human message (the
 *  fork request), so no branch inherits it. This thread takes the first
 *  direction; each other direction becomes a branch. */
export function ForkPointFigure() {
  const X0 = 40;
  const DX = 62;
  const Y = 70;
  const forkX = X0 + 5 * DX + DX / 2;
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={260} label="A conversation forks just before the latest user message; this thread continues on the first direction and a branch starts on the second">
        <path d={`M${X0} ${Y}H${forkX}`} pathLength={1} stroke={SOL.base01} strokeWidth={2} fill="none" className="bj-draw" style={t(0.1, 1.2)} />
        {MSGS.map((m, i) => {
          const cx = X0 + i * DX;
          const last = i === MSGS.length - 1;
          return (
            <g key={i} className="bj-pop" style={t(0.15 + i * 0.16)} opacity={last ? 0.55 : 1}>
              <circle cx={cx} cy={Y} r={7} fill={m === "you" ? SOL.blue : SOL.base3} stroke={m === "you" ? SOL.blue : SOL.base01} strokeWidth={1.5} />
              <text x={cx} y={Y + 24} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{m}</text>
            </g>
          );
        })}
        <text x={X0 + 6 * DX + 4} y={Y - 22} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.3)}>"try both approaches"</text>
        <g className="bj-pop" style={t(1.4)}>
          <line x1={forkX} x2={forkX} y1={Y - 36} y2={Y + 12} stroke={SOL.orange} strokeWidth={1.4} strokeDasharray="3 3" />
          <text x={forkX - 6} y={Y - 26} textAnchor="end" fontSize="10" fontWeight={700} fill={SOL.orange}>fork point</text>
        </g>

        <path d={`M${forkX} ${Y}C${forkX} ${Y + 70} ${forkX + 40} 150 ${forkX + 100} 150H700`} pathLength={1} stroke={SOL.cyan} strokeWidth={2} fill="none" className="bj-draw" style={t(1.8, 0.8)} />
        <path d={`M${forkX} ${Y}C${forkX} ${Y + 120} ${forkX + 40} 210 ${forkX + 100} 210H700`} pathLength={1} stroke={SOL.violet} strokeWidth={2} fill="none" className="bj-draw" style={t(2.0, 0.8)} />
        <g className="bj-rise" style={t(2.6)}>
          <circle cx={forkX + 110} cy={150} r={7} fill={SOL.cyan} />
          <text x={forkX + 126} y={146} fontSize="10.5" fontWeight={700} fill={SOL.cyan}>this thread</text>
          <text x={forkX + 126} y={160} fontSize="9.5" fill={SOL.base01}>carries on with "optimistic locking"</text>
          <circle cx={forkX + 110} cy={210} r={7} fill={SOL.violet} />
          <text x={forkX + 126} y={206} fontSize="10.5" fontWeight={700} fill={SOL.violet}>a new branch</text>
          <text x={forkX + 126} y={220} fontSize="9.5" fill={SOL.base01}>gets "queue-based" as its next message</text>
        </g>
        <text x={X0} y={170} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(3.0)}>
          <tspan x={X0}>both keep everything up to</tspan>
          <tspan x={X0} dy={13}>the fork point; --at picks</tspan>
          <tspan x={X0} dy={13}>another line, -s another</tspan>
          <tspan x={X0} dy={13}>session</tspan>
        </text>
      </Sheet>
    </Stage>
  );
}
