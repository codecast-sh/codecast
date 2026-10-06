"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Sheet } from "../figureParts";

/**
 * Figures for the usage limits guide: from the banner to a continued
 * session under each recovery mode, how switch candidates are ranked, and why
 * resumes go out a few at a time.
 */

// ─── From banner to continue ───────────────────────────────────────────────

const MODES = [
  { mode: "ask", act: "proposes the roomiest account,", act2: "waits for approval; or the reset", color: SOL.yellow },
  { mode: "auto", act: "moves the machine to it,", act2: "now", color: SOL.cyan },
  { mode: "resume", act: "never changes accounts,", act2: "waits for the reset", color: SOL.blue },
  { mode: "off", act: "does nothing;", act2: "a person continues it", color: SOL.base1 },
];

/** The daemon reads the banner, the server parks the row, and the machine's mode decides how it ends. */
export function RecoveryFigure() {
  const modeY = (i: number) => 66 + i * 56;
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={300} label="A limit banner is classified by the daemon, the conversation row is marked parked, and the recovery check acts by mode; every path except off ends with continue sent to the session">
        {(arrow) => (
          <>
            <g className="bj-pop" style={t(0.2)}>
              <rect x={16} y={52} width={168} height={64} rx={7} fill={SOL.base03} />
              <text x={28} y={72} fontSize="10" fill={SOL.base1}>the pane prints</text>
              <text x={28} y={90} fontSize="10.5" fill={SOL.orange}>You've hit your session</text>
              <text x={28} y={104} fontSize="10.5" fill={SOL.orange}>limit · resets 11:30pm</text>
            </g>
            <path d="M100 118V150" pathLength={1} stroke={SOL.base1} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(0.5, 0.25)} />
            <g className="bj-rise" style={t(0.7)}>
              <rect x={16} y={154} width={168} height={52} rx={7} fill={SOL.base3} stroke={SOL.base1} />
              <text x={28} y={174} fontSize="11" fontWeight={700} fill={SOL.base02}>daemon classifies</text>
              <text x={28} y={192} fontSize="10" fill={SOL.base01}>limit, or throttle</text>
            </g>
            <text x={28} y={226} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(0.9)}>
              <tspan x={28}>throttle: too many requests</tspan>
              <tspan x={28} dy={12}>a minute, its own path</tspan>
            </text>
            <path d="M186 180H222" pathLength={1} stroke={SOL.base1} strokeWidth={1.3} markerEnd={arrow()} className="bj-draw" style={t(1.0, 0.2)} />
            <g className="bj-rise" style={t(1.2)}>
              <rect x={226} y={128} width={188} height={104} rx={7} fill={SOL.base3} stroke={SOL.yellow} strokeWidth={1.4} />
              <text x={238} y={148} fontSize="11" fontWeight={700} fill={SOL.base02}>the row is parked</text>
              <text x={238} y={168} fontSize="9.5" fill={SOL.base01}>pending_api_error</text>
              <text x={238} y={182} fontSize="9.5" fill={SOL.base01}>pending_api_error_kind: limit</text>
              <text x={238} y={196} fontSize="9.5" fill={SOL.base01}>pending_api_error_at</text>
              <text x={238} y={220} fontSize="10" fill={SOL.yellow}>schedules the recovery check</text>
            </g>
            {MODES.map((m, i) => {
              const y = modeY(i);
              const at = 1.7 + i * 0.3;
              return (
                <g key={m.mode}>
                  <path d={`M416 180C450 180 450 ${y} 486 ${y}`} pathLength={1} fill="none" stroke={m.color} strokeWidth={1.3} className="bj-draw" style={t(at, 0.35)} />
                  <g className="bj-rise" style={t(at + 0.2)}>
                    <rect x={488} y={y - 20} width={58} height={22} rx={11} fill={`${m.color}22`} stroke={m.color} />
                    <text x={517} y={y - 5} fontSize="10.5" textAnchor="middle" fill={SOL.base02}>{m.mode}</text>
                    <text x={556} y={y - 9} fontSize="10" fill={SOL.base02}>{m.act}</text>
                    <text x={556} y={y + 5} fontSize="10" fill={SOL.base01}>{m.act2}</text>
                  </g>
                </g>
              );
            })}
            <g className="bj-pop" style={t(3.2)}>
              <rect x={540} y={268} width={204} height={26} rx={6} fill={SOL.base03} />
              <text x={552} y={285} fontSize="10.5" fill={SOL.green}>→ "continue" to each session</text>
            </g>
            <text x={500} y={285} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(3.2)}>then</text>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Ranking switch candidates ─────────────────────────────────────────────

type Acct = { name: string; session: number; week: number; out?: string; credits?: boolean };

const ACCOUNTS: Acct[] = [
  { name: "work", session: 100, week: 64, out: "the account in use" },
  { name: "personal", session: 34, week: 61 },
  { name: "side", session: 12, week: 22 },
  { name: "team", session: 40, week: 100, out: "a window at 100%" },
  { name: "old", session: 5, week: 9, out: "login expired, no token" },
  { name: "spare", session: 92, week: 70, credits: true },
];
const RANKED = ["side", "personal", "spare"];

/** Filter out what cannot carry a session, then rank by each account's highest window, lowest first. */
export function CandidatesFigure() {
  const rowY = (i: number) => 58 + i * 34;
  const BAR = 120;
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={300} label="Six saved accounts: three are ruled out, and the rest rank by their highest window, with an account on usage credits last">
        <g fontSize="10" fill={SOL.base1}>
          <text x={20} y={34}>profile</text>
          <text x={96} y={34}>Session (5h)</text>
          <text x={260} y={34}>Week (7d)</text>
          <text x={566} y={34}>ranked</text>
        </g>
        {ACCOUNTS.map((a, i) => {
          const y = rowY(i);
          const out = !!a.out;
          const at = 0.2 + i * 0.12;
          const bar = (x: number, p: number, d: number) => (
            <g>
              <rect x={x} y={y - 9} width={BAR} height={10} rx={2} fill={SOL.base2} />
              <rect x={x} y={y - 9} width={(BAR * p) / 100} height={10} rx={2} fill={p >= 100 ? SOL.red : p >= 85 ? SOL.yellow : SOL.green} opacity={0.85} className="bj-grow" style={t(at + d, 0.5)} />
              <text x={x + BAR + 6} y={y} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(at + d + 0.4)}>{`${p}%`}</text>
            </g>
          );
          return (
            <g key={a.name}>
              <text x={20} y={y} fontSize="11" fontWeight={700} fill={SOL.base02}>{a.name}</text>
              {bar(96, a.session, 0)}
              {bar(260, a.week, 0.1)}
              {out && (
                <g className="bj-fade" style={t(1.6 + i * 0.1)}>
                  <line x1={16} x2={416} y1={y - 4} y2={y - 4} stroke={SOL.red} strokeWidth={1.2} opacity={0.7} />
                  <text x={424} y={y} fontSize="9.5" fill={SOL.red}>{a.out}</text>
                </g>
              )}
              {a.credits && (
                <text x={424} y={y} fontSize="9.5" fill={SOL.yellow} className="bj-fade" style={t(1.9)}>credits on: ranks last</text>
              )}
            </g>
          );
        })}
        {RANKED.map((name, r) => {
          const a = ACCOUNTS.find((x) => x.name === name)!;
          const from = rowY(ACCOUNTS.indexOf(a));
          const y = 70 + r * 52;
          const at = 2.4 + r * 0.35;
          return (
            <g key={name}>
              <path d={`M${a.credits ? 556 : 420} ${from - 4}C${a.credits ? 562 : 500} ${from - 4} 520 ${y} 564 ${y}`} pathLength={1} fill="none" stroke={r === 0 ? SOL.green : SOL.base1} strokeOpacity={0.7} strokeWidth={1.2} className="bj-draw" style={t(at, 0.35)} />
              <g className="bj-pop" style={t(at + 0.3)}>
                <rect x={566} y={y - 18} width={174} height={34} rx={6} fill={r === 0 ? `${SOL.green}18` : SOL.base3} stroke={r === 0 ? SOL.green : SOL.base1} strokeWidth={r === 0 ? 1.6 : 1} />
                <text x={578} y={y + 4} fontSize="11" fontWeight={700} fill={SOL.base02}>{`${r + 1}. ${a.name}`}</text>
                <text x={730} y={y + 4} fontSize="10" textAnchor="end" fill={SOL.base01}>{`highest ${Math.max(a.session, a.week)}%`}</text>
              </g>
            </g>
          );
        })}
        <text x={20} y={272} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.6)}>
          <tspan x={20}>An account already tried since the newest park is left out too.</tspan>
          <tspan x={20} dy={14}>A window that reset since the last reading is unmeasured, and ranks behind known numbers.</tspan>
        </text>
      </Sheet>
    </Stage>
  );
}

// ─── Paced resumes ─────────────────────────────────────────────────────────

/** Nine parked sessions: all at once trips the rate limit; three a pass, 20 s apart, does not. */
export function PacedResumeFigure() {
  const X0 = 120;
  const PX = 4.2; // px per second
  const SEC = 0.03;
  const x = (s: number) => X0 + s * PX;
  const passes = [0, 60, 120];
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={270} label="Nine resumes in one burst draw a rate limit that reads like a usage limit; paced at three per pass, twenty seconds apart, they do not">
        {[0, 30, 60, 90, 120].map((s) => (
          <g key={s}>
            <line x1={x(s)} x2={x(s)} y1={34} y2={196} stroke={SOL.base2} />
            <text x={x(s)} y={212} fontSize="9.5" textAnchor="middle" fill={SOL.base1}>{`${s} s`}</text>
          </g>
        ))}

        <text x={16} y={30} fontSize="11.5" fontWeight={700} fill={SOL.base02}>All at once</text>
        <text x={16} y={70} fontSize="10" fill={SOL.base01}>9 resumes</text>
        {Array.from({ length: 9 }, (_, i) => (
          <rect key={i} x={x(0) + i * 2.4} y={50 + i * 3} width={36} height={6} rx={2} fill={SOL.orange} className="bj-grow" style={t(0.2 + i * 0.03, 0.3)} />
        ))}
        <g className="bj-pop" style={t(0.9)}>
          <rect x={x(14)} y={50} width={276} height={36} rx={6} fill={`${SOL.red}14`} stroke={SOL.red} />
          <text x={x(14) + 10} y={65} fontSize="10" fill={SOL.red}>each first request carries its whole</text>
          <text x={x(14) + 10} y={79} fontSize="10" fill={SOL.red}>context: a rate limit that reads as a limit</text>
        </g>
        <text x={x(14) + 288} y={64} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.2)}>
          <tspan x={x(14) + 288}>2026-09-17: one machine</tspan>
          <tspan x={x(14) + 288} dy={12}>moved its login 5 times</tspan>
        </text>

        <text x={16} y={120} fontSize="11.5" fontWeight={700} fill={SOL.base02}>Paced</text>
        <text x={16} y={160} fontSize="10" fill={SOL.base01}>3 a pass</text>
        {passes.map((p, pi) => (
          <g key={p}>
            {[0, 20, 40].map((d, i) => (
              <g key={d}>
                <rect x={x(p + d)} y={140 + i * 12} width={36} height={8} rx={2} fill={SOL.green} className="bj-grow" style={t(1.6 + (p + d) * SEC, 0.3)} />
              </g>
            ))}
            <text x={x(p) + 2} y={190} fontSize="9.5" fill={SOL.green} className="bj-fade" style={t(1.6 + p * SEC)}>{`pass ${pi + 1}`}</text>
          </g>
        ))}
        <text x={x(20) + 40} y={134} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.8)}>20 s apart</text>
        <text x={16} y={244} fontSize="10" fill={SOL.base01} className="bj-fade" style={t(3.2)}>
          A pass resumes at most 3 sessions, 20 s apart, and leaves the rest for the next pass.
        </text>
        <text x={16} y={258} fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(3.3)}>
          The spacing between passes is drawn evenly here; the real cadence is the recovery check's.
        </text>
      </Sheet>
    </Stage>
  );
}
