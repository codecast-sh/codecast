"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Box, Hatch, Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the thread state guide. Thresholds and colors are the ones in
 * shared/contracts/threadState.ts and web/lib/threadState.ts.
 */

// ─── Freshness: how far the thread has run past the line ───────────────────

const MSG = { aging: 60, stale: 200, nudge: 20, end: 240 };
const HRS = { aging: 12, stale: 48, end: 56 };

/** Messages since the write, and hours since it: whichever crosses first decides. */
export function FreshnessFigure() {
  const X0 = 150;
  const W = 560;
  const SWEEP = 4.2;
  const mx = (m: number) => X0 + (m / MSG.end) * W;
  const hx = (h: number) => X0 + (h / HRS.end) * W;
  const lane = (y: number, label: string, sub: string, cuts: [number, number, number], ticks: { x: number; text: string }[]) => (
    <g>
      <Label x={16} y={y + 12} lines={[label]} ink="base02" weight={700} size={11} />
      <Label x={16} y={y + 27} lines={[sub]} ink="base1" size={10} />
      <rect x={cuts[0]} y={y} width={cuts[1] - cuts[0]} height={22} fill={`${SOL.cyan}26`} className="bj-grow" style={t(0.2, SWEEP * ((cuts[1] - X0) / W))} />
      <rect x={cuts[1]} y={y} width={cuts[2] - cuts[1]} height={22} fill={`${SOL.yellow}2e`} className="bj-grow" style={t(0.2 + SWEEP * ((cuts[1] - X0) / W), SWEEP * ((cuts[2] - cuts[1]) / W))} />
      <rect x={cuts[2]} y={y} width={X0 + W - cuts[2]} height={22} fill={`url(#ts-hatch)`} className="bj-grow" style={t(0.2 + SWEEP * ((cuts[2] - X0) / W), SWEEP * ((X0 + W - cuts[2]) / W))} />
      {ticks.map((k) => (
        <g key={k.text}>
          <line x1={k.x} x2={k.x} y1={y + 22} y2={y + 27} stroke={SOL.base1} />
          <text x={k.x} y={y + 38} fontSize="9.5" textAnchor="middle" fill={SOL.base1}>{k.text}</text>
        </g>
      ))}
    </g>
  );
  const zones: { x: number; ink: Ink; title: string; sub: string; at: number }[] = [
    { x: mx(0) + 6, ink: "cyan", title: "fresh", sub: "cyan pin", at: 0.4 },
    { x: mx(MSG.aging) + 6, ink: "yellow", title: "aging", sub: "yellow pin and counter", at: 0.2 + SWEEP * (mx(MSG.aging) - X0) / W },
    { x: mx(MSG.stale) + 6, ink: "red", title: "stale", sub: "hidden everywhere", at: 0.2 + SWEEP * (mx(MSG.stale) - X0) / W },
  ];
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={282} label="A pinned state is fresh until 60 messages or 12 hours, aging until 200 messages or 48 hours, then hidden">
        {(arrow) => (
          <>
            <Hatch id="ts-hatch" ink="red" opacity={0.35} />
            {zones.map((z) => (
              <g key={z.title} className="bj-rise" style={t(z.at)}>
                <text x={z.x} y={34} fontSize="11.5" fontWeight={700} fill={SOL[z.ink]}>{z.title}</text>
                <text x={z.x} y={48} fontSize="10" fill={SOL.base01}>{z.sub}</text>
              </g>
            ))}
            {lane(66, "messages", "since the write", [mx(0), mx(MSG.aging), mx(MSG.stale)], [0, 20, 60, 200].map((m) => ({ x: mx(m), text: `${m}` })))}
            {lane(146, "hours", "since the write", [hx(0), hx(HRS.aging), hx(HRS.stale)], [0, 12, 48].map((h) => ({ x: hx(h), text: `${h}h` })))}

            <circle cx={mx(MSG.nudge)} cy={77} r={4} fill={SOL.violet} className="bj-pop" style={t(0.2 + SWEEP * (mx(MSG.nudge) - X0) / W)} />
            <Label x={mx(MSG.nudge) - 8} y={112} anchor="end" lines={["by 20 the agent is", "reminded to rewrite it"]} ink="violet" size={9.5} className="bj-fade" style={t(0.3 + SWEEP * (mx(MSG.nudge) - X0) / W)} />

            <line x1={X0} x2={X0} y1={60} y2={174} stroke={SOL.base02} strokeWidth={1.2} className="bj-sweep" style={t(0.2, SWEEP, { "--to": `${W}px` })} />

            <Label x={X0} y={210} lines={["Whichever crosses first decides. The clock is the weaker signal: a session parked overnight", "on a CI run has not moved, so time only ages a line the thread has left alone for half a day."]} ink="base01" size={10.5} className="bj-fade" style={t(SWEEP + 0.3)} />
            <path d={`M${X0 + W - 20} 250Q${X0 + W / 2} 276 ${X0 + 6} 252`} pathLength={1} fill="none" stroke={SOL.green} strokeWidth={1.4} markerEnd={arrow("green")} className="bj-draw" style={t(SWEEP + 0.6, 0.7)} />
            <Label x={X0 + W / 2} y={246} anchor="middle" lines={["the agent rewrites it: both counters start again"]} ink="green" size={10.5} className="bj-fade" style={t(SWEEP + 1.0)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Who acts next: where the turn files ───────────────────────────────────

const ROUTES: { flag: string; to: string; ink: Ink; note?: string[] }[] = [
  { flag: "In progress", to: "Working", ink: "green" },
  { flag: "Needs input", to: "Needs Input", ink: "yellow" },
  { flag: "Complete", to: "Done", ink: "cyan", note: ["this turn only:", "the next one says again"] },
  { flag: "Dormant", to: "Dormant", ink: "blue", note: ["names what wakes it:", "a schedule, a task, a reply"] },
  { flag: "nothing said", to: "Needs Input", ink: "base1" },
];

/** The status the agent pins decides the inbox section when the turn ends; a person's message takes it down. */
export function WhoActsNextFigure() {
  const SRC = { x: 24, y: 120, w: 150, h: 54 };
  const DX = 440;
  const rowY = (i: number) => 28 + i * 52;
  return (
    <Stage minWidth={660}>
      <Sheet w={760} h={350} label="Each status files the session under one inbox section when the turn ends">
        {(arrow) => (
          <>
            <Box x={SRC.x} y={SRC.y} w={SRC.w} h={SRC.h} title="the turn ends" sub="the agent says who is next" ink="base02" className="bj-pop" style={t(0.1)} />
            {ROUTES.map((r, i) => {
              const y = rowY(i) + 18;
              const d = `M${SRC.x + SRC.w + 4} ${SRC.y + SRC.h / 2}C${SRC.x + SRC.w + 70} ${SRC.y + SRC.h / 2} ${DX - 230} ${y} ${DX - 150} ${y}H${DX - 6}`;
              const at = 0.4 + i * 0.35;
              return (
                <g key={r.flag + r.to}>
                  <path d={d} pathLength={1} fill="none" stroke={SOL[r.ink]} strokeWidth={1.5} markerEnd={arrow(r.ink)} className="bj-draw" style={t(at, 0.45)} />
                  <text x={DX - 14} y={y - 6} textAnchor="end" fontSize="10.5" fill={SOL[r.ink === "base1" ? "base01" : r.ink]} className="bj-fade" style={t(at + 0.2)}>{r.flag}</text>
                  <Box x={DX} y={rowY(i)} w={130} h={36} title={r.to} ink={r.ink} fill={r.ink === "base1" ? SOL.base3 : `${SOL[r.ink]}14`} className="bj-pop" style={t(at + 0.4)} />
                  {r.note && <Label x={DX + 144} y={rowY(i) + 15} lines={r.note} ink="base01" size={10} className="bj-fade" style={t(at + 0.6)} />}
                </g>
              );
            })}
            <line x1={24} x2={736} y1={290} y2={290} stroke={SOL.base2} />
            <g className="bj-rise" style={t(2.6)}>
              <circle cx={32} cy={314} r={5} fill={SOL.base02} />
              <text x={44} y={318} fontSize="10.5" fill={SOL.base02}><tspan fontWeight={700}>your message</tspan> takes the pinned state down: you answered it</text>
            </g>
            <g className="bj-rise" style={t(2.9)}>
              <circle cx={32} cy={336} r={5} fill="none" stroke={SOL.base1} />
              <text x={44} y={340} fontSize="10.5" fill={SOL.base01}><tspan fontWeight={700}>another session's message or a trigger wake</tspan> leaves it standing</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}
