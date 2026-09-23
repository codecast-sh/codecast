#!/usr/bin/env bun
// Round 7 probe: the keyboard focus ring on every card control, bar density.
import { mkdirSync } from "node:fs";
import { killChrome, launchChrome } from "./chrome.mjs";
import { connect, sleep } from "./cdp.mjs";
import { signIn } from "./auth.mjs";
import { PAGE_LIB } from "./page.mjs";
import { BAR } from "./legs.mjs";
import { STATES_LIB } from "./states.mjs";

const DIR = "/tmp/facerig7/probe";
const PORT = 9614;
mkdirSync(DIR, { recursive: true });
const TARGETS = [
  ["live", ".walkie-strip-mute", "mute"],
  ["live", ".walkie-strip-end", "end"],
  ["incoming", ".walkie-strip-actions button", "talkback"],
  ["incoming", ".walkie-strip-join", "join"],
  ["incoming", ".walkie-strip-snooze", "snooze"],
  ["ring-in", ".ring-card-decline", "decline"],
  ["ring-in", ".ring-card-join", "answer"],
  ["ring-out", "[data-card-action=cancel]", "cancel"],
];
const child = await launchChrome({ port: PORT, profile: `${DIR}/prof`, fresh: true });
try {
  const bar = await connect(PORT, /about:blank|localhost/);
  await bar.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await signIn(bar, "riley");
  await bar.evaluate(PAGE_LIB);
  await bar.evaluate(`__rig.waitFor("!s.missing && s.entries.length > 0", 60000)`);
  await bar.evaluate(`(async () => { for (let i = 0; i < 600; i++) { const st = window.__inboxStore?.getState(); if (st?.currentUser?._id && (st.teamMembers ?? []).length > 1 && window.__faceRow) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("no roster"); })()`);
  await bar.evaluate(`document.documentElement.classList.remove("light"); document.documentElement.classList.add("dark"); "ok"`);
  await bar.evaluate(STATES_LIB);
  for (const [state, sel, tag] of TARGETS) {
    await bar.evaluate(`__rigStates.apply(${JSON.stringify(state)})`);
    await sleep(600);
    // Keyboard focus: a real Tab, so :focus-visible is honest. Start from the first face.
    await bar.evaluate(`document.querySelector('.people-bar .face').focus(); "ok"`);
    let hit = false;
    for (let i = 0; i < 40; i++) {
      await bar.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await bar.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      const on = await bar.evaluate(`(() => { const t = document.querySelector('.people-bar ${sel.replace(/'/g, "\\'")}'); return !!t && document.activeElement === t; })()`);
      if (on) { hit = true; break; }
    }
    const info = await bar.evaluate(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return JSON.stringify({ cls: a.className, fv: a.matches(':focus-visible'), outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ' off ' + cs.outlineOffset, shadow: cs.boxShadow.slice(0, 80) }); })()`);
    await sleep(150);
    const shot = await bar.screenshot(`${DIR}/focus-${state}-${tag}.png`, BAR);
    console.log(`${state}/${tag} hit=${hit} ${info}\n    ${shot}`);
  }
  // The member card's buttons.
  await bar.evaluate(`__rigStates.apply("idle")`);
  await sleep(300);
  await bar.evaluate(`(() => { const seats = document.querySelectorAll('.people-bar [data-face-id]'); const el = seats[seats.length - 1]; const r = el.getBoundingClientRect(); window.__at = { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const at = await bar.evaluate(`JSON.stringify(window.__at)`);
  const { x, y } = JSON.parse(at);
  await bar.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await sleep(500);
  for (const [sel, tag] of [[".face-card-who", "who"], [".face-card-actions button", "talk"], [".face-card-actions button:nth-of-type(2)", "huddle"], [".face-card-actions button:last-of-type", "message"]]) {
    await bar.evaluate(`document.querySelector('.people-bar .face-card ${sel}').focus(); "ok"`);
    const info = await bar.evaluate(`(() => { const a = document.activeElement; const cs = getComputedStyle(a); return JSON.stringify({ cls: a.className, fv: a.matches(':focus-visible'), outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor + ' off ' + cs.outlineOffset }); })()`);
    await sleep(150);
    const shot = await bar.screenshot(`${DIR}/focus-card-${tag}.png`, BAR);
    console.log(`card/${tag} ${info}\n    ${shot}`);
  }
  await bar.evaluate(`__rigStates.clear()`);
} finally {
  killChrome(child);
}
