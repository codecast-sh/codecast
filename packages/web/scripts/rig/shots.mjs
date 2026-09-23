#!/usr/bin/env bun
// Every state of the row, both densities, from one signed in headless Chrome:
//
//   bun scripts/rig/shots.mjs [--dir /tmp/facerig] [--who riley] [--keep]
//
// One page on /inbox is the header bar; a second page on /call-panel, booted
// under the fake desktop bridge (states.mjs), is the float. Each state is
// put on both through the engine fake and both are photographed. Nothing
// opens a window and nothing makes a sound.
import { mkdirSync } from "node:fs";
import { killChrome, launchChrome } from "./chrome.mjs";
import { connect, connectTarget, newTarget, sleep } from "./cdp.mjs";
import { APP_URL, signIn } from "./auth.mjs";
import { PAGE_LIB } from "./page.mjs";
import { FAKE_BRIDGE, STATES_LIB } from "./states.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const DIR = opt("dir", "/tmp/facerig");
const WHO = opt("who", "riley");
const PORT = Number(opt("port", "9613"));
const KEEP = args.includes("--keep");
mkdirSync(DIR, { recursive: true });

const errors = [];
const watch = (page, tag) => {
  page.send("Runtime.enable").catch(() => {});
  page.on((m) => {
    if (m.method === "Runtime.exceptionThrown") errors.push(`${tag}: ${(m.params.exceptionDetails.exception?.description || "").slice(0, 200)}`);
  });
};

const child = await launchChrome({ port: PORT, profile: `${DIR}/prof-shots`, fresh: true });
const shots = [];
try {
  const bar = await connect(PORT, /about:blank|localhost/);
  await bar.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  watch(bar, "bar");
  await signIn(bar, WHO);
  await bar.evaluate(PAGE_LIB);
  await bar.evaluate(`__rig.waitFor("!s.missing && s.entries.length > 0", 60000)`);
  const t = await newTarget(PORT);
  const float = await connectTarget(t);
  await float.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  watch(float, "float");
  await float.addInitScript(FAKE_BRIDGE);
  await float.navigate(`${APP_URL}/call-panel`);
  await sleep(1500);
  const names = await bar.evaluate(STATES_LIB);
  await float.evaluate(STATES_LIB);
  console.log(`states: ${names.join(", ")}`);
  for (const name of names) {
    await bar.evaluate(`__rigStates.apply(${JSON.stringify(name)})`);
    await float.evaluate(`__rigStates.apply(${JSON.stringify(name)})`);
    // The FLIP reorder is 240ms; a card mounts on the next frame.
    await sleep(600);
    const snap = await bar.evaluate(`JSON.stringify(__rig.snap())`);
    const row = [name, snap];
    try {
      row.push(await bar.screenshot(`${DIR}/state-${name}-bar.png`, ".people-bar"));
    } catch (e) {
      row.push(`(bar: ${e.message})`);
    }
    try {
      row.push(await float.screenshot(`${DIR}/state-${name}-float.png`, '.face-row[data-density="float"]'));
    } catch (e) {
      row.push(`(float: ${e.message})`);
    }
    shots.push(row);
    console.log(row.join("\n    "));
  }
  await bar.evaluate(`__rigStates.clear()`);
  await float.evaluate(`__rigStates.clear()`);
} finally {
  if (!KEEP) killChrome(child);
}
if (errors.length) console.log(`\npage errors:\n  ${[...new Set(errors)].join("\n  ")}`);
