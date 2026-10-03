#!/usr/bin/env bun
// The two identity smoke suite: the real app, in two signed in headless
// Chromes, against a local dev deployment with seeded test identities.
//
//   bun scripts/rig/smoke.mjs [--legs inbox,conversation,chat,org] [--accept] [--keep]
//                             [--refresh] [--threshold 0.1] [--max-ratio 0.002]
//   bun scripts/rig/smoke.mjs accept [<run dir>] [--legs ...]
//
// A run brings the stack up (stack.mjs: the local deployment and a vite on
// 3297 pointed at it), seeds the world (seed.mjs), signs Riley and Jordan in,
// and runs each leg. A leg asserts what the page shows (the seeded session in
// the inbox, its messages in the conversation, a line Jordan types arriving
// on Riley's screen, people on the org chart), then photographs it and
// compares the shot with its baseline. It prints PASS or FAIL per leg, and on
// a visual failure the path of a diff image (diff in red, masked areas blue).
//
// Baselines live outside git, in ~/.cache/codecast/smoke/baselines (or
// RIG_BASELINES). A leg with no baseline passes on its checks and says so;
// `--accept` stores this run's shots as the baselines, and `accept` stores a
// finished run's (the latest by default). Runs land in /tmp/codecast-smoke.
//
// Nothing here can reach prod: the deployment must be the local anonymous
// one (stack.mjs refuses anything else), and both browsers resolve no
// *.codecast.sh host at all.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { killChrome, launchSignedIn } from "./chrome.mjs";
import { sleep } from "./cdp.mjs";
import { diffPng } from "./imagediff.mjs";
import { SMOKE_CHANNEL, SMOKE_PEOPLE, SMOKE_SESSION, SMOKE_TEAM, seedRun, seedWorld } from "./seed.mjs";
import { stackUp } from "./stack.mjs";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const ALL_LEGS = ["inbox", "conversation", "chat", "org"];
const LEG_NAMES = opt("legs", ALL_LEGS.join(",")).split(",");
const BASELINES = process.env.RIG_BASELINES || join(homedir(), ".cache/codecast/smoke/baselines");
const RUNS = "/tmp/codecast-smoke";
const VIEWPORT = { width: 1280, height: 800 };
const THRESHOLD = Number(opt("threshold", "0.1"));
const MAX_RATIO = Number(opt("max-ratio", "0.002"));
const CHAT_LINE = "Smoke check: the login redirect fix is in, take a look when you can.";

// ── accept ──

/** Copy a run's shots (and their masks) into the baselines. */
function accept(runDir, legs) {
  const results = JSON.parse(readFileSync(join(runDir, "results.json"), "utf8"));
  mkdirSync(BASELINES, { recursive: true });
  const taken = [];
  for (const r of results) {
    if (!legs.includes(r.name)) continue;
    if (!r.checksOk) {
      console.log(`  ${r.name}: not accepted, its checks failed`);
      continue;
    }
    for (const s of r.shots) {
      copyFileSync(s.file, join(BASELINES, `${s.key}.png`));
      writeFileSync(join(BASELINES, `${s.key}.json`), JSON.stringify({ masks: s.masks, from: runDir }, null, 2));
      taken.push(s.key);
    }
  }
  console.log(`accepted ${taken.length} baselines into ${BASELINES}: ${taken.join(", ")}`);
}

if (args[0] === "accept") {
  const runDir = args[1] && !args[1].startsWith("--") ? args[1] : join(RUNS, "latest");
  accept(runDir, LEG_NAMES);
  process.exit(0);
}

// ── in the page ──

// Animations, transitions and the caret off, so a shot is the settled frame.
const STILL_CSS = "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important;scroll-behavior:auto!important}";
const INIT = `document.addEventListener("DOMContentLoaded", () => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(STILL_CSS)}; document.head.appendChild(s); });`;

const PAGE_LIB = String.raw`
(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0;
  };
  // The innermost visible elements whose text holds the string.
  const withText = (text, scope) => {
    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return [];
    const xp = document.evaluate('.//*[contains(normalize-space(.), "' + text + '")]', root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const all = [];
    for (let i = 0; i < xp.snapshotLength; i++) all.push(xp.snapshotItem(i));
    return all.filter((e) => !all.some((o) => o !== e && e.contains(o))).filter(visible);
  };
  const poll = (fn, timeoutMs, what) => new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return res({ ms: Date.now() - t0, value: v });
      if (Date.now() - t0 > timeoutMs) return rej(new Error("timed out after " + timeoutMs + " ms waiting for " + what));
      setTimeout(tick, 250);
    };
    tick();
  });
  // Relative times and clocks: the parts of an honest page that move between
  // two runs. Leaf elements only, so a sentence that mentions a time is kept.
  const MOVING = /^(just now|now|today|yesterday|\d+\s?(s|sec|secs|m|min|mins|h|hr|hrs|d|w|wk|mo|y|yr)( ago)?|\d+ (second|minute|hour|day|week|month|year)s? ago|\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?)$/i;
  window.__smoke = {
    text: (text, scope, timeoutMs = 120000) => poll(() => withText(text, scope).length, timeoutMs, JSON.stringify(text) + (scope ? " in " + scope : "")),
    sel: (sel, timeoutMs = 120000) => poll(() => [...document.querySelectorAll(sel)].some(visible), timeoutMs, sel),
    eval: (src, timeoutMs = 120000) => poll(new Function("return (" + src + ")"), timeoutMs, src),
    // Wait for the DOM to hold still, then for the fonts and two frames.
    quiet: (ms = 800, cap = 10000) => new Promise((res) => {
      let last = Date.now();
      const t0 = last;
      const mo = new MutationObserver(() => { last = Date.now(); });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      const tick = async () => {
        if (Date.now() - last >= ms || Date.now() - t0 > cap) {
          mo.disconnect();
          await document.fonts.ready;
          requestAnimationFrame(() => requestAnimationFrame(() => res(Date.now() - t0)));
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    }),
    masks: (selectors = []) => {
      const rects = [];
      const add = (el) => {
        if (!visible(el)) return;
        const r = el.getBoundingClientRect();
        rects.push({ x: Math.max(0, r.left - 2), y: Math.max(0, r.top - 2), width: r.width + 4, height: r.height + 4 });
      };
      for (const el of document.body.querySelectorAll("*")) {
        if (el.childElementCount) continue;
        const t = (el.textContent || "").trim();
        if (t && t.length < 24 && MOVING.test(t)) add(el);
      }
      for (const sel of ["time", ...selectors]) for (const el of document.querySelectorAll(sel)) add(el);
      return rects;
    },
    errors: [],
  };
  return "installed";
})()
`;

// ── a side: one person in one browser ──

async function openSide(who, userId, dep, dir, path) {
  const p = SMOKE_PEOPLE[who];
  const errors = [];
  const { child, page } = await launchSignedIn({
    port: p.port,
    profile: `${RUNS}/prof-${who}`,
    dep,
    userId,
    path,
    // No host under codecast.sh resolves: prod is out of reach whatever the
    // app is configured with.
    extra: ["--host-resolver-rules=MAP *codecast.sh ~NOTFOUND"],
    prepare: async (pg) => {
      await pg.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
      await pg.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
      await pg.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
      await pg.send("Emulation.setLocaleOverride", { locale: "en-US" });
      await pg.addInitScript(INIT);
      await pg.send("Runtime.enable");
      pg.on((m) => {
        if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0].slice(0, 200));
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(String(m.params.args?.[0]?.value ?? m.params.args?.[0]?.description ?? "").split("\n")[0].slice(0, 200));
      });
    },
  });
  const side = { who, userId, name: p.name, email: p.email, child, page, errors, dir };
  // Signed in as the test identity, on the local deployment: the app holds
  // this person only if its token was minted there.
  await lib(side);
  const r = await side.page.evaluate(`__smoke.eval(${JSON.stringify(`window.__inboxStore?.getState().currentUser?.email`)}, 300000)`);
  if (r.value !== p.email) throw new Error(`${who} is signed in as ${r.value}, not ${p.email}`);
  return side;
}

const lib = (side) => side.page.evaluate(PAGE_LIB);

async function go(side, dep, path) {
  await side.page.navigate(`${dep.appUrl}${path}`);
  await lib(side);
}

// ── a leg ──

class Leg {
  constructor(name, dir) {
    this.name = name;
    this.dir = dir;
    this.checks = [];
    this.shots = [];
    this.problems = [];
  }
  async check(what, side, expr) {
    try {
      const r = await side.page.evaluate(expr);
      this.checks.push({ what: `${what} [${side.who}]`, ok: true, ms: r.ms });
      console.log(`  ok    ${String(r.ms).padStart(6)} ms  ${what} [${side.who}]`);
      return r;
    } catch (e) {
      this.checks.push({ what: `${what} [${side.who}]`, ok: false, detail: e.message });
      this.problems.push(`${what} [${side.who}]: ${e.message}`);
      console.log(`  FAIL           ${what} [${side.who}]: ${e.message}`);
      throw e;
    }
  }
  /** Settle, photograph the viewport, compare with the baseline. */
  async shot(side, maskSelectors = []) {
    await side.page.evaluate(`__smoke.quiet()`);
    const masks = await side.page.evaluate(`__smoke.masks(${JSON.stringify(maskSelectors)})`);
    const key = `${this.name}-${side.who}`;
    const file = await side.page.screenshot(join(this.dir, `${key}.png`));
    const shot = { key, who: side.who, file, masks };
    const base = join(BASELINES, `${key}.png`);
    if (existsSync(base)) {
      const baseMasks = existsSync(join(BASELINES, `${key}.json`)) ? JSON.parse(readFileSync(join(BASELINES, `${key}.json`), "utf8")).masks : [];
      shot.diff = diffPng(base, file, { masks: [...baseMasks, ...masks], threshold: THRESHOLD, maxRatio: MAX_RATIO, diffPath: join(this.dir, `${key}.diff.png`) });
      if (!shot.diff.ok) {
        shot.diffFile = join(this.dir, `${key}.diff.png`);
        this.problems.push(`${key} differs from its baseline: ${shot.diff.sizeChanged ? `size ${shot.diff.baseline} -> ${shot.diff.current}` : `${(shot.diff.ratio * 100).toFixed(3)}% of pixels`} (diff ${shot.diffFile})`);
      }
    }
    this.shots.push(shot);
    return shot;
  }
  result() {
    const checksOk = this.checks.length > 0 && this.checks.every((c) => c.ok);
    return { name: this.name, ok: checksOk && this.problems.length === 0, checksOk, checks: this.checks, shots: this.shots, problems: this.problems };
  }
}

const quoteFree = (s) => {
  if (s.includes('"')) throw new Error(`fixture text may not hold a double quote: ${s}`);
  return s;
};
const text = (t, scope, timeoutMs) => `__smoke.text(${JSON.stringify(quoteFree(t))}, ${JSON.stringify(scope ?? null)}${timeoutMs ? `, ${timeoutMs}` : ""})`;

const LEGS = {
  /** Riley's inbox lists this run's session under its title. */
  async inbox(leg, { R, dep }) {
    await go(R, dep, "/inbox");
    await leg.check("the seeded session is listed", R, text(SMOKE_SESSION.title));
    await leg.check("the team is the workspace", R, text(SMOKE_TEAM));
    await leg.shot(R);
  },
  /** The session's page shows both of its messages. */
  async conversation(leg, { R, dep, fixtures }) {
    await go(R, dep, `/conversation/${fixtures.conversationId}`);
    await leg.check("the user message renders", R, text(SMOKE_SESSION.user.slice(0, 60)));
    await leg.check("the assistant message renders", R, text(SMOKE_SESSION.assistant.slice(0, 60)));
    await leg.shot(R);
  },
  /** Jordan types a line in the channel's composer and sends it; Riley's
   *  open channel shows it under Jordan's name. */
  async chat(leg, { R, J, dep, fixtures }) {
    for (const s of [R, J]) await go(s, dep, `/chat/${fixtures.channelId}`);
    for (const s of [R, J]) {
      await leg.check("the channel is open", s, text(SMOKE_CHANNEL.name));
      await leg.check("the composer is ready", s, `__smoke.sel(".ch-composer textarea")`);
    }
    await J.page.evaluate(`document.querySelector(".ch-composer textarea").focus(); "ok"`);
    await J.page.send("Input.insertText", { text: CHAT_LINE });
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await J.page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
    await J.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    const sent = Date.now();
    await leg.check("the line is in the sender's channel", J, text(CHAT_LINE, "[data-message-id]", 30000));
    await leg.check("the line reaches the other person", R, text(CHAT_LINE, "[data-message-id]", 60000));
    const author = `[...document.querySelectorAll("[data-message-id]")].some((m) => m.textContent.includes(${JSON.stringify(CHAT_LINE)}) && m.textContent.includes(${JSON.stringify(SMOKE_PEOPLE.jordan.name)}))`;
    await leg.check("it is signed with the sender's name", R, `__smoke.eval(${JSON.stringify(author)}, 10000)`);
    console.log(`        ${Date.now() - sent} ms from Enter on Jordan's side to the checks on Riley's`);
    await J.page.evaluate(`document.activeElement?.blur(); "ok"`);
    for (const s of [R, J]) await leg.shot(s, [".ch-msg-time", ".ch-msg-hovertime"]);
  },
  /** The org chart draws, with Riley on it. */
  async org(leg, { R, dep }) {
    await go(R, dep, "/org");
    await leg.check("the chart header renders", R, `__smoke.sel('[data-org-header="chart"]')`);
    await leg.check("Riley is on the chart", R, text(SMOKE_PEOPLE.riley.name));
    await leg.shot(R);
  },
};

// ── the run ──

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(RUNS, stamp);
mkdirSync(dir, { recursive: true });
console.log(`run ${dir}`);
const t0 = Date.now();
const dep = await stackUp({ refresh: args.includes("--refresh") });
console.log(`stack: ${dep.convexUrl} (${dep.kind}), app ${dep.appUrl} [${Date.now() - t0} ms]`);
const world = await seedWorld(dep);
const fixtures = await seedRun(dep, world);
console.log(`seeded: riley ${world.riley}, jordan ${world.jordan}, team ${world.teamId}, session ${fixtures.conversationId}, channel ${fixtures.channelId} [${Date.now() - t0} ms]`);

const sides = [];
const results = [];
try {
  const [R, J] = await Promise.all([openSide("riley", world.riley, dep, dir, "/inbox"), openSide("jordan", world.jordan, dep, dir, "/inbox")]);
  sides.push(R, J);
  console.log(`both signed in on the local deployment [${Date.now() - t0} ms]`);
  for (const name of LEG_NAMES) {
    const fn = LEGS[name];
    if (!fn) throw new Error(`unknown leg ${name} (legs: ${ALL_LEGS.join(", ")})`);
    console.log(`\n== ${name} ==`);
    const leg = new Leg(name, dir);
    const errorsBefore = sides.map((s) => s.errors.length);
    try {
      await fn(leg, { R, J, dep, world, fixtures });
    } catch (e) {
      if (!leg.problems.length) leg.problems.push(e.message);
      for (const s of sides) await s.page.screenshot(join(dir, `${name}-${s.who}-failed.png`)).catch(() => {});
    }
    const r = leg.result();
    r.pageErrors = Object.fromEntries(sides.map((s, i) => [s.who, [...new Set(s.errors.slice(errorsBefore[i]))].slice(0, 8)]));
    results.push(r);
  }
} finally {
  if (!args.includes("--keep")) for (const s of sides) killChrome(s.child);
}

writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 2));
rmSync(join(RUNS, "latest"), { force: true });
symlinkSync(dir, join(RUNS, "latest"));

console.log("\n| leg | verdict | shots |");
console.log("| --- | --- | --- |");
for (const r of results) {
  const shots = r.shots.map((s) => `${s.key}: ${!s.diff ? "no baseline" : s.diff.ok ? `matches (${(s.diff.ratio * 100).toFixed(3)}%)` : `DIFFERS ${s.diffFile}`}`).join("; ");
  console.log(`| ${r.name} | ${r.ok ? "PASS" : "FAIL: " + r.problems.join("; ")} | ${shots || "none"} |`);
}
for (const r of results) {
  for (const [who, errs] of Object.entries(r.pageErrors)) if (errs.length) console.log(`  ${r.name} page errors [${who}]: ${errs.join(" | ")}`);
}
console.log(`\nshots and results: ${dir} (also ${RUNS}/latest); baselines: ${BASELINES}`);
if (args.includes("--accept")) accept(dir, LEG_NAMES);
else if (results.some((r) => r.shots.some((s) => !s.diff))) console.log("no baseline for some shots: review them, then `bun scripts/rig/smoke.mjs accept`");
process.exit(results.length === LEG_NAMES.length && results.every((r) => r.ok) ? 0 : 1);
