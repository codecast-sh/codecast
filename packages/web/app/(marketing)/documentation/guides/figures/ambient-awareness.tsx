"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Sheet } from "../figureParts";

/** Figure for the ambient awareness guide: which sessions a new session starts knowing about. */

// ─── Which sessions make the feed ──────────────────────────────────────────

/** Days ago (0 = now) of each recent session in the project. */
const SESSIONS: number[] = [0.2, 0.6, 1.0, 1.4, 1.9, 2.4, 2.9, 3.4, 4.0, 4.6, 5.2, 5.8, 6.5, 7.6, 8.3, 9.1, 10.4, 11.2, 12.6, 13.5];

function Window({ days, limit, y, color, title, sub, base, exclude }: {
  days: number; limit: number; y: number; color: string; title: string; sub: string; base: number; exclude?: number;
}) {
  const X0 = 40;
  const PX = 47;
  const x = (d: number) => X0 + (14 - d) * PX;
  let kept = 0;
  return (
    <g>
      <text x={X0 - 20} y={y - 26} fontSize="11.5" fontWeight={700} fill={color} className="bj-fade" style={t(base)}>{title}</text>
      <text x={X0 + 190} y={y - 26} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(base)}>{sub}</text>
      <rect x={x(days)} y={y - 14} width={days * PX} height={28} rx={5} fill={`${color}14`} stroke={color} strokeDasharray="3 3" className="bj-fade" style={t(base + 0.1)} />
      {SESSIONS.map((d, i) => {
        const inWindow = d <= days;
        const excluded = exclude === i;
        const take = inWindow && !excluded && kept < limit;
        if (take) kept++;
        return (
          <g key={i} className="bj-pop" style={t(base + 0.2 + i * 0.04)}>
            <circle cx={x(d)} cy={y} r={5} fill={take ? color : SOL.base3} stroke={take ? color : SOL.base1} strokeOpacity={inWindow ? 1 : 0.4} />
            {excluded && <path d={`M${x(d) - 6} ${y - 6}l12 12M${x(d) + 6} ${y - 6}l-12 12`} stroke={SOL.red} strokeWidth={1.6} />}
          </g>
        );
      })}
    </g>
  );
}

/** Both modes read the same sessions; the window and the cap differ. An
 *  excluded session does not shrink the feed: the next one takes its place. */
export function FeedWindowFigure() {
  const X0 = 40;
  const PX = 47;
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={290} label="Solo mode keeps up to 10 sessions from the last 7 days, team mode up to 15 from the last 14 days; an excluded session is replaced by the next one">
        {[14, 10, 7, 3, 0].map((d) => (
          <g key={d}>
            <line x1={X0 + (14 - d) * PX} x2={X0 + (14 - d) * PX} y1={36} y2={244} stroke={SOL.base2} />
            <text x={X0 + (14 - d) * PX} y={262} textAnchor="middle" fontSize="10" fill={SOL.base1}>{d === 0 ? "now" : `${d}d ago`}</text>
          </g>
        ))}
        <Window days={7} limit={10} y={80} color={SOL.blue} title="solo" sub="last 7 days, up to 10 sessions" base={0.2} />
        <Window days={14} limit={15} y={150} color={SOL.cyan} title="team" sub="last 14 days, up to 15 sessions" base={1.2} />
        <Window days={14} limit={15} y={220} color={SOL.violet} title="team, one excluded" sub="the 16th session moves up" base={2.2} exclude={4} />
        <text x={20} y={284} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.2)}>filled: in the feed  ·  hollow: outside the window or past the cap  ·  the same project's sessions in every row</text>
      </Sheet>
    </Stage>
  );
}
