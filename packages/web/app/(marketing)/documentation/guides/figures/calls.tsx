"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Box, Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the calls guide. Lease timings are CALL_HEARTBEAT_MS and
 * CALL_MEMBER_STALE_MS (shared/contracts/callRoomKeys.ts); the digest
 * threshold is SUMMARY_MIN_WORDS (convex/transcripts.ts).
 */

// ─── The scribe: one recognizer per track ──────────────────────────────────

const PEOPLE: { name: string; ink: Ink; words: string }[] = [
  { name: "Maya", ink: "magenta", words: "staging is on the new build" },
  { name: "Alex", ink: "blue", words: "retries cap at five" },
  { name: "Sarah", ink: "green", words: "five over how long?" },
];

/** Attribution comes from which track the audio arrived on, never from guessing voices. */
export function ScribeFigure() {
  const rowY = (i: number) => 36 + i * 62;
  const SC = { x: 210, y: 26, w: 150, h: 204 };
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={262} label="One client in the room is the scribe; it streams each participant's audio track to speech recognition on its own connection, so every segment carries the speaker of its track">
        {(arrow) => (
          <>
            {PEOPLE.map((p, i) => {
              const y = rowY(i);
              return (
                <g key={p.name}>
                  <g className="bj-pop" style={t(0.1 + i * 0.12)}>
                    <circle cx={40} cy={y + 18} r={16} fill={`${SOL[p.ink]}22`} stroke={SOL[p.ink]} />
                    <text x={40} y={y + 22} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL[p.ink]}>{p.name[0]}</text>
                  </g>
                  <text x={64} y={y + 15} fontSize="11" fontWeight={700} fill={SOL.base02}>{p.name}</text>
                  <text x={64} y={y + 29} fontSize="9.5" fill={SOL.base1}>{i === 0 ? "own mic: the scribe" : "a remote track"}</text>
                  <path d={`M150 ${y + 18}H${SC.x - 6}`} pathLength={1} stroke={SOL[p.ink]} strokeWidth={1.6} markerEnd={arrow(p.ink)} className="bj-draw" style={t(0.5 + i * 0.12, 0.35)} />
                  {/* the recognizer connection for this track */}
                  <path d={`M${SC.x + SC.w + 4} ${y + 18}H${SC.x + SC.w + 54}`} pathLength={1} stroke={SOL[p.ink]} strokeWidth={1.6} strokeDasharray="4 3" className="bj-draw" style={t(1.2 + i * 0.12, 0.3)} />
                  <rect x={SC.x + SC.w + 58} y={y + 6} width={70} height={24} rx={5} fill={SOL.base3} stroke={SOL[p.ink]} className="bj-pop" style={t(1.5 + i * 0.12)} />
                  <text x={SC.x + SC.w + 93} y={y + 22} textAnchor="middle" fontSize="9.5" fill={SOL.base01} className="bj-fade" style={t(1.5 + i * 0.12)}>recognizer</text>
                  <path d={`M${SC.x + SC.w + 132} ${y + 18}H${SC.x + SC.w + 158}`} pathLength={1} stroke={SOL.base1} markerEnd={arrow("base1")} className="bj-draw" style={t(1.9 + i * 0.12, 0.2)} />
                  <g className="bj-rise" style={t(2.3 + i * 0.35)}>
                    <rect x={SC.x + SC.w + 164} y={y + 2} width={226} height={32} rx={5} fill={`${SOL[p.ink]}10`} />
                    <text x={SC.x + SC.w + 172} y={y + 15} fontSize="9.5" fontWeight={700} fill={SOL[p.ink]}>{`${p.name} · seq ${14 + i}`}</text>
                    <text x={SC.x + SC.w + 172} y={y + 28} fontSize="10" fill={SOL.base02}>{p.words}</text>
                  </g>
                </g>
              );
            })}
            <g className="bj-pop" style={t(0.4)}>
              <rect x={SC.x} y={SC.y} width={SC.w} height={SC.h} rx={10} fill={SOL.base3} stroke={SOL.base02} strokeWidth={1.4} />
              <text x={SC.x + SC.w / 2} y={SC.y + SC.h - 26} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>the scribe</text>
              <text x={SC.x + SC.w / 2} y={SC.y + SC.h - 11} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>one client in the room</text>
            </g>
            {PEOPLE.map((p, i) => (
              <line key={p.name} x1={SC.x} x2={SC.x + SC.w} y1={rowY(i) + 18} y2={rowY(i) + 18} stroke={SOL[p.ink]} strokeOpacity={0.35} strokeWidth={1.6} className="bj-fade" style={t(0.9 + i * 0.12)} />
            ))}
            <Label x={744} y={252} anchor="end" lines={["each segment: seq, speaker, text, start, end"]} ink="base1" size={9.5} className="bj-fade" style={t(3.4)} />
            <Label x={16} y={252} lines={["if its seat lapses, another client adopts the run"]} ink="base01" size={9.5} className="bj-fade" style={t(3.6)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── A seat is a lease ─────────────────────────────────────────────────────

/** Heartbeats every 15 seconds; a seat older than 45 seconds is ignored by every reader. */
export function SeatLeaseFigure() {
  const X0 = 120;
  const PX = 4.6; // px per second
  const x = (s: number) => X0 + s * PX;
  const beats = [0, 15, 30, 45, 60];
  const CLOSE = 66;
  const GONE = 60 + 45;
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={200} label="A client heartbeats every 15 seconds; when the laptop closes the beats stop, and 45 seconds after the last one every reader ignores the seat">
        {() => (
          <>
            <text x={16} y={64} fontSize="11" fontWeight={700} fill={SOL.base02}>Alex's seat</text>
            <text x={16} y={78} fontSize="9.5" fill={SOL.base1}>in channel:eng</text>
            <rect x={x(0)} y={56} width={(GONE - 0) * PX} height={16} rx={4} fill={`${SOL.green}55`} className="bj-grow" style={t(0.2, 2.6)} />
            <rect x={x(60)} y={56} width={45 * PX} height={16} rx={4} fill="url(#cl-fade)" className="bj-fade" style={t(1.9)} />
            <defs>
              <linearGradient id="cl-fade" x1="0" x2="1">
                <stop offset="0" stopColor={SOL.base3} stopOpacity={0} />
                <stop offset="1" stopColor={SOL.base3} stopOpacity={0.85} />
              </linearGradient>
            </defs>
            {beats.map((b, i) => (
              <g key={b} className="bj-pop" style={t(0.3 + i * 0.4)}>
                <circle cx={x(b)} cy={64} r={4.5} fill={SOL.green} />
                <text x={x(b)} y={44} textAnchor="middle" fontSize="9.5" fill={SOL.green}>{`${b}s`}</text>
              </g>
            ))}
            <g className="bj-pop" style={t(2.0)}>
              <line x1={x(CLOSE)} x2={x(CLOSE)} y1={50} y2={90} stroke={SOL.base02} strokeWidth={1.2} />
              <text x={x(CLOSE) - 6} y={102} textAnchor="end" fontSize="10" fill={SOL.base02}>lid closes</text>
            </g>
            <path d={`M${x(60)} 138H${x(GONE)}`} stroke={SOL.base1} strokeDasharray="3 3" className="bj-fade" style={t(2.3)} />
            <Label x={(x(60) + x(GONE)) / 2} y={154} anchor="middle" lines={["45s since the last beat"]} ink="base01" size={10} className="bj-fade" style={t(2.4)} />
            <g className="bj-pop" style={t(2.9)}>
              <circle cx={x(GONE)} cy={64} r={8} fill="none" stroke={SOL.red} />
              <path d={`M${x(GONE) - 4} 60l8 8m0 -8l-8 8`} stroke={SOL.red} strokeWidth={1.6} strokeLinecap="round" />
            </g>
            <Label x={x(GONE) + 16} y={60} lines={["every reader", "ignores it"]} ink="red" size={10} className="bj-fade" style={t(3.0)} />
            <Label x={16} y={188} lines={["No step has to run for a closed laptop to leave the room; the seat simply stops counting."]} ink="base1" size={10} className="bj-fade" style={t(3.3)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Where the digest goes ─────────────────────────────────────────────────

/** When the huddle ends, the room it was held in decides where its digest lands. */
export function DigestFigure() {
  const END = { x: 24, y: 96, w: 140, h: 54 };
  const routes = [
    { y: 24, room: "channel or DM", to: "a chat message from the scribe", sub: "title, length, speakers, summary, action items", ink: "blue" as Ink },
    { y: 104, room: "session:<id>", to: "the agent wakes: <huddle-summary>", sub: "the digest and cast call <id> --transcript", ink: "orange" as Ink },
    { y: 184, room: "under 40 words", to: "no generated summary", sub: "the digest is the words themselves", ink: "base01" as Ink },
  ];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={264} label="A finished huddle's digest posts as a chat message in a channel or DM, or wakes the session's agent with a huddle summary; under 40 words the digest is the words themselves">
        {(arrow) => (
          <g transform="translate(0 14)">
            <Box x={END.x} y={END.y} w={END.w} h={END.h} title="huddle ends" sub="summary, items" ink="base02" className="bj-pop" style={t(0.1)} />
            {routes.map((r, i) => {
              const at = 0.5 + i * 0.5;
              const cy = r.y + 22;
              return (
                <g key={r.room}>
                  <path d={`M${END.x + END.w + 4} ${END.y + END.h / 2}C${END.x + END.w + 60} ${END.y + END.h / 2} ${210} ${cy} ${262} ${cy}H${364}`} pathLength={1} fill="none" stroke={SOL[r.ink]} strokeWidth={1.5} markerEnd={arrow(r.ink)} className="bj-draw" style={t(at, 0.45)} />
                  <text x={316} y={cy - 7} textAnchor="middle" fontSize="10" fontWeight={700} fill={SOL[r.ink]} className="bj-fade" style={t(at + 0.2)}>{r.room}</text>
                  <g className="bj-rise" style={t(at + 0.4)}>
                    <rect x={370} y={r.y} width={370} height={44} rx={8} fill={SOL.base3} stroke={SOL[r.ink]} strokeOpacity={0.6} />
                    <text x={382} y={r.y + 18} fontSize="11" fontWeight={700} fill={SOL.base02}>{r.to}</text>
                    <text x={382} y={r.y + 34} fontSize="9.5" fill={SOL.base01}>{r.sub}</text>
                  </g>
                </g>
              );
            })}
            <Label x={740} y={242} anchor="end" lines={["The words stay on the server; the agent reads the transcript when it asks for it."]} ink="base1" size={9.5} className="bj-fade" style={t(2.2)} />
          </g>
        )}
      </Sheet>
    </Stage>
  );
}
