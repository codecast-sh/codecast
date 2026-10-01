import { presence } from "./timeline";
import { CAMERA, SURFACES } from "./world";
for (const mobile of [false, true]) {
  CAMERA.forEach((h, i) => {
    const ids = h.sees === "all" ? SURFACES.map((s) => s.id) : h.sees;
    for (const id of ids) {
      let lo = 1, at = -1;
      for (let t = h.t0; t <= h.t1; t += 0.05) { const o = presence(id, t, mobile).o; if (o < lo) { lo = o; at = t; } }
      if (lo < 1) console.log(mobile ? "M" : "D", `H${i}`, id, lo.toFixed(2), "at", at.toFixed(2));
    }
  });
}
