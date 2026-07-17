// Build all (or one) demo composition(s) from scene specs + VO timing.
import { renderComposition } from "./studio.mjs";
import { writeFileSync } from "fs";

const DIR = new URL(".", import.meta.url).pathname;
const voDir = DIR + "vo";
const only = process.argv[2];
const ids = only ? [only] : ["demo1", "demo2", "demo3", "demo4", "demo5"];

for (const id of ids) {
  const scene = (await import(`./scenes/${id}.mjs`)).default;
  const html = renderComposition(scene, voDir);
  const out = `${DIR}compositions/${id}.html`;
  writeFileSync(out, html);
  const dur = html.match(/data-duration="([\d.]+)" data-width/)?.[1];
  console.log(`${id} → compositions/${id}.html  (${dur}s)`);
}
