import { project } from "./project";
import { cameraAt, frame, presence } from "./timeline";
for (const mobile of [false, true]) for (let t = 41.9; t < 43.5; t += 0.1) {
  const f = frame(t, mobile); const e = f.els["work.task"];
  const m = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px, (-?[\d.]+)px\)/.exec(e.transform!);
  const q = m ? project(cameraAt(t, mobile).pose, m.slice(1, 4).map(Number) as any, mobile) : null;
  console.log(mobile ? "M" : "D", t.toFixed(2), "o", e.opacity, "y", q?.y.toFixed(0), "x", q?.x.toFixed(0), "s", q?.scale.toFixed(2), "desk", presence("desk", t, mobile).o.toFixed(2), "board", presence("board", t, mobile).o.toFixed(2));
}
