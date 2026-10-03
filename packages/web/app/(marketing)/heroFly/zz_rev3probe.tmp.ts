import { CAMERA, SURFACES, subjectBox, DURATION, SCENES } from "./world";
import { cameraAt, frame, presence } from "./timeline";
import { coverage, shownRects } from "./filmQa";
import { STAGE_SIZE } from "./project";
for (const mobile of [false, true]) {
  const { w, h } = mobile ? STAGE_SIZE.mobile : STAGE_SIZE.desktop;
  console.log(`\n=== ${mobile ? "MOBILE" : "DESKTOP"} stage ${w}x${h}`);
  CAMERA.slice(0, -1).forEach((hd, i) => {
    const t = (hd.t0 + hd.t1) / 2;
    const b = subjectBox(hd.sees, cameraAt(t, mobile).pose, mobile)!;
    console.log(`hold ${i} ${hd.sees.join("+")} ${hd.t0}-${hd.t1}: box x ${b.x0.toFixed(0)}..${b.x1.toFixed(0)} y ${b.y0.toFixed(0)}..${b.y1.toFixed(0)}  L ${b.x0.toFixed(0)} R ${(w-b.x1).toFixed(0)} T ${b.y0.toFixed(0)} B ${(h-b.y1).toFixed(0)} cov ${coverage(t, mobile).toFixed(2)}`);
  });
  for (let i = 0; i + 1 < CAMERA.length; i++) {
    const [a, bb] = [CAMERA[i], CAMERA[i + 1]];
    let minC = 9, minT = 0, maxV = 0, maxVT = 0; const strangers = new Set<string>();
    let prevPose = cameraAt(a.t1, mobile).pose;
    for (let t = a.t1; t <= Math.min(bb.t0, DURATION - 1e-6); t += 1 / 60) {
      const c = coverage(t, mobile);
      if (c < minC) { minC = c; minT = t; }
      for (const r of shownRects(t, mobile)) {
        if (a.sees.includes(r.id) || bb.sees.includes(r.id)) continue;
        const xs = r.pts.map((p) => p.x);
        if (Math.max(...xs) > 0 && Math.min(...xs) < w && r.o > 0.02) strangers.add(`${r.id}@${t.toFixed(2)}`);
      }
      const p = cameraAt(t, mobile).pose;
      const v = Math.hypot(p.x - prevPose.x, p.y - prevPose.y) * 60;
      if (v > maxV) { maxV = v; maxVT = t; }
      prevPose = p;
    }
    const ends = [coverage(a.t1, mobile), coverage(Math.min(bb.t0, DURATION - 1e-6), mobile)];
    console.log(`move ${i} ${a.sees.join("+")} -> ${bb.sees.join("+")} ${a.t1}..${bb.t0} (${(bb.t0 - a.t1).toFixed(2)}s): cov ends ${ends.map(c=>c.toFixed(2)).join("/")} min ${minC.toFixed(2)} @${minT.toFixed(2)}  peak cam ${maxV.toFixed(0)} world px/s @${maxVT.toFixed(2)}  strangers ${[...strangers].slice(0,4).join(",")}`);
  }
}
