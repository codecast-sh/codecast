import { CAMERA, SURFACES, localToWorld } from "./world";
import { cameraAt } from "./timeline";
const rad = (d: number) => (d * Math.PI) / 180;
const W = 1280, H = 760, D = 1800;
function cam(p: any, [x, y, z]: number[]) {
  x -= p.x; y -= p.y; z -= p.z;
  const az = rad(p.roll), ay = rad(p.yaw), ax = rad(p.pitch);
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  z += p.dist;
  const k = D / (D - z);
  return [W / 2 + x * k, H / 2 + y * k, k];
}
const ts = process.argv.slice(2).map(Number);
const list = ts.length ? ts : CAMERA.flatMap((h) => [h.t0, (h.t0 + h.t1) / 2, h.t1]);
for (const t of list) {
  const { pose } = cameraAt(t);
  const out: string[] = [];
  for (const s of SURFACES) {
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => cam(pose, localToWorld(s.id, (a * s.w) / 2, (b * s.h) / 2)));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map(Math.round);
    if (x1 < 0 || x0 > W || y1 < 0 || y0 > H) continue;
    if (pts.some((p) => p[2] <= 0)) { out.push(`${s.id}:behind`); continue; }
    const flags = [y0 < 0 ? `top${y0}` : "", y1 > H ? `bot+${y1 - H}` : "", x0 < 0 ? `L${x0}` : "", x1 > W ? `R+${x1 - W}` : ""].filter(Boolean).join(",");
    out.push(`${s.id}[${x0},${y0}..${x1},${y1}]${flags ? "{" + flags + "}" : ""}`);
  }
  console.log(t.toFixed(2).padStart(6), out.join("  "));
}
