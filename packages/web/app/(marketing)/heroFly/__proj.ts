// Temporary: project surface rects into the 1280x760 stage for a film time.
import { cameraAt } from "./timeline";
import { surfacePt, regionOf, type SurfaceId, type RegionKey } from "./world";
const rad = (d: number) => (d * Math.PI) / 180;
type V = [number, number, number];
const rotX = ([x, y, z]: V, a: number): V => [x, y * Math.cos(rad(a)) - z * Math.sin(rad(a)), y * Math.sin(rad(a)) + z * Math.cos(rad(a))];
const rotY = ([x, y, z]: V, a: number): V => [x * Math.cos(rad(a)) + z * Math.sin(rad(a)), y, -x * Math.sin(rad(a)) + z * Math.cos(rad(a))];
const rotZ = ([x, y, z]: V, a: number): V => [x * Math.cos(rad(a)) - y * Math.sin(rad(a)), x * Math.sin(rad(a)) + y * Math.cos(rad(a)), z];
export function project(p: V, t: number, mobile = false) {
  const env = process.env.POSE?.split(",").map(Number);
  const pose = env ? { x: env[0], y: env[1], z: env[2], pitch: env[3], yaw: env[4], roll: env[5], dist: env[6] } : cameraAt(t, mobile).pose;
  const rel: V = [p[0] - pose.x, p[1] - pose.y, p[2] - pose.z];
  let c = rotX(rotY(rotZ(rel, pose.roll), pose.yaw), pose.pitch);
  const Z = c[2] + pose.dist;
  const k = 1800 / (1800 - Z);
  const [W, H] = mobile ? [640, 800] : [1280, 760];
  return [Math.round(W / 2 + c[0] * k), Math.round(H / 2 + c[1] * k)];
}
export function rect(key: RegionKey | SurfaceId, t: number, mobile = false) {
  let sid: SurfaceId, x = 0, y = 0, w: number, h: number;
  if (key.includes(".")) { const r = regionOf(key as RegionKey); sid = r.surface.id; ({ x, y, w, h } = r.region); }
  else { const { SURFACE_BY_ID } = require("./world"); const s = SURFACE_BY_ID[key]; sid = key as SurfaceId; w = s.w; h = s.h; }
  const a = project(surfacePt(sid, x, y), t, mobile), b = project(surfacePt(sid, x + w, y + h), t, mobile);
  return `${key}@${t}${mobile ? "m" : ""}: L${a[0]} T${a[1]} R${b[0]} B${b[1]}`;
}
const args = process.argv.slice(2);
const mobile = args.includes("-m");
const t = Number(args[0]);
for (const k of args.slice(1).filter((a) => a !== "-m")) console.log(rect(k as any, t, mobile));
// POSE=x,y,z,pitch,yaw,roll,dist overrides the camera for a static check.
