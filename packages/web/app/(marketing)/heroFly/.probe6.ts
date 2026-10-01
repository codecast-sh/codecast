import { project } from "./project";
import { cameraAt, frame } from "./timeline";
import { ARCS, FLYERS } from "./motion";
import { LABEL_3W } from "./world";
for (const mobile of [false, true]) {
  const H = mobile ? 800 : 760;
  const stat: Record<string, [number, number, number, number]> = {};
  for (let t = 0; t < 88.8; t += 1 / 30) {
    const f = frame(t, mobile);
    const { pose } = cameraAt(t, mobile);
    const pts: [string, number[]][] = [];
    for (const fl of FLYERS) {
      const e = f.els[fl.id];
      if ((e.opacity ?? 0) <= 0.02) continue;
      const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, (-?[\d.]+)px\)/.exec(e.transform!);
      if (m) pts.push([fl.id, m.slice(1).map(Number)]);
    }
    for (const a of ARCS) {
      if ((f.els[a.id].opacity ?? 0) <= 0.02) continue;
      const apexY = Math.min(a.from[1], a.to[1]) - (a.apex ?? 170);
      pts.push([a.id + ":from", a.from as number[]], [a.id + ":to", a.to as number[]], [a.id + ":apex", [(a.from[0] + a.to[0]) / 2, apexY / 2 + Math.min(a.from[1], a.to[1]) / 2, (a.from[2] + a.to[2]) / 2]]);
    }
    if ((f.els.label3w.opacity ?? 0) > 0.02) pts.push(["label3w", LABEL_3W.pos as number[]]);
    for (const [id, p] of pts) {
      const q = project(pose, p as any, mobile);
      if (!q) continue;
      const s = (stat[id] ??= [Infinity, -Infinity, Infinity, -Infinity]);
      s[0] = Math.min(s[0], q.y); s[1] = Math.max(s[1], q.y); s[2] = Math.min(s[2], q.x); s[3] = Math.max(s[3], q.x);
    }
  }
  console.log(mobile ? "MOBILE" : "DESKTOP");
  for (const [id, [y0, y1, x0, x1]] of Object.entries(stat)) console.log(`${y0 < 40 || y1 > H - 40 ? "!" : " "} ${id.padEnd(34)} y ${y0.toFixed(0)}..${y1.toFixed(0)}  x ${x0.toFixed(0)}..${x1.toFixed(0)}`);
}
