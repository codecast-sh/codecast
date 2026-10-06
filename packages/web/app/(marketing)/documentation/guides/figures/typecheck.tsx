"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";

/**
 * Figures for the typecheck guide: one program in memory instead of one per
 * session, the file protocol between an ask and the watcher, and how the
 * machine-wide cap picks a slot or queues.
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

// ─── One program, many asks ────────────────────────────────────────────────

const SESSIONS = ["A", "B", "C", "D", "E", "F"];

/** Six sessions each building the program, against six sessions asking one watcher. */
export function SharedProgramFigure() {
  const rowY = (i: number) => 58 + i * 34;
  const RAM = 200; // px for the machine's memory
  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 760 330" className="w-full block font-mono" role="img" aria-label="Six fresh tsc runs build six programs and push memory into swap; six cast check asks share one watcher's program">
        <Dots id="sp-grid" w={760} h={330} />
        <line x1={380} x2={380} y1={16} y2={314} stroke={SOL.base2} />

        {/* left: fresh tsc */}
        <text x={20} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>tsc --noEmit in every session</text>
        {SESSIONS.map((s, i) => (
          <g key={s}>
            <text x={20} y={rowY(i) + 14} fontSize="10.5" fill={SOL.base01}>{`session ${s}`}</text>
            <rect x={96} y={rowY(i) + 3} width={150} height={14} rx={3} fill={`${SOL.orange}18`} />
            <rect x={96} y={rowY(i) + 3} width={150} height={14} rx={3} fill={SOL.orange} opacity={0.75} className="bj-grow" style={t(0.3 + i * 0.25, 2.2)} />
            <text x={254} y={rowY(i) + 14} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(2.4 + i * 0.25)}>builds it all</text>
          </g>
        ))}
        {/* memory meter */}
        <text x={20} y={274} fontSize="10" fill={SOL.base1}>memory</text>
        <rect x={96} y={264} width={RAM} height={14} rx={3} fill="none" stroke={SOL.base1} />
        <rect x={96} y={264} width={RAM + 52} height={14} rx={3} fill={SOL.red} opacity={0.8} className="bj-grow" style={t(0.4, 3.6)} />
        <line x1={96 + RAM} x2={96 + RAM} y1={258} y2={284} stroke={SOL.base02} strokeWidth={1.4} />
        <text x={96 + RAM} y={298} fontSize="9.5" textAnchor="middle" fill={SOL.base01}>RAM</text>
        <text x={96 + RAM + 56} y={275} fontSize="10.5" fontWeight={700} fill={SOL.red} className="bj-fade" style={t(4.0)}>swap</text>
        <text x={20} y={316} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(4.1)}>1 to 2 GB and minutes each, the same graph six times</text>

        {/* right: cast check */}
        <text x={400} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>cast check</text>
        {SESSIONS.map((s, i) => (
          <g key={s}>
            <text x={400} y={rowY(i) + 14} fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(0.3)}>{`session ${s}`}</text>
            <path d={`M468 ${rowY(i) + 10}C530 ${rowY(i) + 10} 540 146 ${592} 146`} pathLength={1} fill="none" stroke={SOL.green} strokeOpacity={0.65} strokeWidth={1.2} markerEnd="url(#sp-grid-arrow)" className="bj-draw" style={t(1.0 + i * 0.12, 0.45)} />
          </g>
        ))}
        <g className="bj-pop" style={t(0.5)}>
          <rect x={596} y={104} width={150} height={84} rx={8} fill={SOL.base3} stroke={SOL.green} strokeWidth={1.6} />
          <text x={671} y={126} fontSize="11.5" fontWeight={700} textAnchor="middle" fill={SOL.base02}>one watcher</text>
          <text x={671} y={142} fontSize="10" textAnchor="middle" fill={SOL.base01}>tsc --watch</text>
          <rect x={612} y={154} width={118} height={14} rx={3} fill={SOL.orange} opacity={0.75} />
          <text x={671} y={182} fontSize="9.5" textAnchor="middle" fill={SOL.base01}>the program, held</text>
        </g>
        <rect x={496} y={264} width={RAM} height={14} rx={3} fill="none" stroke={SOL.base1} />
        <rect x={496} y={264} width={40} height={14} rx={3} fill={SOL.green} opacity={0.8} className="bj-grow" style={t(0.6, 0.6)} />
        <line x1={496 + RAM} x2={496 + RAM} y1={258} y2={284} stroke={SOL.base02} strokeWidth={1.4} />
        <text x={420} y={274} fontSize="10" fill={SOL.base1}>memory</text>
        <text x={400} y={316} fontSize="10" fill={SOL.green} className="bj-fade" style={t(2.0)}>✓ web: 0 errors (pass 4s old)  · six times, in seconds</text>
      </svg>
    </Stage>
  );
}

// ─── An ask, over files ────────────────────────────────────────────────────

/** The asker and the watcher never talk directly; they meet in state.json. */
export function AskFigure() {
  const X0 = 150;
  const PX = 140; // px per second of the story
  const SEC = 0.7; // animation seconds per story second
  const x = (s: number) => X0 + s * PX;
  const lanes = { ask: 70, state: 150, watch: 230 };
  const polls = [1.05, 1.35, 1.65, 1.95, 2.25, 2.55, 2.85, 3.15];
  const passStart = 0.35;
  const passEnd = 3.0;
  const ev = (at: number) => t(at * SEC);
  return (
    <Stage minWidth={720}>
      <svg viewBox="0 0 760 300" className="w-full block font-mono" role="img" aria-label="An ask takes the lock, stamps askedAt, waits 750 ms, then polls state.json every 300 ms until the watcher's pass ends and its diagnostics are written">
        <Dots id="ask-grid" w={760} h={300} />
        <g fontSize="10.5" fill={SOL.base02} fontWeight={700}>
          <text x={16} y={lanes.ask + 4}>cast check web</text>
          <text x={16} y={lanes.state + 4}>state.json</text>
          <text x={16} y={lanes.watch + 4}>cast check-watch</text>
        </g>
        <text x={16} y={lanes.watch + 18} fontSize="9.5" fill={SOL.base1}>wraps tsc --watch</text>
        {Object.values(lanes).map((y) => (
          <line key={y} x1={X0 - 10} x2={744} y1={y} y2={y} stroke={SOL.base2} strokeWidth={1.2} />
        ))}

        {/* the ask */}
        <g className="bj-pop" style={ev(0)}>
          <rect x={x(0) - 6} y={lanes.ask - 9} width={12} height={18} rx={2} fill={SOL.yellow} />
        </g>
        <text x={x(0)} y={lanes.ask - 16} fontSize="9.5" textAnchor="middle" fill={SOL.yellow} className="bj-fade" style={ev(0)}>start.lock</text>
        <path d={`M${x(0.1)} ${lanes.ask + 4}L${x(0.15)} ${lanes.state - 6}`} pathLength={1} stroke={SOL.base1} strokeWidth={1.2} markerEnd="url(#ask-grid-arrow)" className="bj-draw" style={t(0.1 * SEC, 0.25)} />
        <text x={x(0.17) + 6} y={lanes.state - 12} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={ev(0.15)}>askedAt</text>
        <rect x={x(0.2)} y={lanes.ask - 5} width={0.75 * PX} height={10} rx={2} fill={`${SOL.blue}30`} className="bj-grow" style={t(0.2 * SEC, 0.75 * SEC)} />
        <text x={x(0.2 + 0.375)} y={lanes.ask - 12} fontSize="9.5" textAnchor="middle" fill={SOL.blue} className="bj-fade" style={ev(0.25)}>settle 750 ms</text>
        {polls.map((p) => (
          <path key={p} d={`M${x(p)} ${lanes.ask + 6}V${lanes.state - 8}`} stroke={SOL.blue} strokeOpacity={0.55} strokeDasharray="2 3" className="bj-fade" style={ev(p)} />
        ))}
        <text x={x(1.5)} y={lanes.ask - 12} fontSize="9.5" fill={SOL.blue} className="bj-fade" style={ev(1.1)}>poll every 300 ms</text>

        {/* the watcher's pass */}
        <rect x={x(passStart)} y={lanes.watch - 7} width={(passEnd - passStart) * PX} height={14} rx={3} fill={SOL.orange} opacity={0.7} className="bj-grow" style={t(passStart * SEC, (passEnd - passStart) * SEC)} />
        <text x={x(passStart)} y={lanes.watch + 24} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={ev(passStart)}>"Starting compilation…"</text>
        <path d={`M${x(passStart)} ${lanes.watch - 8}V${lanes.state + 8}`} pathLength={1} stroke={SOL.orange} strokeWidth={1.2} markerEnd="url(#ask-grid-arrow)" className="bj-draw" style={t(passStart * SEC, 0.2)} />
        <text x={x(passStart) + 6} y={lanes.state + 22} fontSize="9.5" fill={SOL.orange} className="bj-fade" style={ev(passStart + 0.05)}>inProgress: true</text>
        <text x={x(passEnd)} y={lanes.watch + 40} fontSize="9.5" textAnchor="end" fill={SOL.base01} className="bj-fade" style={ev(passEnd)}>"Found 0 errors. Watching for file changes."</text>
        <path d={`M${x(passEnd)} ${lanes.watch - 8}V${lanes.state + 8}`} pathLength={1} stroke={SOL.green} strokeWidth={1.2} markerEnd="url(#ask-grid-arrow)" className="bj-draw" style={t(passEnd * SEC, 0.2)} />
        <g className="bj-rise" style={ev(passEnd + 0.05)}>
          <text x={x(passEnd) + 6} y={lanes.state + 22} fontSize="9.5" fill={SOL.green}>1 diagnostics.txt</text>
          <text x={x(passEnd) + 6} y={lanes.state + 35} fontSize="9.5" fill={SOL.green}>2 finishedAt, errors: 0</text>
        </g>

        {/* the answer */}
        <path d={`M${x(3.15)} ${lanes.state - 8}V${lanes.ask + 8}`} pathLength={1} stroke={SOL.green} strokeWidth={1.4} markerEnd="url(#ask-grid-arrow)" className="bj-draw" style={t(3.15 * SEC, 0.2)} />
        <g className="bj-pop" style={ev(3.25)}>
          <rect x={x(3.15) + 8} y={lanes.ask - 11} width={120} height={22} rx={5} fill={SOL.base03} />
          <text x={x(3.15) + 16} y={lanes.ask + 4} fontSize="10" fill={SOL.green}>✓ web: 0 errors</text>
        </g>
        <text x={16} y={294} fontSize="10" fill={SOL.base01} className="bj-fade" style={ev(3.4)}>
          Diagnostics are written before the pass is marked finished, so a reader never sees half a pass.
        </text>
      </svg>
    </Stage>
  );
}

// ─── Six slots ─────────────────────────────────────────────────────────────

type Slot = { name: string; state: "idle" | "waited" | "unwaited"; note: string };

const CASE_A: Slot[] = [
  { name: "web", state: "waited", note: "an ask waits" },
  { name: "cli", state: "idle", note: "asked 2m ago" },
  { name: "convex", state: "idle", note: "asked 31m ago" },
  { name: "api", state: "waited", note: "an ask waits" },
  { name: "mobile", state: "idle", note: "asked 9m ago" },
  { name: "evals", state: "idle", note: "asked 18m ago" },
];
const CASE_B: Slot[] = CASE_A.map((s) => ({ ...s, state: "waited", note: "an ask waits" }));

function SlotRow({ y, slots, evict, at }: { y: number; slots: Slot[]; evict: number | null; at: number }) {
  const W = 94;
  return (
    <g>
      {slots.map((s, i) => {
        const x = 116 + i * (W + 8);
        const busy = s.state !== "idle";
        const color = busy ? SOL.orange : SOL.base1;
        return (
          <g key={i}>
            <g className="bj-rise" style={t(at + i * 0.08)}>
              <rect x={x} y={y} width={W} height={46} rx={6} fill={SOL.base3} stroke={color} strokeWidth={busy ? 1.5 : 1} />
              <text x={x + 10} y={y + 18} fontSize="11" fontWeight={700} fill={SOL.base02}>{s.name}</text>
              {busy && <circle cx={x + W - 12} cy={y + 14} r={3.5} fill={SOL.orange} className="bj-pulse" />}
              <text x={x + 10} y={y + 35} fontSize="9.5" fill={busy ? SOL.orange : SOL.base1}>{busy ? "checking" : s.note}</text>
            </g>
            {evict === i && (
              <>
                <g className="bj-pop" style={t(at + 1.2)}>
                  <rect x={x} y={y} width={W} height={46} rx={6} fill={SOL.base3} stroke={SOL.red} strokeWidth={1.6} />
                  <path d={`M${x + 8} ${y + 8}L${x + W - 8} ${y + 38}`} stroke={SOL.red} strokeWidth={1.4} />
                </g>
                <g className="bj-pop" style={t(at + 1.8)}>
                  <rect x={x + 6} y={y + 6} width={W - 12} height={34} rx={5} fill={SOL.base3} stroke={SOL.green} strokeWidth={1.6} />
                  <text x={x + W / 2} y={y + 27} fontSize="11" fontWeight={700} textAnchor="middle" fill={SOL.green}>docs</text>
                </g>
              </>
            )}
          </g>
        );
      })}
    </g>
  );
}

/** At most six watchers: a seventh takes the slot asked least recently, or waits its turn when every slot is busy. */
export function SlotsFigure() {
  return (
    <Stage minWidth={720}>
      <svg viewBox="0 0 760 300" className="w-full block font-mono" role="img" aria-label="With six watchers running, a seventh ask stops the one asked least recently; when every watcher holds a pass someone waits on, the ask queues">
        <Dots id="sl-grid" w={760} h={300} />
        <text x={16} y={28} fontSize="11.5" fontWeight={700} fill={SOL.base02}>A seventh program is asked for</text>

        <g className="bj-rise" style={t(0.2)}>
          <rect x={16} y={52} width={84} height={46} rx={6} fill={SOL.base03} />
          <text x={58} y={72} fontSize="10.5" textAnchor="middle" fill={SOL.base3}>cast check</text>
          <text x={58} y={88} fontSize="10.5" textAnchor="middle" fill={SOL.green}>docs</text>
        </g>
        <SlotRow y={52} slots={CASE_A} evict={2} at={0.3} />
        <text x={116} y={122} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(1.6)}>
          the idle watcher asked least recently stops, and the ask says which
        </text>

        <g className="bj-rise" style={t(2.6)}>
          <rect x={16} y={160} width={84} height={46} rx={6} fill={SOL.base03} />
          <text x={58} y={180} fontSize="10.5" textAnchor="middle" fill={SOL.base3}>cast check</text>
          <text x={58} y={196} fontSize="10.5" textAnchor="middle" fill={SOL.yellow}>docs</text>
        </g>
        <SlotRow y={160} slots={CASE_B} evict={null} at={2.7} />
        <g className="bj-rise" style={t(3.6)}>
          <rect x={16} y={232} width={728} height={26} rx={5} fill={`${SOL.yellow}14`} stroke={SOL.yellow} strokeDasharray="4 3" />
          <text x={28} y={249} fontSize="10.5" fill={SOL.base02}>
            <tspan fill={SOL.yellow} fontWeight={700}>queued</tspan>: all 6 slots hold passes someone is waiting on; starting when one finishes
          </text>
        </g>
        <text x={16} y={284} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(4.0)}>
          Separately, a watcher nobody asks for 45 minutes exits on its own. A pass in flight never counts as idle.
        </text>
      </svg>
    </Stage>
  );
}
