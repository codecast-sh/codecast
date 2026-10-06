"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the org roles guide. Trust stages are TRUST_STAGES
 * (convex/orgRoles.ts), caps DEFAULT_ROLE_CAPS (shared/contracts/
 * orgCapacity.ts), and the line is the shipped template
 * cli/src/workflow/templates/line.cast.
 */

// ─── The seat outlives the session ─────────────────────────────────────────

const INBOUND = ["task assigned to @growth", "@growth in #launch", "cast send @growth"];

/** Work addresses the role; whichever session holds the seat today receives it. */
export function SeatFigure() {
  const ROLE = { x: 280, y: 74, w: 190, h: 92 };
  const A = { x: 560, y: 34 };
  const B = { x: 560, y: 120 };
  return (
    <Stage minWidth={680}>
      <Sheet w={760} h={290} label="Messages address the role @growth; the role's standing session receives them; when that session is replaced, the role keeps its scope, brief, tasks and place in the tree and the next message reaches the new session">
        {(arrow) => (
          <>
            {INBOUND.map((m, i) => {
              const y = 48 + i * 52;
              return (
                <g key={m}>
                  <g className="bj-rise" style={t(0.1 + i * 0.15)}>
                    <rect x={16} y={y} width={196} height={30} rx={6} fill={SOL.base3} stroke={SOL.base2} />
                    <text x={28} y={y + 19} fontSize="10.5" fill={SOL.base02}>{m}</text>
                  </g>
                  <path d={`M214 ${y + 15}C246 ${y + 15} 248 ${ROLE.y + ROLE.h / 2} ${ROLE.x - 6} ${ROLE.y + ROLE.h / 2}`} pathLength={1} fill="none" stroke={SOL.base1} strokeWidth={1.3} markerEnd={arrow("base1")} className="bj-draw" style={t(0.5 + i * 0.12, 0.35)} />
                </g>
              );
            })}
            <g className="bj-pop" style={t(0.8)}>
              <rect x={ROLE.x} y={ROLE.y} width={ROLE.w} height={ROLE.h} rx={10} fill={`${SOL.violet}12`} stroke={SOL.violet} strokeWidth={1.6} />
              <text x={ROLE.x + 14} y={ROLE.y + 22} fontSize="12.5" fontWeight={700} fill={SOL.base02}>Growth <tspan fill={SOL.violet}>@growth</tspan></text>
              <text x={ROLE.x + 14} y={ROLE.y + 38} fontSize="9.5" fill={SOL.base1}>or-12 · org_roles</text>
              <text x={ROLE.x + 14} y={ROLE.y + 58} fontSize="10" fill={SOL.base01}>scope · charter · brief</text>
              <text x={ROLE.x + 14} y={ROLE.y + 74} fontSize="10" fill={SOL.base01}>tasks · reports to a person</text>
            </g>

            {/* session A holds the seat, then is replaced by B */}
            <g className="bj-rise" style={t(1.2)}>
              <rect x={A.x} y={A.y} width={180} height={44} rx={8} fill={SOL.base3} stroke={SOL.base1} />
              <text x={A.x + 12} y={A.y + 18} fontSize="11" fontWeight={700} fill={SOL.base02}>standing session</text>
              <text x={A.x + 12} y={A.y + 34} fontSize="9.5" fill={SOL.base01}>jx7a1b2 · since Monday</text>
            </g>
            <path d={`M${ROLE.x + ROLE.w + 4} ${ROLE.y + 30}C${ROLE.x + ROLE.w + 40} ${ROLE.y + 30} ${A.x - 40} ${A.y + 22} ${A.x - 6} ${A.y + 22}`} pathLength={1} fill="none" stroke={SOL.violet} strokeWidth={1.5} markerEnd={arrow("violet")} className="bj-draw" style={t(1.3, 0.35)} />
            <g className="bj-pop" style={t(2.2)}>
              <line x1={A.x + 6} x2={A.x + 174} y1={A.y + 4} y2={A.y + 40} stroke={SOL.red} strokeWidth={1.4} />
            </g>
            <Label x={A.x + 90} y={A.y + 60} anchor="middle" lines={["restarted or replaced"]} ink="red" size={9.5} className="bj-fade" style={t(2.3)} />
            <g className="bj-rise" style={t(2.6)}>
              <rect x={B.x} y={B.y} width={180} height={44} rx={8} fill={SOL.base3} stroke={SOL.violet} strokeWidth={1.4} />
              <text x={B.x + 12} y={B.y + 18} fontSize="11" fontWeight={700} fill={SOL.base02}>standing session</text>
              <text x={B.x + 12} y={B.y + 34} fontSize="9.5" fill={SOL.base01}>jx7c9d4 · seated today</text>
            </g>
            <path d={`M${ROLE.x + ROLE.w + 4} ${ROLE.y + 62}C${ROLE.x + ROLE.w + 40} ${ROLE.y + 62} ${B.x - 40} ${B.y + 22} ${B.x - 6} ${B.y + 22}`} pathLength={1} fill="none" stroke={SOL.violet} strokeWidth={1.5} markerEnd={arrow("violet")} className="bj-draw" style={t(2.8, 0.35)} />

            {/* hands */}
            {[0, 1, 2].map((k) => (
              <g key={k} className="bj-rise" style={t(3.2 + k * 0.15)}>
                <rect x={ROLE.x - 40 + k * 96} y={222} width={88} height={34} rx={6} fill={SOL.base3} stroke={SOL.base2} />
                <text x={ROLE.x + 4 + k * 96} y={243} textAnchor="middle" fontSize="10" fill={SOL.base01}>{`hand ${k + 1}`}</text>
                <path d={`M${ROLE.x + 4 + k * 96} 220L${ROLE.x + ROLE.w / 2 + (k - 1) * 30} ${ROLE.y + ROLE.h + 6}`} pathLength={1} stroke={SOL.base1} strokeDasharray="3 3" markerEnd={arrow("base1")} className="bj-draw" style={t(3.3 + k * 0.15, 0.3)} />
              </g>
            ))}
            <Label x={ROLE.x + 260} y={230} lines={["sessions started for one", "bounded piece of work;", "they report to the role"]} ink="base01" size={9.5} className="bj-fade" style={t(3.7)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Trust stages ──────────────────────────────────────────────────────────

const STAGES: { id: string; ink: Ink; may: string[]; refused?: string }[] = [
  { id: "understand", ink: "base01", may: ["reads its scope and brief", "answers what people send it"], refused: "starting a hand: \"may not start hands\"" },
  { id: "decide", ink: "blue", may: ["also answers decisions", "inside its grants"] },
  { id: "direct", ink: "green", may: ["also starts hands", "inside its daily caps"] },
];

/** Each stage adds one power, checked by the server; a person moves a role between them. */
export function TrustFigure() {
  const CAPS = [
    { label: "hands", n: "6" },
    { label: "wakes", n: "40" },
    { label: "tokens", n: "400k" },
  ];
  return (
    <Stage>
      <div className="p-4 sm:p-5 sm:pt-10 font-mono">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {STAGES.map((s, i) => (
            <div key={s.id} className="rounded-lg p-3 bj-rise" style={{ ...t(0.2 + i * 0.4), backgroundColor: `${SOL[s.ink]}10`, border: `1px solid ${SOL[s.ink]}55`, marginTop: `${(2 - i) * 0}px` }}>
              <div className="flex items-center gap-2">
                <span className="inline-flex w-5 h-5 rounded-full items-center justify-center text-[10px] font-bold" style={{ backgroundColor: SOL[s.ink], color: SOL.base3 }}>{i + 1}</span>
                <span className="text-[13px] font-bold" style={{ color: SOL.base02 }}>{s.id}</span>
                {i === 0 && <span className="ml-auto text-[10px]" style={{ color: SOL.base1 }}>every role starts here</span>}
              </div>
              <div className="mt-2 text-[11.5px] leading-snug" style={{ color: SOL.base01 }}>
                {s.may.map((m) => <div key={m}>{m}</div>)}
              </div>
              {s.refused && (
                <div className="mt-2 text-[10.5px] leading-snug" style={{ color: SOL.red }}>
                  <span className="mr-1">✕</span>{s.refused}
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 bj-fade" style={t(1.6)}>
          <span className="text-[11px] mr-1" style={{ color: SOL.base1 }}>default caps, per role per day</span>
          {CAPS.map((c, i) => (
            <span key={c.label} className="text-[11px] px-2 py-0.5 rounded bj-pop" style={{ ...t(1.8 + i * 0.15), backgroundColor: SOL.base2, color: SOL.base02 }}>
              <b>{c.n}</b> {c.label}
            </span>
          ))}
          <span className="text-[10.5px]" style={{ color: SOL.base1 }}>tokens counted from Claude transcripts</span>
        </div>
      </div>
    </Stage>
  );
}

// ─── The shipped line ──────────────────────────────────────────────────────

type St = { id: string; kind: "agent" | "script" | "gate"; note?: string };
const ROW1: St[] = [
  { id: "ground", kind: "agent", note: "goal + rating" },
  { id: "plan", kind: "agent", note: "risk = plan only" },
  { id: "plan gate", kind: "gate" },
  { id: "analyze", kind: "agent", note: "criteria" },
  { id: "prove", kind: "agent", note: "reproduce" },
  { id: "red", kind: "script", note: "fails first" },
];
const ROW2: St[] = [
  { id: "implement", kind: "agent", note: "own worktree" },
  { id: "verify", kind: "script", note: "check cmd" },
  { id: "green", kind: "script" },
  { id: "eval", kind: "script" },
  { id: "review", kind: "agent", note: "independent" },
  { id: "card", kind: "script", note: "change card" },
];
const ROW3: St[] = [
  { id: "decide", kind: "gate" },
  { id: "ship / merge", kind: "script" },
  { id: "watch", kind: "script", note: "watch days" },
];

const KIND: Record<St["kind"], { ink: Ink; fill: string }> = {
  agent: { ink: "blue", fill: `${SOL.blue}12` },
  script: { ink: "base1", fill: SOL.base3 },
  gate: { ink: "yellow", fill: `${SOL.yellow}1c` },
};

/** One cause from goal to a watched change. Agent stations are sessions, gates are a person's call. */
export function LineFigure() {
  const W = 104;
  const GAP = 18;
  const X0 = 24;
  const rowsY = [36, 140, 244];
  const xOf = (i: number) => X0 + i * (W + GAP);
  let n = 0;
  const station = (s: St, i: number, y: number, arrow: (ink?: Ink) => string) => {
    const k = KIND[s.kind];
    const x = xOf(i);
    const at = 0.15 + n++ * 0.16;
    return (
      <g key={s.id}>
        {s.kind === "gate" ? (
          <path d={`M${x + 10} ${y}H${x + W - 10}L${x + W} ${y + 18}L${x + W - 10} ${y + 36}H${x + 10}L${x} ${y + 18}z`} fill={k.fill} stroke={SOL[k.ink]} strokeWidth={1.4} className="bj-pop" style={t(at)} />
        ) : (
          <rect x={x} y={y} width={W} height={36} rx={s.kind === "agent" ? 8 : 3} fill={k.fill} stroke={SOL[k.ink]} strokeWidth={1.2} className="bj-pop" style={t(at)} />
        )}
        <text x={x + W / 2} y={y + 22} textAnchor="middle" fontSize="11" fontWeight={700} fill={SOL.base02} className="bj-fade" style={t(at)}>{s.id}</text>
        {s.note && <text x={x + W / 2} y={y + 50} textAnchor="middle" fontSize="9.5" fill={SOL.base1} className="bj-fade" style={t(at + 0.1)}>{s.note}</text>}
        {i > 0 && <path d={`M${x - GAP + 2} ${y + 18}H${x - 4}`} stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow("base1")} className="bj-fade" style={t(at)} />}
      </g>
    );
  };
  const back = (fromI: number, label: string, at: number, arrow: (ink?: Ink) => string) => {
    const x1 = xOf(fromI) + W / 2;
    const x2 = xOf(0) + W * 0.7;
    const y = rowsY[1] - 14;
    return (
      <g key={label}>
        <path d={`M${x1} ${rowsY[1]}V${y}H${x2}V${rowsY[1] - 4}`} pathLength={1} fill="none" stroke={SOL.orange} strokeWidth={1.1} strokeDasharray="4 3" markerEnd={arrow("orange")} className="bj-draw" style={t(at, 0.5)} />
        <text x={x1 + 6} y={y + 4} fontSize="9" fill={SOL.orange} className="bj-fade" style={t(at + 0.3)}>{label}</text>
      </g>
    );
  };
  return (
    <Stage minWidth={700}>
      <Sheet w={760} h={330} label="The shipped line: ground, plan and plan gate, analyze, prove, red, implement, verify, green, eval, review, change card, decide, ship or merge, watch; failures route back to implement">
        {(arrow) => (
          <>
            {ROW1.map((s, i) => station(s, i, rowsY[0], arrow))}
            <path d={`M${xOf(5) + W / 2} ${rowsY[0] + 56}V${rowsY[0] + 76}H${xOf(0) + W / 2}V${rowsY[1] - 4}`} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow("base1")} className="bj-fade" style={t(1.1)} />
            {ROW2.map((s, i) => station(s, i, rowsY[1], arrow))}
            <path d={`M${xOf(5) + W / 2} ${rowsY[1] + 56}V${rowsY[1] + 76}H${xOf(0) + W / 2}V${rowsY[2] - 4}`} fill="none" stroke={SOL.base1} strokeWidth={1.2} markerEnd={arrow("base1")} className="bj-fade" style={t(2.1)} />
            {ROW3.map((s, i) => station(s, i, rowsY[2], arrow))}
            {back(4, "review: changes", 2.6, arrow)}
            <Label x={xOf(3) + 20} y={rowsY[2] + 14} lines={["checks failed, still red and a failed eval", "also return to implement, three visits at most.", "decide is Ship, Revise or Drop on the card."]} ink="base01" size={9.5} className="bj-fade" style={t(2.9)} />
            <g className="bj-fade" style={t(3.1)} fontSize="9.5">
              <rect x={X0 + 400} y={14} width={10} height={10} rx={3} fill={KIND.agent.fill} stroke={SOL.blue} />
              <text x={X0 + 414} y={23} fill={SOL.base01}>a session</text>
              <rect x={X0 + 486} y={14} width={10} height={10} rx={1} fill={SOL.base3} stroke={SOL.base1} />
              <text x={X0 + 500} y={23} fill={SOL.base01}>a script</text>
              <path d={`M${X0 + 568} 19l3 -5h6l3 5l-3 5h-6z`} fill={KIND.gate.fill} stroke={SOL.yellow} />
              <text x={X0 + 586} y={23} fill={SOL.base01}>a person's gate</text>
            </g>
          </>
        )}
      </Sheet>
    </Stage>
  );
}

