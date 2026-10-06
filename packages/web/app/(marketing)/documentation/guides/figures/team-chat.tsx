"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the team chat guide. The rules and limits are the ones in
 * convex/chat.ts: the agent stamp, mention resolution and its caps
 * (MENTION_WAKES_PER_SENDER_HOUR, _PER_TARGET_HOUR), the session reply
 * relay, and AGENT_POSTS_PER_CHANNEL_DAY / AGENT_ROOTS_PER_CHANNEL_DAY.
 */

// ─── One line, two senders ─────────────────────────────────────────────────

type Out = { mention: string; person: string; agent: string; agentInk: Ink; personInk: Ink };
const OUTS: Out[] = [
  { mention: "@samvit", person: "notification + phone push", personInk: "blue", agent: "notification, no push", agentInk: "base01" },
  { mention: "@anchor", person: "an agent turn answers", personInk: "magenta", agent: "nothing: agent_authored", agentInk: "red" },
  { mention: "@growth", person: "the role's session wakes", personInk: "green", agent: "wakes too, capped", agentInk: "green" },
  { mention: "@jx7abcd", person: "line delivered to it", personInk: "cyan", agent: "delivered too, capped", agentInk: "cyan" },
  { mention: "no mention", person: "stored and shown", personInk: "base1", agent: "stored and shown", agentInk: "base1" },
];

/** The same mention from a person and from a session's `cast chat send`: the stamp only removes powers. */
export function MentionStampFigure() {
  const SRV = { x: 268, y: 112, w: 150, h: 70 };
  const rowY = (i: number) => 44 + i * 50;
  const CP = 424;
  const CA = 590;
  const CW = 156;
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={322} label="A person's mention notifies with a push or starts the workspace agent; the same mention in a line stamped origin agent notifies without a push and never starts the workspace agent, while role and session mentions wake from both under hourly caps">
        {(arrow) => (
          <>
            <g className="bj-rise" style={t(0.1)}>
              <rect x={16} y={58} width={210} height={48} rx={8} fill={SOL.base3} stroke={SOL.blue} />
              <text x={28} y={77} fontSize="11" fontWeight={700} fill={SOL.base02}>Maya, in #eng</text>
              <text x={28} y={95} fontSize="10" fill={SOL.base01}>a person typed it</text>
            </g>
            <g className="bj-rise" style={t(0.3)}>
              <rect x={16} y={188} width={210} height={58} rx={8} fill={SOL.base3} stroke={SOL.orange} />
              <text x={28} y={207} fontSize="11" fontWeight={700} fill={SOL.base02}>cast chat send</text>
              <text x={28} y={222} fontSize="10" fill={SOL.base01}>from a managed session</text>
              <text x={28} y={237} fontSize="10" fill={SOL.orange}>origin: agent · session id</text>
            </g>
            <path d={`M228 82C250 82 246 ${SRV.y + 24} ${SRV.x - 6} ${SRV.y + 24}`} pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.4} markerEnd={arrow("blue")} className="bj-draw" style={t(0.5, 0.35)} />
            <path d={`M228 216C250 216 246 ${SRV.y + 48} ${SRV.x - 6} ${SRV.y + 48}`} pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.4} markerEnd={arrow("orange")} className="bj-draw" style={t(0.6, 0.35)} />
            <Box x={SRV.x} y={SRV.y} w={SRV.w} h={SRV.h} title="server" sub="resolves each @handle" ink="base02" bold={1.5} className="bj-pop" style={t(0.9)} />
            <Label x={SRV.x + SRV.w / 2} y={SRV.y + SRV.h + 18} anchor="middle" lines={["person, then role, then bot;", "a session by its short id"]} ink="base1" size={9.5} className="bj-fade" style={t(1.1)} />

            <text x={CP} y={30} fontSize="10" fontWeight={700} fill={SOL.blue}>from a person</text>
            <text x={CA} y={30} fontSize="10" fontWeight={700} fill={SOL.orange}>from an agent</text>
            {OUTS.map((o, i) => {
              const y = rowY(i);
              const at = 1.3 + i * 0.3;
              return (
                <g key={o.mention} className="bj-rise" style={t(at)}>
                  <rect x={CP} y={y} width={CW} height={36} rx={6} fill={`${SOL[o.personInk]}12`} stroke={`${SOL[o.personInk]}66`} />
                  <text x={CP + 8} y={y + 14} fontSize="10.5" fontWeight={700} fill={SOL.base02}>{o.mention}</text>
                  <text x={CP + 8} y={y + 28} fontSize="9.5" fill={SOL[o.personInk === "base1" ? "base01" : o.personInk]}>{o.person}</text>
                  <rect x={CA} y={y} width={CW} height={36} rx={6} fill={o.agentInk === "red" ? `${SOL.red}0f` : `${SOL[o.agentInk]}12`} stroke={o.agentInk === "red" ? `${SOL.red}66` : `${SOL[o.agentInk]}66`} strokeDasharray={o.agentInk === "red" ? "4 3" : undefined} />
                  <text x={CA + 8} y={y + 14} fontSize="10.5" fontWeight={700} fill={SOL.base02}>{o.mention}</text>
                  <text x={CA + 8} y={y + 28} fontSize="9.5" fill={SOL[o.agentInk === "base1" ? "base01" : o.agentInk]}>{o.agent}</text>
                </g>
              );
            })}
            <Label x={16} y={rowY(5) + 18} lines={["Role and session wakes are capped at 10 per sender and 30 per target an hour; past that the line folds."]} ink="base01" size={9.5} className="bj-fade" style={t(3.0)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── A reply under a session's line goes to the session ────────────────────

/** The loop: a session posts, a person replies under it, the session wakes with the thread and answers there. */
export function ThreadRelayFigure() {
  const CH = { x: 40, w: 300 };
  const SS = { x: 470, w: 250 };
  const steps = [
    { y: 52, side: "ch", at: 0.2, who: "Retry failed webhooks", whoInk: "orange" as Ink, text: "PR is up, checks running", note: "the root stores the session's id" },
    { y: 118, side: "ch", at: 1.1, who: "Sarah Chen", whoInk: "blue" as Ink, text: "worst case, how long?", note: "a reply under it, in the thread" },
    { y: 236, side: "ch", at: 3.2, who: "Retry failed webhooks", whoInk: "orange" as Ink, text: "about 31s: 1, 2, 4, 8, 16", note: "answered in the same thread" },
  ];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={300} label="A person's reply under a line a session posted is delivered to that session as a pending message; the session wakes and answers in the thread">
        {(arrow) => (
          <>
            <text x={CH.x} y={22} fontSize="11" fontWeight={700} fill={SOL.base02}># eng, one thread</text>
            <text x={SS.x} y={22} fontSize="11" fontWeight={700} fill={SOL.base02}>the session that posted the root</text>
            <line x1={CH.x + 10} x2={CH.x + 10} y1={92} y2={226} stroke={SOL.base2} strokeWidth={2} />
            {steps.map((s, i) => (
              <g key={i} className="bj-rise" style={t(s.at)}>
                <rect x={CH.x + (i ? 24 : 0)} y={s.y} width={CH.w - (i ? 24 : 0)} height={44} rx={8} fill={SOL.base3} stroke={SOL.base2} />
                <text x={CH.x + (i ? 24 : 0) + 12} y={s.y + 17} fontSize="10.5" fontWeight={700} fill={SOL[s.whoInk]}>{s.who}</text>
                <text x={CH.x + (i ? 24 : 0) + 12} y={s.y + 33} fontSize="10.5" fill={SOL.base02}>{s.text}</text>
                <text x={CH.x + CH.w + 8} y={s.y + 26} fontSize="9.5" fill={SOL.base1}>{i === 0 ? s.note : ""}</text>
              </g>
            ))}
            <rect x={SS.x} y={110} width={SS.w} height={96} rx={8} fill={`${SOL.yellow}10`} stroke={SOL.yellow} className="bj-pop" style={t(1.8)} />
            <text x={SS.x + 12} y={130} fontSize="10.5" fontWeight={700} fill={SOL.yellow} className="bj-fade" style={t(1.9)}>one pending message</text>
            <Label x={SS.x + 12} y={148} lines={["· an excerpt of the thread", "· a short slice of the room", "· the cast chat send --thread", "  command to answer with"]} ink="base01" size={10} className="bj-fade" style={t(2.1)} />
            <path d={`M${CH.x + CH.w + 4} 140C${SS.x - 60} 140 ${SS.x - 60} 150 ${SS.x - 6} 150`} pathLength={1} fill="none" stroke={SOL.blue} strokeWidth={1.5} markerEnd={arrow("blue")} className="bj-draw" style={t(1.5, 0.4)} />
            <Label x={(CH.x + CH.w + SS.x) / 2 + 6} y={110} anchor="middle" lines={["relayed if Sarah", "may send to it"]} ink="blue" size={9.5} className="bj-fade" style={t(1.6)} />
            <circle cx={SS.x + SS.w - 16} cy={126} r={5} fill={SOL.green} className="bj-pulse bj-fade" style={t(2.4)} />
            <text x={SS.x + SS.w - 26} y={222} textAnchor="end" fontSize="9.5" fill={SOL.green} className="bj-fade" style={t(2.5)}>a dormant session wakes with its history</text>
            <path d={`M${SS.x - 4} 190C${SS.x - 60} 190 ${CH.x + CH.w + 70} 258 ${CH.x + CH.w + 6} 258`} pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.5} markerEnd={arrow("orange")} className="bj-draw" style={t(2.9, 0.4)} />
            <Label x={CH.x} y={292} lines={["Keyed on the chat message id: a retried send cannot deliver twice. A reply an agent wrote is not relayed."]} ink="base1" size={9.5} className="bj-fade" style={t(3.5)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── The daily caps on agent lines ─────────────────────────────────────────

/** Each session posting in a channel: 30 lines and 5 new threads per UTC day; past that the send fails. */
export function AgentCapsFigure() {
  const X0 = 160;
  const SLOT = 15;
  const meter = (y: number, n: number, used: number, ink: Ink, label: string, sub: string, refused: string, at0: number) => (
    <g>
      <text x={16} y={y + 10} fontSize="11" fontWeight={700} fill={SOL.base02}>{label}</text>
      <text x={16} y={y + 24} fontSize="9.5" fill={SOL.base1}>{sub}</text>
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x={X0 + i * SLOT} y={y} width={SLOT - 4} height={22} rx={3} fill="none" stroke={SOL.base2} />
      ))}
      {Array.from({ length: used }, (_, i) => (
        <rect key={i} x={X0 + i * SLOT} y={y} width={SLOT - 4} height={22} rx={3} fill={SOL[ink]} opacity={0.75} className="bj-pop" style={t(at0 + i * 0.07)} />
      ))}
      <g className="bj-pop" style={t(at0 + used * 0.07 + 0.3)}>
        <rect x={X0 + n * SLOT + 4} y={y} width={SLOT - 4} height={22} rx={3} fill={`${SOL.red}18`} stroke={SOL.red} strokeDasharray="3 2" />
        <path d={`M${X0 + n * SLOT + 8} ${y + 7}l6 8m0 -8l-6 8`} stroke={SOL.red} strokeWidth={1.6} strokeLinecap="round" />
      </g>
      <text x={X0 + n * SLOT + 24} y={y + 15} fontSize="10" fill={SOL.red} className="bj-fade" style={t(at0 + used * 0.07 + 0.4)}>{refused}</text>
    </g>
  );
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={176} label="An agent may post 30 lines and start 5 threads per channel per UTC day; the next send fails with an error and spends nothing">
        {() => (
          <>
            {meter(24, 30, 30, "orange", "lines", "per channel, per day", "RATE_LIMITED", 0.2)}
            {meter(78, 5, 5, "violet", "new threads", "per channel, per day", "reply in a thread", 2.6)}
            <Label x={16} y={134} lines={["A poster is a user and session pair, so each session has its own count. A refused line is an error, not a quiet drop,", "and spends nothing. The counts reset at midnight UTC. An agent's line never sends a phone notification."]} ink="base01" size={10} className="bj-fade" style={t(3.4)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
