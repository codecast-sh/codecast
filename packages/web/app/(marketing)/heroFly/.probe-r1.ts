// Ad hoc motion probe for polish round 1 (deleted when done).
import { coverage, shownRects } from "./filmQa";
import { cameraAt, frame, presence } from "./timeline";
import { projector, STAGE_SIZE } from "./project";
import { CAMERA, DURATION, SURFACES, subjectBox } from "./world";

const which = process.argv[2] ?? "all";
for (const mobile of [false, true]) {
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  console.log(mobile ? "\n=== MOBILE" : "=== DESKTOP");
  if (which === "all" || which === "moves") {
    for (let i = 0; i + 1 < CAMERA.length; i++) {
      const [a, b] = [CAMERA[i], CAMERA[i + 1]];
      const issues: string[] = [];
      let minCov = 1;
      let minCovT = 0;
      let peak = 0;
      let prevPts: Map<string, { x: number; y: number }[]> | null = null;
      for (let t = a.t1; t <= b.t0; t += 1 / 60) {
        const tt = Math.min(t, DURATION - 1e-6);
        const f = frame(tt, mobile);
        const c = coverage(tt, mobile, f);
        if (c < minCov) [minCov, minCovT] = [c, tt];
        const rects = shownRects(tt, mobile, f);
        const cur = new Map(rects.map((r) => [r.id, r.pts]));
        for (const r of rects) {
          const xs = r.pts.map((p) => p.x);
          const width = Math.max(...xs) - Math.min(...xs);
          const inBox = Math.max(0, Math.min(w, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
          const share = inBox / width;
          const pr = presence(r.id, tt, mobile).o;
          if (r.o < 0.98 && share > 0.1) issues.push(`${tt.toFixed(2)} ${r.id} o=${r.o.toFixed(2)} (presence ${pr.toFixed(2)}) inBox ${(share * 100).toFixed(0)}% (${inBox.toFixed(0)}px)`);
          const p = prevPts?.get(r.id);
          if (p && share > 0) peak = Math.max(peak, ...r.pts.map((q, k) => Math.hypot(q.x - p[k].x, q.y - p[k].y) * 60));
        }
        prevPts = cur;
      }
      // Collapse issues to first/last per surface.
      const bySurf = new Map<string, string[]>();
      for (const s of issues) {
        const id = s.split(" ")[1];
        (bySurf.get(id) ?? bySurf.set(id, []).get(id)!).push(s);
      }
      const lines = [...bySurf.values()].map((v) => `    ${v.length}x  first ${v[0]}  |  last ${v[v.length - 1].split(" ").slice(0, 3).join(" ")}`);
      console.log(`${a.t1.toFixed(1)}->${b.t0.toFixed(1)} ${a.sees.join("+")} -> ${b.sees.join("+")}: minCov ${minCov.toFixed(2)}@${minCovT.toFixed(2)} peak ${peak.toFixed(0)}px/s cov(a.t1)=${coverage(a.t1, mobile).toFixed(2)} cov(b.t0)=${coverage(Math.min(b.t0, DURATION - 1e-6), mobile).toFixed(2)}`);
      lines.forEach((l) => console.log(l));
    }
  }
  if (which === "all" || which === "holds") {
    CAMERA.forEach((hd, i) => {
      const out: string[] = [];
      for (const v of [0, 0.5, 1]) {
        const t = hd.t0 + (hd.t1 - hd.t0) * v;
        const bx = subjectBox(hd.sees, cameraAt(Math.min(t, DURATION - 1e-6), mobile).pose, mobile)!;
        out.push(`v${v}: L${bx.x0.toFixed(0)} R${(w - bx.x1).toFixed(0)} T${bx.y0.toFixed(0)} B${(h - bx.y1).toFixed(0)}`);
      }
      console.log(`hold ${i} ${hd.sees.join("+")} ${out.join("  ")}`);
    });
  }
}
void projector;
void SURFACES;
