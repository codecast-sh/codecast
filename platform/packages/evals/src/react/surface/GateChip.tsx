// A product's own gate on a surface (SurfaceInfo.gate), shown as the data it
// is: union's backend decides its Jeffreys rule and hands over the status, so
// nothing here recomputes it. The status is told by shape as well as colour:
// a filled disc where the gate holds (cyan, as a pass), a ring where it failed
// (red, the gate's colour), a dotted ring while it has no reading.

import type { SurfaceInfo } from "../../contract";

type Gate = NonNullable<SurfaceInfo["gate"]>;

const GATE_WORDS: Record<Gate["status"], string> = { green: "gate holds", red: "gate failed", unknown: "gate not read yet" };
const GATE_TONE: Record<Gate["status"], string> = { green: "ev-pass", red: "ev-gate", unknown: "ev-quiet" };

export function GateChip({ gate }: { gate: Gate }) {
  return (
    <span className="ev-chip ev-gate-chip" data-ev-gate={gate.status} title={gate.rule}>
      <svg className={GATE_TONE[gate.status]} width={10} height={10} viewBox="-7 -7 14 14" aria-hidden>
        {gate.status === "green" && <circle r={5.5} fill="currentColor" />}
        {gate.status === "red" && <circle r={4.9} fill="none" stroke="currentColor" strokeWidth={1.8} />}
        {gate.status === "unknown" && <circle r={4.9} fill="none" stroke="currentColor" strokeWidth={1.3} strokeDasharray="1.6 1.6" />}
      </svg>
      <span className={gate.status === "red" ? "ev-gate" : undefined}>{GATE_WORDS[gate.status]}</span>
      {gate.detail && <span className="ev-quiet">{gate.detail}</span>}
    </span>
  );
}
