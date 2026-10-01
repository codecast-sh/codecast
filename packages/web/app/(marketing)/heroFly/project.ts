/**
 * The camera's projection, the way CSS draws the world: a point is rotated
 * the way a surface's or the camera's transform list rotates it (rotateX,
 * rotateY, rotateZ, so Z applies first), carried into the camera's frame, and
 * projected through the stage's perspective onto the stage. world.ts places
 * surfaces with `rotateXYZ`; timeline.ts and the tests ask where on the stage
 * a point lands with `project`.
 */

import type { Pose, V3 } from "./world";

const rad = (d: number) => (d * Math.PI) / 180;

/** The stage's perspective distance and its origin (the stage's centre), per framing. */
export const PERSPECTIVE = 1800;
export const STAGE_SIZE = { desktop: { w: 1280, h: 760 }, mobile: { w: 640, h: 800 } };

/** `rotateX(ax) rotateY(ay) rotateZ(az)` applied to a point, in degrees. */
export function rotateXYZ([x, y, z]: V3, [ax, ay, az]: V3): V3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(ax)), Math.sin(rad(ax)), Math.cos(rad(ay)), Math.sin(rad(ay)), Math.cos(rad(az)), Math.sin(rad(az))];
  [x, y] = [x * cz - y * sz, x * sz + y * cz];
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  [y, z] = [y * cx - z * sx, y * sx + z * cx];
  return [x, y, z];
}

/** A world point in the camera's frame: `translateZ(dist) rotate(pitch, yaw, roll) translate(-pos)`. */
export function toCamera(p: Pose, [x, y, z]: V3): V3 {
  const [cx, cy, cz] = rotateXYZ([x - p.x, y - p.y, z - p.z], [p.pitch, p.yaw, p.roll]);
  return [cx, cy, cz + p.dist];
}

/** Where a world point lands on the stage, in stage px from its top-left; null when it is behind the eye. */
export function project(p: Pose, pt: V3, mobile = false): { x: number; y: number; scale: number } | null {
  const [x, y, z] = toCamera(p, pt);
  if (z >= PERSPECTIVE - 1) return null;
  const k = PERSPECTIVE / (PERSPECTIVE - z);
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  return { x: w / 2 + x * k, y: h / 2 + y * k, scale: k };
}
