import { frame, FACE_UP } from "./timeline";
import { SURFACES } from "./world";
console.log("FACE_UP", JSON.stringify(FACE_UP));
for (const t of process.argv.slice(2).map(Number)) {
  const f: any = frame(t);
  const els = f.els ?? f.elements ?? f;
  const row = SURFACES.map((s) => { const c = els[`card:${s.id}`]?.transform ?? ""; const m = /rotateX\(([-\d.]+)deg/.exec(c); const fo = els[`face:${s.id}`]?.opacity; const so = els[`shadow:${s.id}`]?.opacity; return `${s.id}:rx${m?.[1] ?? "?"}${fo !== undefined ? ` fo${fo}` : ""} sh${so}`; });
  console.log(t, row.join(" | "));
}
