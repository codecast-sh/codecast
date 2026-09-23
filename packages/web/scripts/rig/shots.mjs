#!/usr/bin/env bun
// Every state of the row, both densities, from one signed in headless Chrome:
//
//   bun scripts/rig/shots.mjs [--dir /tmp/facerig] [--who riley] [--keep]
//                             [--theme light|dark] [--motion reduce] [--cards]
//                             [--focus]
//
// One page on /inbox is the header bar; a second page on /call-panel, booted
// under the fake desktop bridge (states.mjs), is the float. Each state is
// put on both through the engine fake and both are photographed. --theme
// swaps the root class the theme provider writes, --motion emulates the
// reduced motion preference, and --cards photographs each state a second
// time with the pointer on the teammate's face, so the member card is in
// the frame (state-<name>-<density>-card.png). --focus is the keyboard pass:
// a real Tab from the first face through the band under the bar, the focus
// outline of every control it lands on in the log, and the first one in the
// frame (state-<name>-bar-focus.png). Nothing opens a window and nothing
// makes a sound.
import { mkdirSync } from "node:fs";
import { killChrome, launchChrome } from "./chrome.mjs";
import { connect, connectTarget, newTarget, sleep } from "./cdp.mjs";
import { APP_URL, signIn } from "./auth.mjs";
import { PAGE_LIB } from "./page.mjs";
import { BAR } from "./legs.mjs";
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
const THEME = opt("theme", "");
const MOTION = opt("motion", "");
const CARDS = args.includes("--cards");
const FOCUS = args.includes("--focus");
mkdirSync(DIR, { recursive: true });

/** The pointer onto the teammate's face (the second seat), so the row opens
 *  its card the way a person's hover does: a real mouse move over CDP, then
 *  the dwell (CARD_OPEN_MS) and the card's entrance. */
const hoverFace = async (page, density, index) => {
  const at = await page.evaluate(
    `(() => { const seats = document.querySelectorAll('.face-row[data-density="${density}"] [data-face-id]'); const el = seats[Math.min(${index}, seats.length - 1)]; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!at) return false;
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  await sleep(450);
  return true;
};
const unhover = async (page) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 400 });
  await sleep(400);
};
/** Tab from the first face through the band's controls: each one's focus
 *  outline as the browser computed it, and a shot of the first. A control
 *  the stylesheet forgot wears the browser's own ring here. */
const focusPass = async (page, file) => {
  await page.evaluate(`document.querySelector('.people-bar .face')?.focus(); "ok"`);
  const seen = [];
  let shot = null;
  for (let i = 0; i < 24; i++) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const on = await page.evaluate(
      `(() => { const a = document.activeElement; if (!a || !a.closest('.people-bar .face-row-below')) return null; const cs = getComputedStyle(a); return (a.dataset.cardAction || a.className.trim().split(/\\s+/)[0]) + ' ' + cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor; })()`,
    );
    if (!on) {
      if (seen.length) break;
      continue;
    }
    seen.push(on);
    if (!shot) {
      await sleep(120);
      shot = await page.screenshot(file, BAR);
    }
  }
  return seen.length ? [`focus: ${seen.join(" | ")}`, shot] : [];
};
const applyMedia = async (page) => {
  if (MOTION) await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: MOTION }] });
};
const applyTheme = async (page) => {
  if (THEME) await page.evaluate(`document.documentElement.classList.remove("dark", "light"); document.documentElement.classList.add(${JSON.stringify(THEME)}); "ok"`);
};

const FLOAT = '.face-row[data-density="float"], .face-row[data-density="float"] .face-row-below';
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
  await applyMedia(bar);
  watch(bar, "bar");
  await signIn(bar, WHO);
  await bar.evaluate(PAGE_LIB);
  await bar.evaluate(`__rig.waitFor("!s.missing && s.entries.length > 0", 240000)`);
  const t = await newTarget(PORT);
  const float = await connectTarget(t);
  await float.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await applyMedia(float);
  watch(float, "float");
  await float.addInitScript(FAKE_BRIDGE);
  await float.navigate(`${APP_URL}/call-panel`);
  // The recipes read the roster and fake the engine: both pages have to
  // hold the roster and have the row module up first.
  const roster = `(async () => { for (let i = 0; i < 600; i++) { const st = window.__inboxStore?.getState(); if (st?.currentUser?._id && (st.teamMembers ?? []).length > 1 && window.__faceRow) return st.teamMembers.length; await new Promise((r) => setTimeout(r, 100)); } throw new Error("no roster"); })()`;
  await bar.evaluate(roster);
  await float.evaluate(roster);
  await applyTheme(bar);
  await applyTheme(float);
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
      row.push(await bar.screenshot(`${DIR}/state-${name}-bar.png`, BAR));
    } catch (e) {
      row.push(`(bar: ${e.message})`);
    }
    try {
      row.push(await float.screenshot(`${DIR}/state-${name}-float.png`, FLOAT));
    } catch (e) {
      row.push(`(float: ${e.message})`);
    }
    if (FOCUS) {
      try {
        row.push(...(await focusPass(bar, `${DIR}/state-${name}-bar-focus.png`)));
      } catch (e) {
        row.push(`(focus: ${e.message})`);
      }
    }
    if (CARDS) {
      for (const [page, density, sel] of [[bar, "bar", BAR], [float, "float", FLOAT]]) {
        try {
          if (await hoverFace(page, density, 1)) row.push(await page.screenshot(`${DIR}/state-${name}-${density}-card.png`, sel));
          await unhover(page);
        } catch (e) {
          row.push(`(${density} card: ${e.message})`);
        }
      }
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
