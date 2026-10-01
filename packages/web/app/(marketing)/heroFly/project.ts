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

/** `rotateX(ax) rotateY(ay) rotateZ(az)` as a function of a point, in degrees, its sines and cosines worked out once. */
export function rotation([ax, ay, az]: V3): (pt: V3) => V3 {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(rad(ax)), Math.sin(rad(ax)), Math.cos(rad(ay)), Math.sin(rad(ay)), Math.cos(rad(az)), Math.sin(rad(az))];
  return ([x, y, z]) => {
    [x, y] = [x * cz - y * sz, x * sz + y * cz];
    [x, z] = [x * cy + z * sy, -x * sy + z * cy];
    [y, z] = [y * cx - z * sx, y * sx + z * cx];
    return [x, y, z];
  };
}

/** `rotateX(ax) rotateY(ay) rotateZ(az)` applied to a point, in degrees. */
export const rotateXYZ = (pt: V3, rot: V3): V3 => rotation(rot)(pt);

/** A world point in the camera's frame: `translateZ(dist) rotate(pitch, yaw, roll) translate(-pos)`. */
export function toCamera(p: Pose, [x, y, z]: V3): V3 {
  const [cx, cy, cz] = rotateXYZ([x - p.x, y - p.y, z - p.z], [p.pitch, p.yaw, p.roll]);
  return [cx, cy, cz + p.dist];
}

export type Projected = { x: number; y: number; scale: number };

/** `project` for many points under one pose: the camera's rotation is worked out once. */
export function projector(p: Pose, mobile = false): (pt: V3) => Projected | null {
  const turn = rotation([p.pitch, p.yaw, p.roll]);
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  return ([x, y, z]) => {
    const [cx, cy, cz] = turn([x - p.x, y - p.y, z - p.z]);
    const d = cz + p.dist;
    if (d >= PERSPECTIVE - 1) return null;
    const k = PERSPECTIVE / (PERSPECTIVE - d);
    return { x: w / 2 + cx * k, y: h / 2 + cy * k, scale: k };
  };
}

/** Where a world point lands on the stage, in stage px from its top-left; null when it is behind the eye. */
export const project = (p: Pose, pt: V3, mobile = false): Projected | null => projector(p, mobile)(pt);
