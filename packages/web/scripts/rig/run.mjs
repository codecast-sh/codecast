#!/usr/bin/env bun
// The two identity headless rig for the face row (pl-756 F6).
//
//   bun scripts/rig/run.mjs [--legs walkie,ring,reconnect,dead-seat] [--dir /tmp/facerig] [--keep] [--attach]
//
// --keep leaves both browsers up; --attach reuses them (scripts/rig/eval.mjs
// evaluates on either while they are up).
//
// Two Google Chromes, --headless=new and --mute-audio, one profile each,
// signed in as the App Review demo accounts (Riley Chen, Jordan Lee) against
// the dev server on localhost:3200 and the real self hosted convex and
// LiveKit. Every leg drives the header row's own buttons on one side, waits
// for the other side's row to show it, and records every state a face read
// in between. Nothing opens a window and nothing makes a sound.
//
// Needs: the dev server up, `CONVEX_SELF_HOSTED_ADMIN_KEY` in the
// environment (auth:store mints the sessions), Google Chrome in
// /Applications (or RIG_CHROME).
import { mkdirSync, writeFileSync } from "node:fs";
import { bringUp, deadSeatLeg, reconnectLeg, ringLeg, settle, waitPresent, walkieLeg } from "./legs.mjs";
import { killChrome } from "./chrome.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DIR = opt("dir", "/tmp/facerig");
const LEGS = opt("legs", "walkie,ring,reconnect,dead-seat").split(",");
const KEEP = args.includes("--keep");
const ATTACH = args.includes("--attach");
mkdirSync(DIR, { recursive: true });

const LEG = { walkie: walkieLeg, ring: ringLeg, reconnect: reconnectLeg, "dead-seat": deadSeatLeg };

const sides = [];
const results = [];
const t0 = Date.now();
try {
  const A = await bringUp("riley", { dir: DIR, attach: ATTACH });
  console.log(`riley signed in and on the inbox in ${Date.now() - t0} ms`);
  const B = await bringUp("jordan", { dir: DIR, attach: ATTACH });
  sides.push(A, B);
  console.log(`both signed in and on the inbox in ${Date.now() - t0} ms`);
  await settle(sides);
  await Promise.all([waitPresent(A), waitPresent(B)]);
  console.log(`both rows show the other online in ${Date.now() - t0} ms`);

  for (const name of LEGS) {
    const fn = LEG[name];
    if (!fn) throw new Error(`unknown leg ${name}`);
    let r;
    try {
      r = await fn(A, B, { dir: DIR });
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
      for (const s of sides) {
        if (s.child.exitCode !== null) continue;
        try {
          await s.page.screenshot(`${DIR}/${name}-failed-${s.who}.png`);
          const rec = await s.page.evaluate(`__rig.stop ? __rig.stop() : null`);
          if (rec) console.log(`  ${s.who} log: ${JSON.stringify(rec.log).slice(0, 1500)}`);
        } catch {
          // the page may be gone
        }
      }
      r = { name, ok: false, problems: [e.message], timings: [], shots: [] };
    }
    results.push(r);
    // A killed browser comes back for the next leg.
    if (B.child.exitCode !== null && LEGS.indexOf(name) < LEGS.length - 1) {
      const fresh = await bringUp("jordan", { dir: DIR, fresh: false });
      Object.assign(B, fresh);
    }
    await settle(sides);
    await Promise.all(sides.filter((s) => s.child.exitCode === null).map((s) => waitPresent(s)));
  }
} finally {
  if (!KEEP) for (const s of sides) killChrome(s.child, s.profile);
}

// ── the table ──
console.log("\n| leg | moment | ms |");
console.log("| --- | --- | ---: |");
for (const r of results) for (const t of r.timings) console.log(`| ${r.name} | ${t.name} | ${t.ms} |`);
console.log("\n| leg | verdict |");
console.log("| --- | --- |");
for (const r of results) console.log(`| ${r.name} | ${r.ok ? "PASS" : "FAIL: " + r.problems.join("; ")} |`);
writeFileSync(`${DIR}/results.json`, JSON.stringify(results, null, 2));
console.log(`\nresults: ${DIR}/results.json; shots: ${results.flatMap((r) => r.shots.map((s) => s.file)).length}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
