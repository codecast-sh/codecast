"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Arrow, Box, Sheet } from "../figureParts";

/**
 * Figures for the messaging guide: one exchange between two sessions, the
 * path a message takes to land, and the inbox gestures.
 */

// ─── An exchange ───────────────────────────────────────────────────────────

const STEPS = [
  { from: 0, to: 1, at: 0.4, cmd: 'cast send jx7w9hk "API is on /v2/hooks/retry"', env: '<session-message from="jx7d2ui">' },
  { from: 1, to: 0, at: 2.2, cmd: 'cast send jx7d2ui "Retry states are in"', env: '<session-message from="jx7w9hk">' },
];

/** Each side sends with one command and receives the other's text as a new
 *  turn, wrapped in an envelope that names the sender. */
export function ExchangeFigure() {
  const LX = [150, 610];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={300} label="Session jx7d2ui sends a message to jx7w9hk, which receives it in a session-message envelope and replies with its own cast send">
        {(arrow) => (
          <>
            {[
              { id: "jx7d2ui", title: "Dashboard retry UI" },
              { id: "jx7w9hk", title: "Webhook API half" },
            ].map((s, i) => (
              <g key={s.id}>
                <Box x={LX[i] - 90} y={18} w={180} h={46} title={s.id} sub={s.title} at={0.1 + i * 0.1} bold={1} size={11.5} />
                <line x1={LX[i]} x2={LX[i]} y1={66} y2={286} stroke={SOL.base1} strokeDasharray="3 4" className="bj-fade" style={t(0.2)} />
              </g>
            ))}
            {STEPS.map((st, i) => {
              const y = 100 + i * 100;
              const x1 = LX[st.from];
              const x2 = LX[st.to];
              const dir = x2 > x1 ? 1 : -1;
              return (
                <g key={i}>
                  <g className="bj-rise" style={t(st.at)}>
                    <rect x={x1 - (dir > 0 ? 6 : 286)} y={y - 22} width={292} height={20} rx={4} fill={SOL.base03} />
                    <text x={x1 - (dir > 0 ? 0 : 280)} y={y - 8} fontSize="9.5" fill={SOL.base2}>{st.cmd}</text>
                  </g>
                  <Arrow head={arrow()} d={`M${x1 + dir * 4} ${y + 6}H${x2 - dir * 8}`} at={st.at + 0.4} color={SOL.cyan} dur={0.6} />
                  <g className="bj-rise" style={t(st.at + 1.0)}>
                    <rect x={x2 + (dir > 0 ? -300 : 8)} y={y + 16} width={292} height={36} rx={4} fill={`${SOL.cyan}14`} stroke={`${SOL.cyan}66`} />
                    <text x={x2 + (dir > 0 ? -294 : 14)} y={y + 31} fontSize="9.5" fill={SOL.cyan}>{st.env}</text>
                    <text x={x2 + (dir > 0 ? -294 : 14)} y={y + 45} fontSize="9.5" fill={SOL.base01}>arrives as a new turn</text>
                  </g>
                </g>
              );
            })}
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Delivery ──────────────────────────────────────────────────────────────

/** A send is queued, claimed by the daemon that owns the target, pasted in,
 *  and counted delivered only when the text shows up in the transcript. */
export function DeliveryFigure() {
  const W = 760;
  const H = 330;
  const ST = [
    { x: 160, label: "pending", sub: "queued in codecast", color: SOL.yellow },
    { x: 360, label: "injected", sub: "daemon pasted it in", color: SOL.blue },
    { x: 560, label: "delivered", sub: "seen in the transcript", color: SOL.green },
  ];
  return (
    <Stage minWidth={680}>
      <Sheet w={W} h={H} label="A message goes from pending to injected to delivered; a healer returns stuck or failed messages to pending; a send to a stale or killed session is refused unless --wake">
        {(arrow) => (
          <>

            <Box x={14} y={86} w={110} h={46} title="cast send" sub="" at={0.1} dark bold={1} size={11.5} />
            <Arrow head={arrow()} d="M126 109H152" at={0.35} />
            {ST.map((s, i) => (
              <g key={s.label}>
                <g className="bj-pop" style={t(0.5 + i * 0.55)}>
                  <rect x={s.x} y={84} width={150} height={50} rx={25} fill={`${s.color}1f`} stroke={s.color} strokeWidth={1.6} />
                  <text x={s.x + 75} y={106} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>{s.label}</text>
                  <text x={s.x + 75} y={122} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{s.sub}</text>
                </g>
                {i < 2 && <Arrow head={arrow()} d={`M${s.x + 152} 109H${ST[i + 1].x - 6}`} at={0.8 + i * 0.55} />}
              </g>
            ))}
            <text x={335} y={74} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.0)}>the target's daemon claims it</text>
            <text x={535} y={74} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.6)}>its words appear</text>

            <g className="bj-fade" style={t(1.3)}>
              <text x={450} y={156} fontSize="10" fill={SOL.blue}>
                <tspan x={450}>running: pasted into its terminal</tspan>
                <tspan x={450} dy={14}>not running: resumed first</tspan>
              </text>
            </g>

            <path d="M390 136C390 205 235 205 235 140" stroke={SOL.orange} strokeWidth={1.4} strokeDasharray="4 3" fill="none" markerEnd={arrow()} className="bj-fade" style={t(2.2)} />
            <text x={160} y={222} fontSize="10" fontWeight={700} fill={SOL.orange} className="bj-fade" style={t(2.4)}>no confirmation in 2 minutes, or a failed paste</text>
            <text x={160} y={236} fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(2.4)}>a healer puts it back in the queue; there is no retry cap</text>

            <g className="bj-fade" style={t(2.8)}>
              <line x1={14} x2={746} y1={252} y2={252} stroke={SOL.base2} />
              <circle cx={26} cy={276} r={8} fill={SOL.red} />
              <path d="M22 272l8 8M30 272l-8 8" stroke={SOL.base3} strokeWidth={1.6} strokeLinecap="round" />
              <text x={42} y={273} fontSize="10.5" fontWeight={700} fill={SOL.red}>Not sent</text>
              <text x={110} y={273} fontSize="10" fill={SOL.base01}>a target that was killed, or idle past its prompt cache, refuses a plain send:</text>
              <text x={110} y={289} fontSize="10" fill={SOL.base01}>waking it reloads its whole context. Pass --wake to send anyway. A worker reporting</text>
              <text x={110} y={305} fontSize="10" fill={SOL.base01}>to the session that started it, or a session that declared itself dormant, is always woken.</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── The inbox gestures ────────────────────────────────────────────────────

/** Where a session sits in the human's inbox, and what moves it. */
export function InboxGesturesFigure() {
  const node = (x: number, y: number, w: number, title: string, sub: string, color: string, at: number) => (
    <g className="bj-pop" style={t(at)}>
      <rect x={x} y={y} width={w} height={54} rx={10} fill={`${color}14`} stroke={color} strokeWidth={1.5} />
      <text x={x + w / 2} y={y + 22} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>{title}</text>
      <text x={x + w / 2} y={y + 39} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{sub}</text>
    </g>
  );
  const label = (x: number, y: number, text: string, color: string, at: number, anchor: "start" | "middle" | "end" = "middle") => (
    <text x={x} y={y} textAnchor={anchor} fontSize="10" fill={color} stroke={SOL.base3} strokeWidth={4} paintOrder="stroke" className="bj-fade" style={t(at)}>{text}</text>
  );
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={300} label="Stash moves a session out of the inbox while it keeps running; a trigger brings a plain stash back; a hidden stash returns only for an ask; kill tears it down; restore brings it back">
        {(arrow) => (
          <>
            {node(300, 20, 160, "inbox", "the human sees it", SOL.blue, 0.1)}
            {node(30, 150, 210, "stashed", "agent keeps running", SOL.cyan, 0.5)}
            {node(275, 150, 210, "stashed --hide", "agent keeps running", SOL.violet, 0.8)}
            {node(520, 150, 210, "killed", "torn down, triggers off", SOL.red, 1.1)}

            <Arrow head={arrow()} d="M298 56C200 60 170 100 165 144" at={0.6} />
            {label(198, 112, "cast stash", SOL.base02, 0.7, "start")}
            <Arrow head={arrow()} d="M365 78V144" at={0.9} />
            {label(358, 116, "--hide", SOL.base02, 1.0, "end")}
            <Arrow head={arrow()} d="M462 56C560 60 590 100 595 144" at={1.2} />
            {label(562, 112, "cast kill", SOL.base02, 1.3, "end")}

            <Arrow head={arrow()} d="M90 148C90 80 180 36 296 34" at={1.6} color={SOL.cyan} dashed />
            <Arrow head={arrow()} d="M400 148V82" at={1.9} color={SOL.violet} dashed />
            <Arrow head={arrow()} d="M680 148C680 80 580 36 464 34" at={2.2} color={SOL.base1} dashed />

            {[
              { x: 135, color: SOL.cyan, lines: ["back on: a trigger fires,", "or it asks for a person"] },
              { x: 380, color: SOL.violet, lines: ["back only on an ask: blocked,", "--needs-attention, a stall"] },
              { x: 625, color: SOL.base01, lines: ["back on: cast restore", "(card only, no relaunch)"] },
            ].map((c, i) => (
              <text key={i} x={c.x} y={226} textAnchor="middle" fontSize="10" fill={c.color} className="bj-fade" style={t(1.7 + i * 0.3)}>
                <tspan x={c.x}>{c.lines[0]}</tspan>
                <tspan x={c.x} dy={14}>{c.lines[1]}</tspan>
              </text>
            ))}
            {label(380, 284, "dashed: what brings a session back to the inbox", SOL.base1, 2.6)}
          </>
        )}
      </Sheet>
    </Stage>
  );
}
