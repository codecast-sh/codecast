#!/usr/bin/env bun
// Evaluate JS on a rig browser that a `run.mjs --keep` left running:
//   bun scripts/rig/eval.mjs riley '__rig.snap()'
//   bun scripts/rig/eval.mjs jordan --shot /tmp/facerig/bar.png [selector]
import { connect } from "./cdp.mjs";
import { IDENTITIES } from "./auth.mjs";
import { PAGE_LIB } from "./page.mjs";

const [who, ...rest] = process.argv.slice(2);
const id = IDENTITIES[who];
if (!id) throw new Error("who: riley | jordan");
const page = await connect(id.port);
await page.evaluate(PAGE_LIB);
if (rest[0] === "--shot") {
  console.log(await page.screenshot(rest[1], rest[2]));
} else {
  const v = await page.evaluate(rest.join(" "));
  console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
}
page.close();
