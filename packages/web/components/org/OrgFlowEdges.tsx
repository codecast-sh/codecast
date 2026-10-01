"use client";
// The health map's two edges (HealthBoard, orgFlow.ts). A reporting edge into
// a role carries the week's work that reached it: its width grows with the
// count, dots travel down it faster the busier it is, and it turns orange
// when the role sat at its daily limit. A handoff edge is one role sending
// another work, drawn as a curve beside the tree so it never hides a
// reporting line. Both dim when another role is in focus.
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps, type Edge } from "@xyflow/react";
import { useSyncExternalStore } from "react";

export type FlowEdgeData = { n: number; max: number; hot: boolean; dim: boolean; focus: boolean };
export type FlowSendData = { n: number; max: number; dim: boolean; focus: boolean; lane: number };

const REACHED = "var(--sol-blue)";
const LIMIT = "var(--sol-orange)";
const SENT = "var(--sol-violet)";

const motionQuery = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => { const m = window.matchMedia(motionQuery); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => window.matchMedia(motionQuery).matches,
    () => true,
  );
}

/** Width on a square root scale: a role with 4× the work reads twice as heavy, not 4×. */
const widthOf = (n: number, max: number) => (n <= 0 ? 1.25 : 1.5 + 7 * Math.sqrt(n / Math.max(1, max)));

function Dots({ path, n, max, color, r }: { path: string; n: number; max: number; color: string; r: number }) {
  const reduced = useReducedMotion();
  if (reduced || n <= 0) return null;
  const share = n / Math.max(1, max);
  const count = Math.max(1, Math.min(5, Math.round(1 + 4 * share)));
  const dur = Math.max(1.8, 6 - 4 * share);
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} r={r} fill={color} opacity={0.9}>
          <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={path} begin={`-${(i * dur) / count}s`} />
        </circle>
      ))}
    </>
  );
}

function Count({ x, y, text, color, strong }: { x: number; y: number; text: string; color: string; strong: boolean }) {
  return (
    <EdgeLabelRenderer>
      <div
        className="nodrag nopan pointer-events-none absolute rounded-full px-1.5 h-[18px] inline-flex items-center text-[10.5px] font-semibold tabular-nums border whitespace-nowrap"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: "var(--sol-bg)", opacity: strong ? 1 : 0.35 }}
      >
        {text}
      </div>
    </EdgeLabelRenderer>
  );
}

export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<Edge<FlowEdgeData>>) {
  const d = data!;
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14 });
  const color = d.hot ? LIMIT : REACHED;
  const w = widthOf(d.n, d.max);
  const opacity = d.dim ? 0.14 : d.focus ? 0.85 : 0.5;
  return (
    <g data-flow-edge={id} data-flow-n={d.n}>
      <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: w, strokeOpacity: opacity, strokeLinecap: "round", transition: "stroke-opacity 200ms, stroke-width 260ms" }} />
      {!d.dim && <Dots path={path} n={d.n} max={d.max} color={color} r={Math.min(3.5, 1.6 + w * 0.22)} />}
      {d.n > 0 && <Count x={lx} y={ly} text={`${d.n}/wk`} color={color} strong={!d.dim} />}
    </g>
  );
}

export function FlowSendEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<FlowSendData>>) {
  const d = data!;
  // Bowed out to one side, a lane per pair, so a handoff along a reporting
  // line sits beside it instead of on top of it.
  const off = 70 + d.lane * 26;
  const dy = Math.max(60, Math.abs(targetY - sourceY));
  const path = `M ${sourceX},${sourceY} C ${sourceX + off},${sourceY + dy * 0.45} ${targetX + off},${targetY - dy * 0.45} ${targetX},${targetY}`;
  const lx = (sourceX + targetX) / 2 + off * 0.75;
  const ly = (sourceY + targetY) / 2;
  const opacity = d.dim ? 0.12 : 0.8;
  return (
    <g data-flow-send={id} data-flow-n={d.n}>
      <BaseEdge id={id} path={path} style={{ stroke: SENT, strokeWidth: 1 + 2.5 * Math.sqrt(d.n / Math.max(1, d.max)), strokeOpacity: opacity, strokeDasharray: "5 4", transition: "stroke-opacity 200ms" }} className="org-flow-dash" />
      {!d.dim && <Dots path={path} n={d.n} max={d.max} color={SENT} r={2.2} />}
      <Count x={lx} y={ly} text={`${d.n} handed`} color={SENT} strong={!d.dim} />
    </g>
  );
}

export const ORG_FLOW_EDGE_TYPES = { flow: FlowEdge, flowSend: FlowSendEdge };
