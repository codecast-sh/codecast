import { project, STAGE_SIZE } from "./project";
import { cameraAt } from "./timeline";
import { CAMERA, SURFACES, localToWorld } from "./world";
const mobile = process.argv[2] === "m";
const only = process.argv[3] ? process.argv[3].split(",").map(Number) : null;
const H = mobile ? STAGE_SIZE.mobile.h : STAGE_SIZE.desktop.h;
const PX = mobile ? [-60, 700] : [-700, 1980];
CAMERA.forEach((h, i) => {
  if (only && !only.includes(i)) return;
  const rows: string[] = [];
  for (const s of SURFACES) {
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    let behind = false;
    for (let t = h.t0; t <= h.t1 + 1e-9; t += 0.1) {
      const { pose } = cameraAt(t, mobile);
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        const p = project(pose, localToWorld(s.id, (a * s.w) / 2, (b * s.h) / 2), mobile);
        if (!p) { behind = true; continue; }
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
    }
    const onPage = x1 > PX[0] && x0 < PX[1] && y1 > 0 && y0 < H;
    if (!onPage && !behind) continue;
    const cross = y0 < 2 || y1 > H - 2;
    const inBox = x1 > 0 && x0 < (mobile ? 640 : 1280);
    rows.push(`  ${cross ? "X" : " "}${inBox ? "*" : " "} ${s.id.padEnd(8)} x ${x0.toFixed(0)}..${x1.toFixed(0)}  y ${y0.toFixed(0)}..${y1.toFixed(0)}${behind ? " BEHIND" : ""}`);
  }
  console.log(`H${i} ${h.t0}-${h.t1} sees ${h.sees}`);
  console.log(rows.join("\n"));
});
