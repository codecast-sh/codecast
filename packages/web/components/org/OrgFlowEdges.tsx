"use client";
// This week's two edges on the People map (OrgMap, orgFlow.ts). A reporting edge into
// a role carries the week's work that reached it: its width grows with the
// count, dots travel down it faster the busier it is, and it turns orange
// when the role sat at its daily limit. A handoff edge is one role sending
// another work, drawn as a curve beside the tree so it never hides a
// reporting line. The counts live on the cards; an edge names its count only
// while its role is in focus, and every other edge dims.
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps, type Edge } from "@xyflow/react";
import { useSyncExternalStore } from "react";

/** The card sizes a spine needs: the handles sit at the middle of a card's
 *  top and bottom, and the spine runs down its left edge into the child's side. */
export type FlowSpine = { w: number; h: number };
export type FlowEdgeData = { n: number; max: number; hot: boolean; dim: boolean; focus: boolean; spine?: FlowSpine };
export type FlowSendData = { n: number; max: number; dim: boolean; focus: boolean; lane: number; spine?: FlowSpine };

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
  const [path, lx, ly] = d.spine ? spinePath(sourceX, sourceY, targetX, targetY, d.spine) : getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 14 });
  const color = d.hot ? LIMIT : REACHED;
  const w = widthOf(d.n, d.max);
  const opacity = d.dim ? 0.14 : d.focus ? 0.85 : 0.5;
  return (
    <g data-flow-edge={id} data-flow-n={d.n}>
      <BaseEdge id={id} path={path} style={{ stroke: color, strokeWidth: w, strokeOpacity: opacity, strokeLinecap: "round", transition: "stroke-opacity 200ms, stroke-width 260ms" }} />
      {!d.dim && <Dots path={path} n={d.n} max={d.max} color={color} r={Math.min(3.5, 1.6 + w * 0.22)} />}
      {d.focus && d.n > 0 && <Count x={lx} y={ly} text={`${d.n} in this week`} color={color} strong />}
    </g>
  );
}

export function FlowSendEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<Edge<FlowSendData>>) {
  const d = data!;
  const [path, lx, ly] = d.spine ? sidePath(sourceX, sourceY, targetX, targetY, d.spine, d.lane) : bowPath(sourceX, sourceY, targetX, targetY, d.lane);
  const opacity = d.dim ? 0.12 : 0.8;
  return (
    <g data-flow-send={id} data-flow-n={d.n}>
      <BaseEdge id={id} path={path} style={{ stroke: SENT, strokeWidth: 1 + 2.5 * Math.sqrt(d.n / Math.max(1, d.max)), strokeOpacity: opacity, strokeDasharray: "5 4", transition: "stroke-opacity 200ms" }} className="org-flow-dash" />
      {!d.dim && <Dots path={path} n={d.n} max={d.max} color={SENT} r={2.2} />}
      {d.focus && <Count x={lx} y={ly} text={`${d.n} handed over`} color={SENT} strong />}
    </g>
  );
}

/** Down the parent's left edge, then into the middle of the child's side. */
function spinePath(sx: number, sy: number, tx: number, ty: number, { w, h }: FlowSpine): [string, number, number] {
  const x = sx - w / 2 + 18;
  const midY = ty + h / 2;
  const left = tx - w / 2;
  const r = Math.min(10, Math.max(0, left - x));
  return [`M ${x},${sy} L ${x},${midY - r} Q ${x},${midY} ${x + r},${midY} L ${left},${midY}`, x, (sy + midY) / 2];
}

/** A handoff between cards in columns: side to side, bowed out when both sit in one column. */
function sidePath(sx: number, sy: number, tx: number, ty: number, { w, h }: FlowSpine, lane: number): [string, number, number] {
  const a = { x: sx, y: sy - h / 2 };
  const b = { x: tx, y: ty + h / 2 };
  if (Math.abs(a.x - b.x) < w) {
    const x0 = Math.max(a.x, b.x) + w / 2;
    const off = 36 + lane * 18;
    return [`M ${x0},${a.y} C ${x0 + off},${a.y} ${x0 + off},${b.y} ${x0},${b.y}`, x0 + off * 0.75, (a.y + b.y) / 2];
  }
  const dir = b.x > a.x ? 1 : -1;
  const x0 = a.x + (dir * w) / 2;
  const x1 = b.x - (dir * w) / 2;
  const mid = (x0 + x1) / 2;
  return [`M ${x0},${a.y} C ${mid},${a.y + lane * 10} ${mid},${b.y + lane * 10} ${x1},${b.y}`, mid, (a.y + b.y) / 2];
}

/** A handoff on the tree's own layout: bowed out to one side, a lane per pair. */
function bowPath(sx: number, sy: number, tx: number, ty: number, lane: number): [string, number, number] {
  const off = 70 + lane * 26;
  const dy = Math.max(60, Math.abs(ty - sy));
  return [`M ${sx},${sy} C ${sx + off},${sy + dy * 0.45} ${tx + off},${ty - dy * 0.45} ${tx},${ty}`, (sx + tx) / 2 + off * 0.75, (sy + ty) / 2];
}

export const ORG_FLOW_EDGE_TYPES = { flow: FlowEdge, flowSend: FlowSendEdge };
