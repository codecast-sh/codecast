import { localToWorld } from "./world";
const rad = (d: number) => (d * Math.PI) / 180;
const W = 1280, H = 760, D = 1800;
function cam(p: any, [x, y, z]: number[]) {
  x -= p.x; y -= p.y; z -= p.z;
  const az = rad(p.roll), ay = rad(p.yaw), ax = rad(p.pitch);
  [x, y] = [x * Math.cos(az) - y * Math.sin(az), x * Math.sin(az) + y * Math.cos(az)];
  [x, z] = [x * Math.cos(ay) + z * Math.sin(ay), -x * Math.sin(ay) + z * Math.cos(ay)];
  [y, z] = [y * Math.cos(ax) - z * Math.sin(ax), y * Math.sin(ax) + z * Math.cos(ax)];
  z += p.dist; const k = D / (D - z);
  return [Math.round(W / 2 + x * k), Math.round(H / 2 + y * k)];
}
const [id, ...rest] = process.argv.slice(2);
const [x, y, z, pitch, yaw, roll, dist, ...pts] = rest.map(Number);
const p = { x, y, z, pitch, yaw, roll, dist };
for (let i = 0; i < pts.length; i += 2) console.log(`(${pts[i]},${pts[i + 1]}) ->`, cam(p, localToWorld(id as any, pts[i], pts[i + 1])));
