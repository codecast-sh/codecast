"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";

/**
 * Figures for the remote and cloud sessions guide: what a cloud spawn does
 * over SSH, the five stages of a session move, and the relay that lets a
 * browser watch and type into a pane on another machine.
 */

function Dots({ id, w, h }: { id: string; w: number; h: number }) {
  return (
    <>
      <defs>
        <pattern id={id} width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
        </pattern>
        <marker id={`${id}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L8 4L0 8z" fill={SOL.base1} />
        </marker>
      </defs>
      <rect width={w} height={h} fill={`url(#${id})`} />
    </>
  );
}

// ─── A cloud spawn ─────────────────────────────────────────────────────────

const SPAWN_STEPS = [
  { n: 1, a: "wake the host if it sleeps", b: "up to 3 min Linux, 25 min Mac" },
  { n: 2, a: "fetch ~/work/billing, push a snapshot", b: "commit to refs/codecast/cloud/<name>" },
  { n: 3, a: "rsync the setup.copy files", b: ".env and friends, per worktree" },
  { n: 4, a: "the host runs cast ws acquire", b: "deps install there, ports probed there" },
];

/** The laptop prepares the host over SSH, then the session starts on the host's own daemon. */
export function CloudSpawnFigure() {
  const L = { x: 20, w: 190 };
  const H = { x: 548, w: 192 };
  const stepY = (i: number) => 66 + i * 46;
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 330" className="w-full block font-mono" role="img" aria-label="cast spawn --cloud wakes the host, refreshes the repository and pushes a snapshot commit, copies private files, has the host acquire a worktree, then creates the row routed to the host">
        <Dots id="cs-grid" w={760} h={330} />

        <g className="bj-fade" style={t(0.1)}>
          <rect x={L.x} y={40} width={L.w} height={196} rx={9} fill={SOL.base3} stroke={SOL.blue} strokeWidth={1.5} />
          <text x={L.x + 12} y={60} fontSize="11.5" fontWeight={700} fill={SOL.base02}>laptop</text>
          <text x={L.x + 12} y={84} fontSize="10" fill={SOL.base01}>$ cast spawn --cloud \</text>
          <text x={L.x + 12} y={98} fontSize="10" fill={SOL.base01}>  "port the v1 routes"</text>
          <text x={L.x + 12} y={128} fontSize="10" fill={SOL.base1}>your checkout</text>
          <text x={L.x + 12} y={144} fontSize="10" fill={SOL.base02}>feat/routes, 2 unpushed</text>
          <text x={L.x + 12} y={160} fontSize="10" fill={SOL.yellow}>M src/routes.ts</text>
          <text x={L.x + 12} y={176} fontSize="10" fill={SOL.yellow}>?? .env.local</text>
          <text x={L.x + 12} y={204} fontSize="9.5" fill={SOL.base1}>index and branches</text>
          <text x={L.x + 12} y={217} fontSize="9.5" fill={SOL.base1}>left untouched</text>
        </g>

        <g className="bj-fade" style={t(0.2)}>
          <rect x={H.x} y={40} width={H.w} height={196} rx={9} fill={SOL.base3} stroke={SOL.cyan} strokeWidth={1.5} />
          <text x={H.x + 12} y={60} fontSize="11.5" fontWeight={700} fill={SOL.base02}>cloud host</text>
          <text x={H.x + 12} y={76} fontSize="10" fill={SOL.base1}>its own daemon</text>
        </g>
        <text x={385} y={34} fontSize="10" textAnchor="middle" fill={SOL.base1} className="bj-fade" style={t(0.3)}>over SSH, from the laptop</text>

        {SPAWN_STEPS.map((s, i) => {
          const y = stepY(i);
          const at = 0.5 + i * 0.7;
          return (
            <g key={s.n}>
              <path d={`M${L.x + L.w + 4} ${y}H${H.x - 6}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.3} markerEnd="url(#cs-grid-arrow)" className="bj-draw" style={t(at, 0.45)} />
              <g className="bj-rise" style={t(at + 0.1)}>
                <circle cx={L.x + L.w + 22} cy={y - 12} r={8} fill={SOL.base02} />
                <text x={L.x + L.w + 22} y={y - 8.5} fontSize="10" textAnchor="middle" fill={SOL.base3}>{s.n}</text>
                <text x={L.x + L.w + 36} y={y - 8} fontSize="10.5" fill={SOL.base02}>{s.a}</text>
                <text x={L.x + L.w + 36} y={y + 14} fontSize="9.5" fill={SOL.base01}>{s.b}</text>
              </g>
            </g>
          );
        })}

        {/* what the host ends up with */}
        <g fontSize="9.5">
          <text x={H.x + 12} y={stepY(0) + 30} fill={SOL.green} className="bj-fade" style={t(1.0)}>● awake</text>
          <text x={H.x + 12} y={stepY(1) + 22} fill={SOL.base02} className="bj-fade" style={t(1.7)}>~/work/billing</text>
          <text x={H.x + 12} y={stepY(2) + 18} fill={SOL.base02} className="bj-fade" style={t(2.4)}>.env.local copied</text>
          <g className="bj-rise" style={t(3.1)}>
            <text x={H.x + 12} y={stepY(3) + 14} fill={SOL.base02}>worktree cloud-4f2a91</text>
            <text x={H.x + 12} y={stepY(3) + 28} fill={SOL.yellow}>same changes, uncommitted</text>
          </g>
        </g>

        {/* step 5: the row */}
        <g className="bj-rise" style={t(3.6)}>
          <rect x={240} y={268} width={290} height={44} rx={8} fill={SOL.base03} />
          <text x={254} y={286} fontSize="10.5" fill={SOL.base3}>
            <tspan fill={SOL.base1}>5</tspan>  Convex: the conversation row
          </text>
          <text x={254} y={302} fontSize="10" fill={SOL.cyan}>points at the worktree, routed to the host</text>
        </g>
        <path d={`M${530} 290C580 290 600 270 ${H.x + H.w / 2} ${240}`} pathLength={1} fill="none" stroke={SOL.cyan} strokeWidth={1.4} markerEnd="url(#cs-grid-arrow)" className="bj-draw" style={t(3.9, 0.4)} />
        <text x={740} y={322} textAnchor="end" fontSize="10" fill={SOL.green} className="bj-fade" style={t(4.3)}>session starts here</text>
        <text x={20} y={262} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(4.0)}>
          <tspan x={20}>nothing in steps 1 to 4</tspan>
          <tspan x={20} dy={13}>passes through Convex</tspan>
        </text>
      </svg>
    </Stage>
  );
}

// ─── Moving a session ──────────────────────────────────────────────────────

const STAGES = [
  { name: "fence", sub: "nothing delivers" },
  { name: "wait", sub: "the turn finishes" },
  { name: "quiesce", sub: "agent stopped" },
  { name: "transfer", sub: "git + transcript" },
  { name: "flip", sub: "one mutation" },
];

/** A session moves in five stages; messages sent meanwhile wait, then arrive on the destination. */
export function MoveStagesFigure() {
  const X0 = 140;
  const COL = 120;
  const cx = (i: number) => X0 + i * COL + COL / 2;
  const src = 110;
  const dst = 196;
  const at = (i: number) => 0.4 + i * 0.75;
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 320" className="w-full block font-mono" role="img" aria-label="Fence, wait, quiesce, transfer, flip: the session stays on the laptop until the flip moves its owner to the host, and messages held during the move are delivered there">
        <Dots id="mv-grid" w={760} h={320} />
        {STAGES.map((s, i) => (
          <g key={s.name} className="bj-fade" style={t(at(i) - 0.2)}>
            <rect x={X0 + i * COL + 4} y={22} width={COL - 8} height={40} rx={6} fill={SOL.base3} stroke={SOL.base1} />
            <text x={cx(i)} y={39} fontSize="11.5" fontWeight={700} textAnchor="middle" fill={SOL.base02}>{`${i + 1} ${s.name}`}</text>
            <text x={cx(i)} y={54} fontSize="9.5" textAnchor="middle" fill={SOL.base01}>{s.sub}</text>
            <line x1={X0 + i * COL} x2={X0 + i * COL} y1={70} y2={236} stroke={SOL.base2} />
          </g>
        ))}
        <text x={16} y={src + 4} fontSize="10.5" fontWeight={700} fill={SOL.base02}>macbook</text>
        <text x={16} y={dst + 4} fontSize="10.5" fontWeight={700} fill={SOL.base02}>linux-host-1</text>
        <line x1={X0} x2={744} y1={src} y2={src} stroke={SOL.base2} strokeWidth={1.4} />
        <line x1={X0} x2={744} y1={dst} y2={dst} stroke={SOL.base2} strokeWidth={1.4} />

        {/* the session on the source until the flip */}
        <rect x={X0} y={src - 6} width={4 * COL} height={12} rx={3} fill={SOL.blue} opacity={0.75} className="bj-grow" style={t(0.3, at(4) - 0.3)} />
        <rect x={X0 + COL} y={src - 6} width={COL} height={12} rx={3} fill={SOL.blue} className="bj-grow bj-pulse" style={t(at(1), 0.6)} />
        <text x={cx(1)} y={src - 12} fontSize="9.5" textAnchor="middle" fill={SOL.blue} className="bj-fade" style={t(at(1))}>mid turn, up to 10 min</text>
        <g className="bj-pop" style={t(at(2) + 0.2)}>
          <rect x={cx(2) - 7} y={src - 7} width={14} height={14} rx={2} fill={SOL.base02} />
        </g>
        <text x={cx(2)} y={src + 24} fontSize="9.5" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(at(2) + 0.3)}>transcript final</text>

        {/* transfer */}
        <path d={`M${cx(3) - 20} ${src + 8}C${cx(3) - 20} ${src + 50} ${cx(3) + 20} ${dst - 50} ${cx(3) + 20} ${dst - 9}`} pathLength={1} fill="none" stroke={SOL.cyan} strokeWidth={1.6} markerEnd="url(#mv-grid-arrow)" className="bj-draw" style={t(at(3), 0.6)} />
        <text x={cx(3) + 26} y={src + 50} fontSize="9.5" fill={SOL.cyan} className="bj-fade" style={t(at(3) + 0.3)}>git over SSH</text>

        {/* flip */}
        <rect x={X0 + 4 * COL} y={dst - 6} width={COL + 4} height={12} rx={3} fill={SOL.green} className="bj-grow" style={t(at(4), 0.5)} />
        <text x={cx(4)} y={dst - 14} fontSize="9.5" textAnchor="middle" fill={SOL.green} className="bj-fade" style={t(at(4) + 0.3)}>resume_session</text>
        <text x={cx(4)} y={src + 24} fontSize="9.5" textAnchor="middle" fill={SOL.base01} className="bj-fade" style={t(at(4) + 0.3)}>release_session</text>

        {/* messages held */}
        <text x={16} y={252} fontSize="10.5" fontWeight={700} fill={SOL.base02}>your messages</text>
        {[0.55, 1.4, 2.6].map((m, i) => (
          <g key={m}>
            <g className="bj-pop" style={t(at(0) + m)}>
              <rect x={X0 + m * COL * 1.2} y={240} width={34} height={16} rx={4} fill={`${SOL.yellow}26`} stroke={SOL.yellow} />
              <text x={X0 + m * COL * 1.2 + 17} y={252} fontSize="9" textAnchor="middle" fill={SOL.yellow}>held</text>
            </g>
            <path d={`M${X0 + m * COL * 1.2 + 34} 248C${cx(4) - 40} 248 ${cx(4) - 10 + i * 6} ${dst + 40} ${cx(4) - 10 + i * 6} ${dst + 8}`} pathLength={1} fill="none" stroke={SOL.green} strokeOpacity={0.6} strokeDasharray="3 3" className="bj-draw" style={t(at(4) + 0.4, 0.5)} />
          </g>
        ))}

        {/* the divider */}
        <g className="bj-rise" style={t(at(4) + 0.8)}>
          <line x1={140} x2={740} y1={290} y2={290} stroke={SOL.base1} strokeDasharray="2 3" />
          <rect x={210} y={279} width={460} height={22} rx={11} fill={SOL.base3} stroke={SOL.base1} />
          <text x={440} y={294} fontSize="10.5" textAnchor="middle" fill={SOL.base02}>[codecast] Now running on linux-host-1 (was macbook).</text>
        </g>
      </svg>
    </Stage>
  );
}

// ─── The pane relay ────────────────────────────────────────────────────────

/** Watching a pane on another machine: a renewed lease, captures pushed when the screen changes, keys collected by the next push. */
export function PaneRelayFigure() {
  const X0 = 130;
  const PX = 16; // px per second
  const SEC = 0.12; // animation seconds per real second
  const x = (s: number) => X0 + s * PX;
  const lane = { viewer: 74, row: 146, daemon: 214 };
  const closeAt = 16;
  const leaseEnd = 14 + 20; // last renewal at 14 s, lease of 20 s
  const key = 9.5;
  const captures: number[] = [];
  for (let s = 0.4; s < leaseEnd; s += 0.4) captures.push(+s.toFixed(1));
  const fast = (s: number) => s > key && s < key + 3;
  return (
    <Stage minWidth={720}>
      <svg viewBox="0 0 760 320" className="w-full block font-mono" role="img" aria-label="The viewer renews a 20 second lease every 7 seconds; the far daemon captures every 400 ms while watched, 100 ms after a keystroke, and stops by itself when the lease runs out">
        <Dots id="pr-grid" w={760} h={320} />
        {[0, 5, 10, 15, 20, 25, 30, 35].map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={44} y2={240} stroke={SOL.base2} />
            <text x={x(s)} y={256} fontSize="9.5" textAnchor="middle" fill={SOL.base1}>{`${s} s`}</text>
          </g>
        ))}
        <g fontSize="10.5" fontWeight={700} fill={SOL.base02}>
          <text x={16} y={lane.viewer + 4}>your browser</text>
          <text x={16} y={lane.row + 4}>relay row</text>
          <text x={16} y={lane.daemon + 4}>far daemon</text>
        </g>
        <text x={16} y={lane.row + 18} fontSize="9.5" fill={SOL.base1}>in Convex</text>
        <text x={16} y={lane.daemon + 18} fontSize="9.5" fill={SOL.base1}>tmux capture-pane</text>

        {/* lease */}
        {[0, 7, 14].map((r, i) => (
          <g key={r}>
            <rect x={x(r)} y={lane.viewer - 18} width={20 * PX} height={6} rx={2} fill={SOL.blue} opacity={0.25 + i * 0.12} className="bj-grow" style={t(r * SEC, 0.4)} />
            <g className="bj-pop" style={t(r * SEC)}>
              <circle cx={x(r)} cy={lane.viewer} r={5} fill={SOL.blue} />
            </g>
          </g>
        ))}
        <text x={x(0)} y={lane.viewer - 24} fontSize="9.5" fill={SOL.blue} className="bj-fade" style={t(0.1)}>a 20 s lease, renewed every 7 s</text>
        <g className="bj-pop" style={t(closeAt * SEC)}>
          <rect x={x(closeAt) - 6} y={lane.viewer - 6} width={12} height={12} rx={2} fill={SOL.base01} />
        </g>
        <text x={x(closeAt) + 10} y={lane.viewer + 4} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(closeAt * SEC)}>tab closed, no stop sent</text>

        {/* keystroke */}
        <g className="bj-pop" style={t(key * SEC)}>
          <rect x={x(key) - 14} y={lane.viewer - 9} width={28} height={18} rx={4} fill={SOL.base03} />
          <text x={x(key)} y={lane.viewer + 4} fontSize="10" textAnchor="middle" fill={SOL.base3}>y⏎</text>
        </g>
        <path d={`M${x(key)} ${lane.viewer + 10}V${lane.row - 10}`} pathLength={1} stroke={SOL.orange} strokeWidth={1.3} markerEnd="url(#pr-grid-arrow)" className="bj-draw" style={t(key * SEC + 0.1, 0.2)} />
        <text x={x(key) + 6} y={lane.row - 18} fontSize="9.5" fill={SOL.orange} className="bj-fade" style={t(key * SEC + 0.2)}>appended as hex: 79 0d</text>
        <path d={`M${x(key + 0.4)} ${lane.row + 10}V${lane.daemon - 10}`} pathLength={1} stroke={SOL.orange} strokeWidth={1.3} markerEnd="url(#pr-grid-arrow)" className="bj-draw" style={t((key + 0.4) * SEC + 0.3, 0.2)} />
        <text x={x(key + 0.4) + 6} y={lane.row + 30} fontSize="9.5" fill={SOL.orange} className="bj-fade" style={t((key + 0.4) * SEC + 0.4)}>
          <tspan x={x(key + 0.4) + 6}>the next push's answer carries it,</tspan>
          <tspan x={x(key + 0.4) + 6} dy={12}>cleared in the same transaction:</tspan>
          <tspan x={x(key + 0.4) + 6} dy={12}>tmux send-keys -H, exactly once</tspan>
        </text>

        {/* captures */}
        {captures.map((s) => (
          <rect key={s} x={x(s) - 0.6} y={lane.daemon - 7} width={1.2} height={14} fill={fast(s) ? SOL.orange : SOL.cyan} opacity={0.8} className="bj-fade" style={t(s * SEC)} />
        ))}
        {captures.filter((s) => s > key && s < key + 3).flatMap((s) => [s + 0.1, s + 0.2, s + 0.3]).map((s) => (
          <rect key={`f${s}`} x={x(s) - 0.6} y={lane.daemon - 7} width={1.2} height={14} fill={SOL.orange} opacity={0.8} className="bj-fade" style={t(s * SEC)} />
        ))}
        <text x={x(0)} y={lane.daemon + 26} fontSize="9.5" fill={SOL.cyan} className="bj-fade" style={t(0.3)}>every 400 ms while watched</text>
        <text x={x(key + 3) + 6} y={lane.daemon + 26} fontSize="9.5" fill={SOL.orange} className="bj-fade" style={t(key * SEC + 0.3)}>100 ms for 3 s after a key</text>
        <g className="bj-pop" style={t(leaseEnd * SEC)}>
          <line x1={x(leaseEnd)} x2={x(leaseEnd)} y1={lane.viewer - 22} y2={lane.daemon + 12} stroke={SOL.red} strokeWidth={1.4} strokeDasharray="3 3" />
        </g>
        <text x={x(leaseEnd) - 6} y={lane.viewer - 40} fontSize="9.5" textAnchor="end" fill={SOL.red} className="bj-fade" style={t(leaseEnd * SEC + 0.1)}>lease runs out: capture stops on its own</text>

        <text x={16} y={290} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(leaseEnd * SEC + 0.3)}>
          The screen goes to the row only when it changed, or every 4 s to show the pane is still there.
        </text>
        <text x={16} y={306} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(leaseEnd * SEC + 0.4)}>
          No push for 6 s and the daemon is presumed gone; the next renewal asks for a new stream_pane.
        </text>
      </svg>
    </Stage>
  );
}
