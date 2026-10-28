"use client";
// The tree's edges into a lane or an indented row (orgLayout `route`): they
// enter a card's side, so a column of cards reads as one spine with a tick
// into each card and no line crosses a card above it.
import { BaseEdge, type Edge, type EdgeProps } from "@xyflow/react";
import { ORG_SIZES } from "./orgLayout";

/** `sw`: the source card's width; `tw`, `th`: the target's. */
export type RouteEdgeData = { route: "lane" | "spine"; sw: number; tw: number; th: number };

/** How far left of a lane's cards its spine runs, and in from a card's left edge for its own rows. */
const LANE_SPINE = 14;
const ROW_SPINE = 14;

/** An orthogonal polyline with rounded corners. */
function rounded(points: { x: number; y: number }[], r = 10): string {
  let d = `M ${points[0].x},${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]];
    const k = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2);
    const inX = b.x - Math.sign(b.x - a.x) * k, inY = b.y - Math.sign(b.y - a.y) * k;
    const outX = b.x + Math.sign(c.x - b.x) * k, outY = b.y + Math.sign(c.y - b.y) * k;
    d += ` L ${inX},${inY} Q ${b.x},${b.y} ${outX},${outY}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x},${last.y}`;
}

export function routePath(sx: number, sy: number, tx: number, ty: number, d: RouteEdgeData): string {
  const left = tx - d.tw / 2;
  const midY = ty + d.th / 2;
  if (d.route === "spine") {
    const x = sx - d.sw / 2 + ROW_SPINE;
    return rounded([{ x, y: sy }, { x, y: midY }, { x: left, y: midY }]);
  }
  const bus = sy + ORG_SIZES.levelGap / 2;
  const spine = left - LANE_SPINE;
  return rounded([{ x: sx, y: sy }, { x: sx, y: bus }, { x: spine, y: bus }, { x: spine, y: midY }, { x: left, y: midY }]);
}

export function RouteEdge({ id, sourceX, sourceY, targetX, targetY, data, style }: EdgeProps<Edge<RouteEdgeData>>) {
  return <BaseEdge id={id} path={routePath(sourceX, sourceY, targetX, targetY, data!)} style={style} />;
}
