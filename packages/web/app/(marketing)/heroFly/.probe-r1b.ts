import { cameraAt, presence } from "./timeline";
import { projector } from "./project";
import { SURFACES, localToWorld } from "./world";
const id = (process.argv[2] ?? "desk") as any;
const [t0, t1] = [Number(process.argv[3] ?? 16.5), Number(process.argv[4] ?? 18.3)];
const mobile = process.argv[5] === "m";
const s = SURFACES.find((x) => x.id === id)!;
const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => localToWorld(id, (a * s.w) / 2, (b * s.h) / 2));
for (let t = t0; t <= t1; t += 0.05) {
  const { pose } = cameraAt(t, mobile);
  const at = projector(pose, mobile);
  const p = corners.map((c) => at(c));
  const xs = p.map((q) => q?.x ?? NaN), ys = p.map((q) => q?.y ?? NaN);
  console.log(t.toFixed(2), `pose x${pose.x.toFixed(0)} z${pose.z.toFixed(0)} yaw${pose.yaw.toFixed(1)} roll${pose.roll.toFixed(2)} dist${pose.dist.toFixed(0)}`, `x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)} y ${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)}`, `pres ${presence(id, t, mobile).o.toFixed(2)}`);
}
