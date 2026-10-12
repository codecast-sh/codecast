"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Label, Sheet } from "../figureParts";

/** Figures for the triggers guide: the three kinds of trigger, as a person schedules them. */

// ─── Three ways to fire, on one twelve hour axis ───────────────────────────

const X0 = 170;
const X1 = 730;
const HOURS = 12;
const PLAY = 6;
const hx = (h: number) => X0 + ((X1 - X0) * h) / HOURS;
const hat = (h: number) => 0.4 + (h / HOURS) * PLAY;

const LANES = [
  { flag: "in 30 minutes", sub: "once, after a delay", y: 62, ink: SOL.blue, fires: [0.5], note: "fires once, then completes" },
  { flag: "every 4 hours", sub: "repeats on a schedule", y: 124, ink: SOL.green, fires: [4, 8, 12], note: "" },
  { flag: "on a PR comment", sub: "a GitHub or Linear event", y: 186, ink: SOL.magenta, fires: [1.3, 1.6, 6.7, 9.4], note: "" },
];

/** A twelve hour window: what each kind of trigger does in it. */
export function FiringModesFigure() {
  return (
    <Stage minWidth={640}>
      <Sheet w={760} h={250} label="Over twelve hours, a trigger set for 30 minutes from now fires once, one set for every 4 hours fires at four, eight and twelve hours, and one set on PR comments fires whenever a review comment arrives">
        {() => (
          <>
            {LANES.map((l, i) => (
              <g key={l.flag}>
                <g className="bj-rise" style={t(0.1 + i * 0.12)}>
                  <text x={16} y={l.y - 2} fontSize="12" fontWeight={700} fill={l.ink}>{l.flag}</text>
                  <text x={16} y={l.y + 13} fontSize="10" fill={SOL.base01}>{l.sub}</text>
                </g>
                <line x1={X0} x2={X1} y1={l.y} y2={l.y} stroke={SOL.base2} strokeWidth={2} />
                {l.fires.map((h, k) => (
                  <g key={k}>
                    {i === 2 && (
                      <path d={`M${hx(h)} ${l.y - 22}l5 6l-5 6l-5 -6z`} fill={l.ink} fillOpacity={0.35} className="bj-pop" style={t(hat(h) - 0.05)} />
                    )}
                    <circle cx={hx(h)} cy={l.y} r={6} fill={l.ink} className="bj-pop" style={t(hat(h))} />
                  </g>
                ))}
                {l.note && <Label x={hx(l.fires[0]) + 14} y={l.y + 4} lines={[l.note]} ink="base01" className="bj-fade" style={t(hat(l.fires[0]) + 0.2)} />}
              </g>
            ))}
            <Label x={hx(1.6) + 12} y={164} lines={["a review comment lands"]} ink="magenta" size={10} className="bj-fade" style={t(hat(1.3) + 0.2)} />

            {Array.from({ length: HOURS / 2 + 1 }, (_, i) => (
              <g key={i}>
                <line x1={hx(i * 2)} x2={hx(i * 2)} y1={214} y2={219} stroke={SOL.base1} />
                <text x={hx(i * 2)} y={234} textAnchor="middle" fontSize="10" fill={SOL.base1}>{i * 2}h</text>
              </g>
            ))}
            <line x1={X0} x2={X1} y1={214} y2={214} stroke={SOL.base1} />
            <line x1={X0} x2={X0} y1={36} y2={210} stroke={SOL.orange} strokeWidth={1.5} className="bj-sweep" style={t(0.4, PLAY, { "--to": `${X1 - X0}px` })} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
