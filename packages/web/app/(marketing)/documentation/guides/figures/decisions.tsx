"use client";

import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Box, Hatch, Label, Sheet } from "../figureParts";

/**
 * Figures for the decision queue guide. The queue order is sortQueue/queueTier
 * in web/lib/decisionQueue.ts; the answer path is the store action that marks
 * the row and sends "Decision: <label>" into the asking session.
 */

// ─── The round trip ────────────────────────────────────────────────────────

/** The agent asks and parks; you answer when you choose; the answer arrives as a message. */
export function DecisionRoundTripFigure() {
  const X0 = 110;
  const lane = { agent: 46, queue: 128, you: 210 };
  const ASK = 210;
  const ANS = 520;
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={262} label="The agent posts a decision and parks; the row waits in the queue; your answer goes back into the session as a message and the agent continues">
        {(arrow) => (
          <>
            {([["agent", lane.agent], ["queue", lane.queue], ["you", lane.you]] as const).map(([name, y]) => (
              <g key={name}>
                <text x={16} y={y + 4} fontSize="11" fontWeight={700} fill={SOL.base02}>{name}</text>
                <line x1={X0} x2={744} y1={y} y2={y} stroke={SOL.base2} strokeWidth={1.2} />
              </g>
            ))}

            {/* agent: working, parked, working again */}
            <rect x={X0} y={lane.agent - 7} width={ASK - X0} height={14} rx={3} fill={`${SOL.green}88`} className="bj-grow" style={t(0.1, 0.8)} />
            <rect x={ASK} y={lane.agent - 7} width={ANS - ASK} height={14} rx={3} fill="url(#dq-park)" className="bj-grow" style={t(1.2, 2.2)} />
            <Label x={(ASK + ANS) / 2} y={lane.agent - 14} anchor="middle" lines={["parked: the turn ended, nothing burns"]} ink="base01" size={10} className="bj-fade" style={t(1.6)} />
            <rect x={ANS + 6} y={lane.agent - 7} width={744 - ANS - 6} height={14} rx={3} fill={`${SOL.green}88`} className="bj-grow" style={t(4.1, 0.8)} />
            <Hatch id="dq-park" opacity={0.45} />

            {/* the ask */}
            <path d={`M${ASK} ${lane.agent + 8}V${lane.queue - 22}`} pathLength={1} stroke={SOL.violet} strokeWidth={1.5} markerEnd={arrow("violet")} className="bj-draw" style={t(0.9, 0.3)} />
            <Label x={ASK + 8} y={lane.agent + 26} lines={["cast decide", "-o … -o … --context -"]} ink="violet" size={10} className="bj-fade" style={t(0.9)} />
            <Box x={ASK - 52} y={lane.queue - 18} w={104} h={36} title="sd-41" sub="pending" ink="violet" fill={`${SOL.violet}14`} className="bj-pop" style={t(1.2)} />
            <Label x={ASK + 62} y={lane.queue + 4} lines={["also a card in the conversation"]} ink="base1" size={9.5} className="bj-fade" style={t(1.4)} />

            {/* you: your own work, then the queue in one sitting */}
            <rect x={X0} y={lane.you - 7} width={430 - X0} height={14} rx={3} fill={`${SOL.blue}66`} className="bj-grow" style={t(0.3, 2.6)} />
            <Label x={X0 + 8} y={lane.you + 22} lines={["your own work, uninterrupted"]} ink="blue" size={10} className="bj-fade" style={t(1.0)} />
            {[0, 1, 2].map((k) => (
              <rect key={k} x={440 + k * 30} y={lane.you - 9} width={24} height={18} rx={3} fill={k === 2 ? SOL.yellow : SOL.base3} stroke={SOL.yellow} className="bj-pop" style={t(3.0 + k * 0.2)} />
            ))}
            <text x={512} y={lane.you + 4} textAnchor="middle" fontSize="10" fontWeight={700} fill={SOL.base3} className="bj-fade" style={t(3.4)}>2</text>
            <Label x={440} y={lane.you + 26} lines={["/questions: one sitting, a key each"]} ink="yellow" size={10} className="bj-fade" style={t(3.1)} />

            {/* the answer */}
            <path d={`M${ANS - 12} ${lane.you - 12}L${ANS - 2} ${lane.agent + 10}`} pathLength={1} stroke={SOL.yellow} strokeWidth={1.6} markerEnd={arrow("yellow")} className="bj-draw" style={t(3.6, 0.45)} />
            <g className="bj-pop" style={t(4.0)}>
              <rect x={ANS + 14} y={lane.queue - 30} width={196} height={36} rx={6} fill={SOL.base3} stroke={SOL.yellow} />
              <text x={ANS + 24} y={lane.queue - 15} fontSize="10.5" fontWeight={700} fill={SOL.base02}>Decision: Path wins</text>
              <text x={ANS + 24} y={lane.queue - 1} fontSize="9.5" fill={SOL.base01}>a user message, as if typed</text>
            </g>
            <Label x={ANS + 14} y={lane.queue + 24} lines={["the row is marked answered;", "a second answer changes nothing"]} ink="base1" size={9.5} className="bj-fade" style={t(4.3)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Blocking or advisory ──────────────────────────────────────────────────

/** Advisory keeps the agent moving on its default, and costs a rewind when the answer disagrees. */
export function BlockingAdvisoryFigure() {
  const X0 = 24;
  const W = 330;
  const ANS = 0.62;
  const bar = (y: number, from: number, to: number, fill: string, at: number, dur: number) => (
    <rect x={X0 + from * W} y={y} width={(to - from) * W} height={14} rx={3} fill={fill} className="bj-grow" style={t(at, dur)} />
  );
  const panel = (advisory: boolean) => (
    <Sheet w={380} h={150} label={advisory ? "Advisory: the agent proceeds on its default; a disagreeing answer an hour later turns that hour into work to undo" : "Blocking: the agent waits until the answer arrives, then continues on it"}>
      {() => (
        <>
          <Hatch id={`dq-w${advisory ? "a" : "b"}`} ink={advisory ? "red" : "base1"} opacity={0.5} />
          <line x1={X0 + 0.12 * W} x2={X0 + 0.12 * W} y1={30} y2={84} stroke={SOL.violet} strokeDasharray="3 3" />
          <text x={X0 + 0.12 * W} y={22} textAnchor="middle" fontSize="10" fill={SOL.violet}>asks</text>
          <line x1={X0 + ANS * W} x2={X0 + ANS * W} y1={30} y2={84} stroke={SOL.yellow} strokeDasharray="3 3" />
          <text x={X0 + ANS * W} y={22} textAnchor="middle" fontSize="10" fill={SOL.yellow}>answer lands</text>
          {bar(50, 0, 0.12, `${SOL.green}88`, 0.2, 0.4)}
          {advisory ? (
            <>
              {bar(50, 0.12, ANS, `url(#dq-wa)`, 0.6, 1.6)}
              {bar(50, ANS, 1, `${SOL.green}88`, 2.6, 0.9)}
              <Label x={X0 + 0.37 * W} y={104} anchor="middle" lines={["built on the default,", "then undone: it disagreed"]} ink="red" size={10} className="bj-fade" style={t(2.3)} />
            </>
          ) : (
            <>
              {bar(50, 0.12, ANS, `url(#dq-wb)`, 0.6, 1.6)}
              {bar(50, ANS, 1, `${SOL.green}88`, 2.3, 0.9)}
              <Label x={X0 + 0.37 * W} y={104} anchor="middle" lines={["waiting costs time,", "nothing to undo"]} ink="base01" size={10} className="bj-fade" style={t(2.0)} />
            </>
          )}
          <text x={X0 + W} y={140} textAnchor="end" fontSize="9.5" fill={SOL.base1}>about an hour</text>
        </>
      )}
    </Sheet>
  );
  return (
    <Stage>
      <div className="grid grid-cols-1 md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Blocking (default)" sub="The agent ends its turn and waits for you." color={SOL.base01} />
          {panel(false)}
        </div>
        <div>
          <PanelHead title="--advisory --default 1" sub="Only for a default that is cheap to undo." color={SOL.red} />
          {panel(true)}
        </div>
      </div>
    </Stage>
  );
}

// ─── The order of the queue ────────────────────────────────────────────────

const TIERS = [
  { tier: 1, title: "Blocked, session can receive the answer", ink: SOL.yellow, rows: [["Which schema wins?", "3h"], ["Approve dropping agent_runs_v1?", "40m"]] },
  { tier: 2, title: "Blocked, session stopped or unresponsive", ink: SOL.orange, rows: [["Ship the banner?", "1d"]] },
  { tier: 3, title: "Advisory: the agent is already on its default", ink: SOL.base1, rows: [["Back off or switch keys?", "2h"], ["Which layout?", "12m"]] },
];

/** A fixed rule, not a score: three groups, oldest first inside each. */
export function QueueOrderFigure() {
  let n = 0;
  return (
    <Stage>
      <div className="p-4 sm:p-5 sm:pt-10 font-mono space-y-3">
        {TIERS.map((g) => (
          <div key={g.tier} className="bj-rise" style={t(0.2 + (g.tier - 1) * 0.5)}>
            <div className="flex items-center gap-2 text-[11px] mb-1.5" style={{ color: g.ink }}>
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-sm text-[10px] font-bold" style={{ backgroundColor: g.ink, color: SOL.base3 }}>{g.tier}</span>
              <span className="font-bold">{g.title}</span>
              <span className="ml-auto" style={{ color: SOL.base1 }}>oldest first</span>
            </div>
            <div className="space-y-1.5">
              {g.rows.map(([q, age]) => (
                <div key={q} className="flex items-center gap-3 rounded-md px-3 py-2 bj-rise" style={{ ...t(0.4 + n++ * 0.18), backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}`, borderLeft: `3px solid ${g.ink}` }}>
                  <span className="text-[12.5px]" style={{ color: SOL.base02 }}>{q}</span>
                  <span className="ml-auto text-[11px]" style={{ color: SOL.base1 }}>asked {age} ago</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Stage>
  );
}
