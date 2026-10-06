"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Arrow, Box, Sheet } from "../figureParts";

/**
 * Figures for the ambient awareness guide: how the feed reaches a new
 * session (and what happens when it can't), and which sessions it holds.
 */

// ─── One builder, several doors in ─────────────────────────────────────────

/** One builder fetches the feed and renders the block; each agent receives it
 *  its own way, and the block is recorded so the web can show it. */
export function InjectionPathsFigure() {
  const W = 760;
  const H = 320;
  return (
    <Stage minWidth={680}>
      <Sheet w={W} h={H} label="The stable context builder fetches the feed with a 15 second timeout; Claude Code receives it through a SessionStart hook, Codex through developer instructions at thread start; the block is recorded and shown as cards; on failure the session starts without it">
        {(arrow) => (
          <>

            <Box x={20} y={40} w={150} title="a session starts" sub="in ~/src/billing" at={0.15} bold={1} size={11.5} />
            <Arrow head={arrow()} d="M172 65H212" at={0.4} />
            <g className="bj-pop" style={t(0.6)}>
              <rect x={218} y={30} width={170} height={70} rx={8} fill={SOL.base03} />
              <text x={303} y={52} textAnchor="middle" fontSize="11.5" fontWeight={700} fill={SOL.base3}>the feed builder</text>
              <text x={303} y={70} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>this project, window, cap</text>
              <text x={303} y={85} textAnchor="middle" fontSize="9.5" fill={SOL.base1}>15 s timeout</text>
            </g>
            <Arrow head={arrow()} d="M390 52C420 52 420 54 450 54" at={1.0} color={SOL.cyan} />
            <Arrow head={arrow()} d="M390 78C420 78 420 118 450 118" at={1.0} color={SOL.cyan} />
            <g className="bj-rise" style={t(1.3)}>
              <rect x={456} y={32} width={284} height={46} rx={7} fill={SOL.base3} stroke={SOL.cyan} />
              <text x={468} y={51} fontSize="11" fontWeight={700} fill={SOL.base02}>Claude Code</text>
              <text x={468} y={67} fontSize="9.5" fill={SOL.base01}>SessionStart hook runs cast stable-context</text>
            </g>
            <g className="bj-rise" style={t(1.45)}>
              <rect x={456} y={96} width={284} height={46} rx={7} fill={SOL.base3} stroke={SOL.cyan} />
              <text x={468} y={115} fontSize="11" fontWeight={700} fill={SOL.base02}>Codex</text>
              <text x={468} y={131} fontSize="9.5" fill={SOL.base01}>developer instructions when its thread starts</text>
            </g>
            <text x={598} y={162} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(1.6)}>Cursor, opencode and Grok have paths of their own</text>

            <Arrow head={arrow()} d="M303 102V186" at={1.8} color={SOL.green} />
            <text x={311} y={150} fontSize="10" fill={SOL.green} className="bj-fade" style={t(1.9)}>recorded</text>
            <g className="bj-rise" style={t(2.1)}>
              <rect x={218} y={192} width={300} height={44} rx={7} fill={`${SOL.green}14`} stroke={SOL.green} />
              <text x={230} y={210} fontSize="11" fontWeight={700} fill={SOL.base02}>cards at the top of the transcript</text>
              <text x={230} y={226} fontSize="9.5" fill={SOL.base01}>what the agent saw, for a person reading later</text>
            </g>

            <g className="bj-fade" style={t(2.5)}>
              <path d="M240 102C240 180 110 180 110 259" stroke={SOL.red} strokeWidth={1.3} strokeDasharray="4 3" fill="none" />
              <circle cx={110} cy={268} r={9} fill={SOL.red} />
              <path d="M106 264l8 8M114 264l-8 8" stroke={SOL.base3} strokeWidth={1.8} strokeLinecap="round" />
              <text x={128} y={266} fontSize="10.5" fontWeight={700} fill={SOL.red}>timeout, offline, signed out</text>
              <text x={128} y={282} fontSize="10" fill={SOL.base01}>no block: the session starts as it would have without stable mode</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

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
