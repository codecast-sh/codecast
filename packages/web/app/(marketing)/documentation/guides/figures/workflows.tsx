"use client";

import { SOL } from "../../../blog/blogChrome";
import { Stage, t } from "../../../blog/figureKit";
import { Label, Sheet, type Ink } from "../figureParts";

/**
 * Figures for the workflows guide: one run of a build, check and approve
 * workflow, drawn with the node shapes the run page's graph uses.
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
              <Name x={N.implement.cx} y={N.implement.cy} title="Implement" sub="an agent" />
              <Name x={N.verify.cx} y={N.verify.cy} title="Verify" sub="typecheck" />
              <Name x={N.review.cx} y={N.review.cy} title="Review" sub="you approve" />
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
            <Label x={448} y={170} lines={["passes"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />
            <Label x={246} y={222} lines={["fails"]} anchor="middle" ink="base01" size={10} className="bj-fade" style={t(0.3)} />
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

            <Label x={20} y={248} lines={["A loop can carry a limit, so a run that keeps failing stops instead of looping forever."]} ink="base1" size={10} className="bj-fade" style={t(5.8)} />
          </>
        )}
      </Sheet>
    </Stage>
  );
}
