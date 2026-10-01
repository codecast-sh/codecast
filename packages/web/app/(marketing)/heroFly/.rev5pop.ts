import { SURFACES, LIVE, localToWorld } from "./world";
import { cameraAt, frame } from "./timeline";
const rad = (d: number) => (d * Math.PI) / 180;
const W = 1280, H = 760, D = 1800, EX = 347, EY = 55;
function cam(p: any, [x, y, z]: number[]) {
  x -= p.x; y -= p.y; z -= p.z;
  const az = rad(p.roll), ay = rad(p.yaw), ax = rad(p.pitch);
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  z += p.dist; const k = D / (D - z);
  return [W / 2 + x * k, H / 2 + y * k, z];
}
for (const s of SURFACES) for (const [a, b] of LIVE[s.id]) for (const t of [a, b]) {
  if (t <= 0 || t >= 88.8) continue;
  const { pose } = cameraAt(t);
  const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => cam(pose, localToWorld(s.id, (u * s.w) / 2, (v * s.h) / 2)));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round);
  const inside = !(box[2] < -EX || box[0] > W + EX || box[3] < -EY || box[1] > H + EY);
  if (!inside) continue;
  const f: any = frame(t); const els = f.els ?? f;
  console.log(s.id, t === a ? "appears" : "vanishes", t, JSON.stringify(box), "faceOp", els[`face:${s.id}`]?.opacity ?? 1, "card", els[`card:${s.id}`]?.transform);
}
