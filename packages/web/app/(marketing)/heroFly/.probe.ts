import { project, STAGE_SIZE } from "./project";
import { cameraAt } from "./timeline";
import { CAMERA, CAMERA_MOBILE, DURATION, SURFACES, localToWorld } from "./world";
const mode = process.argv[2] === "m";
const H = mode ? STAGE_SIZE.mobile.h : STAGE_SIZE.desktop.h;
const RX = mode ? [-60, 700] : [-350, 1630];
const holdOf = (t: number) => CAMERA.findIndex((h) => t >= h.t0 && t <= h.t1);
const out: Record<string, string[]> = {};
for (const s of SURFACES) {
  let run: [number, number, number] | null = null;
  const runs: string[] = [];
  for (let t = 0; t < DURATION; t += 1 / 30) {
    const { pose } = cameraAt(t, mode);
    const ps = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => project(pose, localToWorld(s.id, (a * s.w) / 2, (b * s.h) / 2), mode));
    let cross = 0;
    if (ps.some((p) => !p)) cross = -1;
    else {
      const xs = ps.map((p) => p!.x), ys = ps.map((p) => p!.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const seen = x1 > RX[0] && x0 < RX[1] && y1 > 0 && y0 < H;
      if (seen && (y0 < 0 || y1 > H)) cross = Math.round(Math.max(-y0, y1 - H));
    }
    if (cross) {
      if (run) { run[1] = t; run[2] = Math.max(run[2], cross); } else run = [t, t, cross];
    } else if (run) { runs.push(`${run[0].toFixed(1)}-${run[1].toFixed(1)}(${run[2]}${[...new Set([holdOf(run[0]), holdOf(run[1])])].filter((h) => h >= 0).map((h) => " H" + h).join("")})`); run = null; }
  }
  if (run) runs.push(`${run[0].toFixed(1)}-end`);
  out[s.id] = runs;
}
for (const [k, v] of Object.entries(out)) console.log(k.padEnd(8), v.join("  "));
