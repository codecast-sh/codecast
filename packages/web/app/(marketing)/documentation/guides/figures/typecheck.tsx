"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Sheet } from "../figureParts";

/** Figure for the typecheck guide: one program in memory instead of one per session. */

// ─── One program, many asks ────────────────────────────────────────────────

const SESSIONS = ["A", "B", "C", "D", "E", "F"];

/** Six sessions each building the program, against six sessions asking one watcher. */
export function SharedProgramFigure() {
  const rowY = (i: number) => 58 + i * 34;
  const RAM = 200; // px for the machine's memory
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={330} label="Six sessions each building their own typecheck push memory into swap; with Typecheck on, six sessions share one">
        {(arrow) => (
          <>
            <line x1={380} x2={380} y1={16} y2={314} stroke={SOL.base2} />

            {/* left: fresh tsc */}
            <text x={20} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>each session typechecks on its own</text>
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
            <text x={400} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>with Typecheck on</text>
            {SESSIONS.map((s, i) => (
              <g key={s}>
                <text x={400} y={rowY(i) + 14} fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(0.3)}>{`session ${s}`}</text>
                <path d={`M468 ${rowY(i) + 10}C530 ${rowY(i) + 10} 540 146 ${592} 146`} pathLength={1} fill="none" stroke={SOL.green} strokeOpacity={0.65} strokeWidth={1.2} markerEnd={arrow()} className="bj-draw" style={t(1.0 + i * 0.12, 0.45)} />
              </g>
            ))}
            <g className="bj-pop" style={t(0.5)}>
              <rect x={596} y={104} width={150} height={84} rx={8} fill={SOL.base3} stroke={SOL.green} strokeWidth={1.6} />
              <text x={671} y={126} fontSize="11.5" fontWeight={700} textAnchor="middle" fill={SOL.base02}>shared typecheck</text>
              <text x={671} y={142} fontSize="10" textAnchor="middle" fill={SOL.base01}>kept up to date</text>
              <rect x={612} y={154} width={118} height={14} rx={3} fill={SOL.orange} opacity={0.75} />
              <text x={671} y={182} fontSize="9.5" textAnchor="middle" fill={SOL.base01}>the program, held</text>
            </g>
            <rect x={496} y={264} width={RAM} height={14} rx={3} fill="none" stroke={SOL.base1} />
            <rect x={496} y={264} width={40} height={14} rx={3} fill={SOL.green} opacity={0.8} className="bj-grow" style={t(0.6, 0.6)} />
            <line x1={496 + RAM} x2={496 + RAM} y1={258} y2={284} stroke={SOL.base02} strokeWidth={1.4} />
            <text x={420} y={274} fontSize="10" fill={SOL.base1}>memory</text>
            <text x={400} y={316} fontSize="10" fill={SOL.green} className="bj-fade" style={t(2.0)}>six answers, each in seconds</text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
