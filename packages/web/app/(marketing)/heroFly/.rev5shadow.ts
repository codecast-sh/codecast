import { CAMERA, SURFACES, LIVE, localToWorld } from "./world";
import { cameraAt } from "./timeline";
const rad = (d: number) => (d * Math.PI) / 180;
const W = 1280, H = 760, D = 1800;
function cam(p: any, [x, y, z]: number[]) {
  x -= p.x; y -= p.y; z -= p.z;
  const az = rad(p.roll), ay = rad(p.yaw), ax = rad(p.pitch);
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  z += p.dist; const k = D / (D - z);
  return [W / 2 + x * k, H / 2 + y * k];
}
const inBox = (b: number[]) => !(b[2] < 0 || b[0] > W || b[3] < 0 || b[1] > H);
const bb = (pts: number[][]) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round); };
const ts = process.argv.slice(2).map(Number);
for (const t of ts) {
  const { pose } = cameraAt(t); const out: string[] = [];
  for (const s of SURFACES) {
    if (!LIVE[s.id].some(([a, b]) => t >= a && t <= b)) continue;
    const surf = bb([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => cam(pose, localToWorld(s.id, (a * s.w) / 2, (b * s.h) / 2))));
    const Hh = s.pos[2] + 420;
    const tilt = Math.sin((Math.max(Math.abs(s.rot[0]), Math.abs(s.rot[1])) * Math.PI) / 180) * (Math.max(s.w, s.h) / 2);
    const clear = 12 + tilt * 1.1; const sc = 1 + Hh / 1400;
    const cy = 0.08 * s.h + 18 + Hh * 0.06, cz = -Hh + clear;
    const sh = bb([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => cam(pose, localToWorld(s.id, a * 0.56 * s.w * sc, cy + b * 0.56 * s.h * sc, cz))));
    out.push(`${s.id} surf${inBox(surf) ? "IN" : "out"}[${surf}] shadow${inBox(sh) ? "IN" : "out"}[${sh}]`);
  }
  console.log(t, out.join(" ; "));
}
