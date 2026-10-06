"use client";

import type { ReactNode } from "react";
import { SOL } from "../../../blog/blogChrome";
import { PanelHead, Stage, t } from "../../../blog/figureKit";
import { Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the workflows guide. Shapes and node types are the ones in
 * packages/cli/src/workflow/types.ts and parser.ts; the gate reply rules are
 * runner.ts's (a reply that starts with an option's key picks it, the rest is
 * handed to the next node).
 */

// ─── Shape outlines, centered on (cx, cy) ──────────────────────────────────

type ShapeProps = { cx: number; cy: number; w: number; h: number; ink: Ink; fill?: string; width?: number };

function shapePath(kind: string, cx: number, cy: number, w: number, h: number): string {
  const l = cx - w / 2, r = cx + w / 2, tp = cy - h / 2, b = cy + h / 2;
  switch (kind) {
    case "parallelogram": return `M${l + 14} ${tp}H${r}L${r - 14} ${b}H${l}Z`;
    case "hexagon": return `M${l + 16} ${tp}H${r - 16}L${r} ${cy}L${r - 16} ${b}H${l + 16}L${l} ${cy}Z`;
    case "diamond":
    case "Mdiamond": return `M${cx} ${tp}L${r} ${cy}L${cx} ${b}L${l} ${cy}Z`;
    case "tab": return `M${l} ${tp + 7}H${l + w * 0.4}V${tp}H${l}Z M${l} ${tp + 7}H${r}V${b}H${l}Z`;
    case "octagon": {
      const k = Math.min(w, h) * 0.28;
      return `M${l + k} ${tp}H${r - k}L${r} ${tp + k}V${b - k}L${r - k} ${b}H${l + k}L${l} ${b - k}V${tp + k}Z`;
    }
    default: return `M${l + 6} ${tp}H${r - 6}Q${r} ${tp} ${r} ${tp + 6}V${b - 6}Q${r} ${b} ${r - 6} ${b}H${l + 6}Q${l} ${b} ${l} ${b - 6}V${tp + 6}Q${l} ${tp} ${l + 6} ${tp}Z`;
  }
}

function Shape({ kind, cx, cy, w, h, ink, fill = SOL.base3, width = 1.3 }: { kind: string } & ShapeProps) {
  const stroke = SOL[ink];
  const l = cx - w / 2, r = cx + w / 2, tp = cy - h / 2, b = cy + h / 2;
  if (kind === "tripleoctagon") {
    return (
      <g fill={fill} stroke={stroke} strokeWidth={width}>
        {[0, 5, 10].map((d) => <path key={d} d={shapePath("octagon", cx, cy, w - d * 2, h - d * 2)} fill={d === 0 ? fill : "none"} />)}
      </g>
    );
  }
  return (
    <g stroke={stroke} strokeWidth={width}>
      <path d={shapePath(kind === "Msquare" || kind === "component" ? "rect" : kind, cx, cy, w, h)} fill={fill} />
      {kind === "Mdiamond" && <path d={`M${cx - w * 0.18} ${tp + h * 0.18}L${cx + w * 0.18} ${tp + h * 0.18}M${cx - w * 0.18} ${b - h * 0.18}L${cx + w * 0.18} ${b - h * 0.18}`} fill="none" />}
      {kind === "Msquare" && <path d={`M${l} ${tp + 9}L${l + 9} ${tp}M${r - 9} ${tp}L${r} ${tp + 9}M${l} ${b - 9}L${l + 9} ${b}M${r - 9} ${b}L${r} ${b - 9}`} fill="none" />}
      {kind === "component" && (
        <>
          <rect x={l - 6} y={tp + h * 0.2} width={12} height={7} fill={fill} />
          <rect x={l - 6} y={b - h * 0.2 - 7} width={12} height={7} fill={fill} />
        </>
      )}
    </g>
  );
}

function Name({ x, y, title, sub }: { x: number; y: number; title: string; sub?: string }) {
  return (
    <>
      <text x={x} y={sub ? y - 3 : y + 4} textAnchor="middle" fontSize="12" fontWeight={700} fill={SOL.base02}>{title}</text>
      {sub && <text x={x} y={y + 12} textAnchor="middle" fontSize="9.5" fill={SOL.base01}>{sub}</text>}
    </>
  );
}

// ─── One run of the guide's graph ──────────────────────────────────────────

const N = {
  start: { cx: 34, cy: 130 },
  implement: { cx: 150, cy: 130 },
  verify: { cx: 345, cy: 130 },
  review: { cx: 550, cy: 130 },
  exit: { cx: 704, cy: 130 },
};

function Chip({ x, y, text, ink, at }: { x: number; y: number; text: string; ink: Ink; at: number }) {
  const w = text.length * 6.2 + 14;
  return (
    <g className="bj-pop" style={t(at)}>
      <rect x={x - w / 2} y={y - 10} width={w} height={18} rx={9} fill={SOL.base3} stroke={SOL[ink]} />
      <text x={x} y={y + 3} textAnchor="middle" fontSize="10" fill={SOL[ink]}>{text}</text>
    </g>
  );
}

/** The guide's graph, run once: a failed typecheck loops back, a pass waits on a person. */
export function WorkflowRunFigure() {
  return (
    <Stage minWidth={660}>
      <Sheet w={740} h={262} label="Implement runs, verify fails and routes back to implement, the second verify passes, the review gate waits for a person, and Approve exits">
        {(arrow) => (
          <>
            <g className="bj-fade" style={t(0.05)}>
              <Shape kind="Mdiamond" cx={N.start.cx} cy={N.start.cy} w={36} h={36} ink="base01" />
              <Shape kind="box" cx={N.implement.cx} cy={N.implement.cy} w={124} h={46} ink="base1" />
              <Shape kind="parallelogram" cx={N.verify.cx} cy={N.verify.cy} w={140} h={46} ink="base1" />
              <Shape kind="hexagon" cx={N.review.cx} cy={N.review.cy} w={130} h={46} ink="base1" />
              <Shape kind="Msquare" cx={N.exit.cx} cy={N.exit.cy} w={46} h={46} ink="base01" />
              <Name x={N.implement.cx} y={N.implement.cy} title="Implement" sub="backend=claude" />
              <Name x={N.verify.cx} y={N.verify.cy} title="Verify" sub="script=tsc" />
              <Name x={N.review.cx} y={N.review.cy} title="Review" sub="human gate" />
            </g>

            {/* structure */}
            <g stroke={SOL.base1} strokeWidth={1.2} fill="none" className="bj-fade" style={t(0.2)}>
              <path d="M53 130H84" markerEnd={arrow()} />
              <path d="M213 130H271" markerEnd={arrow()} />
              <path d="M416 130H481" markerEnd={arrow()} />
              <path d="M616 130H677" markerEnd={arrow()} />
              <path d="M340 154C334 214 160 214 152 157" markerEnd={arrow()} strokeDasharray="4 3" />
              <path d="M550 106C540 30 162 30 152 103" markerEnd={arrow()} strokeDasharray="4 3" />
            </g>
            <Label x={448} y={170} lines={["outcome = success"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />
            <Label x={246} y={222} lines={["outcome = failure"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />
            <Label x={646} y={170} lines={["[A] Approve"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />
            <Label x={350} y={44} lines={["[R] Revise, with your note"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />

            {/* the run */}
            <path d="M53 130H84" pathLength={1} stroke={SOL.blue} strokeWidth={2.2} fill="none" className="bj-draw" style={t(0.6, 0.2)} />
            <Chip x={N.implement.cx} y={88} text="visit 1" ink="blue" at={0.8} />
            <path d="M213 130H271" pathLength={1} stroke={SOL.blue} strokeWidth={2.2} fill="none" className="bj-draw" style={t(1.3, 0.25)} />
            <Chip x={N.verify.cx} y={88} text="exit 1" ink="red" at={1.6} />
            <path d="M340 154C334 214 160 214 152 157" pathLength={1} stroke={SOL.red} strokeWidth={2.2} fill="none" className="bj-draw" style={t(1.9, 0.6)} />
            <Chip x={N.implement.cx} y={88} text="visit 2" ink="blue" at={2.6} />
            <path d="M213 130H271" pathLength={1} stroke={SOL.green} strokeWidth={2.2} fill="none" className="bj-draw" style={t(3.0, 0.25)} />
            <Chip x={N.verify.cx} y={88} text="exit 0" ink="green" at={3.3} />
            <path d="M416 130H481" pathLength={1} stroke={SOL.green} strokeWidth={2.2} fill="none" className="bj-draw" style={t(3.6, 0.25)} />
            <g className="bj-fade" style={t(3.9)}>
              <g className="bj-pulse"><Shape kind="hexagon" cx={N.review.cx} cy={N.review.cy} w={138} h={54} ink="yellow" fill="none" width={2} /></g>
            </g>
            <Chip x={N.review.cx} y={88} text="waiting on you" ink="yellow" at={4.0} />
            <path d="M616 130H677" pathLength={1} stroke={SOL.green} strokeWidth={2.2} fill="none" className="bj-draw" style={t(5.2, 0.25)} />
            <g className="bj-pop" style={t(5.5)}>
              <circle cx={N.exit.cx} cy={N.exit.cy} r={10} fill={SOL.green} />
              <path d="M699 130l3.5 3.5 6.5-7" stroke={SOL.base3} strokeWidth={2} fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </g>

            <Label x={20} y={248} lines={["max_visits on a node aborts the run when a loop passes through it more times than that."]} ink="base1" size={10} className="bj-fade" style={t(5.8)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Every node shape ──────────────────────────────────────────────────────

const SHAPES: { kind: string; name: string; type: string; lines: string[]; ink: Ink }[] = [
  { kind: "Mdiamond", name: "Mdiamond", type: "start", lines: ["where the run begins;", "exactly one"], ink: "base01" },
  { kind: "box", name: "box", type: "agent", lines: ["a session with a prompt;", "backend=claude, codex …"], ink: "blue" },
  { kind: "tab", name: "tab", type: "prompt", lines: ["one model call,", "no tools"], ink: "violet" },
  { kind: "parallelogram", name: "parallelogram", type: "command", lines: ["script=; the exit status", "routes, 120s default"], ink: "cyan" },
  { kind: "hexagon", name: "hexagon", type: "human gate", lines: ["waits for a person; its", "edges are the choices"], ink: "yellow" },
  { kind: "diamond", name: "diamond", type: "conditional", lines: ["routes on the", "condition= of its edges"], ink: "orange" },
  { kind: "component", name: "component", type: "fan-out", lines: ["starts its branches", "in parallel"], ink: "green" },
  { kind: "tripleoctagon", name: "tripleoctagon", type: "fan-in", lines: ["waits for the", "branches to join"], ink: "green" },
  { kind: "Msquare", name: "Msquare", type: "exit", lines: ["where the run ends;", "at least one"], ink: "base01" },
];

/** A node's shape is its type. */
export function NodeShapesFigure() {
  return (
    <Stage minWidth={620}>
      <Sheet w={760} h={276} label="The nine node shapes and the node type each one declares">
        {() => (
          <>
            {SHAPES.map((s, i) => {
              const col = i % 3;
              const row = Math.floor(i / 3);
              const x = 20 + col * 250;
              const y = 20 + row * 84;
              const w = s.kind === "Msquare" || s.kind === "Mdiamond" || s.kind === "diamond" ? 44 : 62;
              return (
                <g key={s.kind} className="bj-rise" style={t(0.1 + i * 0.12)}>
                  <Shape kind={s.kind} cx={x + 40} cy={y + 30} w={w} h={s.kind === "Mdiamond" || s.kind === "diamond" ? 44 : 38} ink={s.ink} fill={`${SOL[s.ink]}14`} width={1.5} />
                  <text x={x + 86} y={y + 14} fontSize="12" fontWeight={700} fill={SOL[s.ink]}>{s.type}</text>
                  <text x={x + 86} y={y + 28} fontSize="10" fill={SOL.base1}>shape={s.name}</text>
                  <Label x={x + 86} y={y + 44} lines={s.lines} ink="base01" size={10} />
                </g>
              );
            })}
          </>
        )}
      </Sheet>
    </Stage>
  );
}

// ─── Answering a gate ──────────────────────────────────────────────────────

function Btn({ children, ink, at }: { children: ReactNode; ink: string; at: number }) {
  return (
    <span className="inline-block font-mono text-[12px] px-2.5 py-1 rounded-md bj-pop" style={{ ...t(at), border: `1px solid ${ink}`, color: ink, backgroundColor: `${ink}12` }}>{children}</span>
  );
}

/** A gate's options are its out edges; a reply that starts with a key picks one and carries the rest forward. */
export function GateReplyFigure() {
  return (
    <Stage>
      <div className="grid grid-cols-1 *:min-w-0 md:grid-cols-[1.1fr_1fr]">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="The gate, wherever you are" sub="Dashboard buttons, a push notification, or a plain reply in the conversation." color={SOL.yellow} />
          <div className="m-4 rounded-lg p-3 font-mono text-[12px] bj-rise" style={{ ...t(0.1), backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}`, borderLeft: `3px solid ${SOL.yellow}` }}>
            <div style={{ color: SOL.base02 }}><b>ship</b> <span style={{ color: SOL.yellow }}>paused at Review</span></div>
            <div className="mt-1 text-[11px]" style={{ color: SOL.base01 }}>implement and verify passed · 2/3</div>
            <div className="mt-3 flex gap-2">
              <Btn ink={SOL.green} at={0.5}>[A] Approve</Btn>
              <Btn ink={SOL.orange} at={0.65}>[R] Revise</Btn>
            </div>
          </div>
          <div className="mx-4 mb-4 rounded-lg px-3 py-2 font-mono text-[12px] bj-rise" style={{ ...t(1.1), backgroundColor: SOL.base03, color: SOL.base2 }}>
            <span style={{ color: SOL.base01 }}>reply ›</span> R: guard the empty list before retrying
          </div>
        </div>
        <div className="p-4 font-mono text-[12px] space-y-3">
          <div className="bj-rise" style={t(1.6)}>
            <div className="text-[11px]" style={{ color: SOL.base1 }}>the key picks the edge</div>
            <div style={{ color: SOL.orange }}><b>R</b> → [R] Revise → Implement</div>
          </div>
          <div className="bj-rise" style={t(2.0)}>
            <div className="text-[11px]" style={{ color: SOL.base1 }}>the rest reaches the next node</div>
            <div style={{ color: SOL.base02 }}>human.message = “guard the empty list before retrying”</div>
          </div>
          <div className="bj-rise" style={t(2.4)}>
            <div className="text-[11px]" style={{ color: SOL.base1 }}>a reply naming no option</div>
            <div style={{ color: SOL.base02 }}>counts as success: unconditional edges</div>
          </div>
        </div>
      </div>
    </Stage>
  );
}
