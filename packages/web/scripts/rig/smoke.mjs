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
// one (stack.mjs refuses anything else), and both browsers resolve no host
// but localhost and 127.0.0.1. That also keeps the shots a function of this
// machine alone: the app asks Google Fonts for JetBrains Mono with
// display=swap, and when that fetch could land, a shot showed the web face or
// the installed one depending on which arrived first. Fonts come from the
// system's copies.
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
// The first boot of the app on a cold vite runs minutes on a loaded machine.
const BOOT_MS = Number(process.env.RIG_BOOT_MS || 900_000);
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
  const runDir = realpathSync(args[1] && !args[1].startsWith("--") ? args[1] : join(RUNS, "latest"));
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
    if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    // On top: what a person sees at its center is this element, not an
    // overlay that covers it.
    const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, (r.left + r.right) / 2)), Math.min(innerHeight - 1, Math.max(0, (r.top + r.bottom) / 2)));
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  // The innermost visible elements whose text holds the string.
  const withText = (text, scope) => {
    const all = [];
    for (const root of scope ? document.querySelectorAll(scope) : [document.body]) {
      const xp = document.evaluate('descendant-or-self::*[contains(normalize-space(.), "' + text + '")]', root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      for (let i = 0; i < xp.snapshotLength; i++) all.push(xp.snapshotItem(i));
    }
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
  // two runs. Each token is masked on its own (a Range around it), so
  // "finished · 3m ago" keeps "finished" in the comparison.
  const MOVING = /\b(just now|yesterday|\d+\s?(?:s|sec|secs|m|min|mins|h|hr|hrs|d|w|wk|mo|y|yr)\b(?: ago)?|\d+ (?:second|minute|hour|day|week|month|year)s? ago|\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)/gi;
  window.__smoke = {
    visible,
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
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.parentElement || !visible(n.parentElement)) continue;
        for (const m of n.data.matchAll(MOVING)) {
          const range = document.createRange();
          range.setStart(n, m.index);
          range.setEnd(n, m.index + m[0].length);
          const r = range.getBoundingClientRect();
          if (r.width && r.height) rects.push({ x: Math.max(0, r.left - 2), y: Math.max(0, r.top - 2), width: r.width + 4, height: r.height + 4 });
        }
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
    // Nothing resolves but the app (localhost) and the local deployment
    // (127.0.0.1, which `MAP *` would catch too): prod is out of reach
    // whatever the app is configured with, and nothing outside the machine
    // (web fonts, avatars, analytics) can land before or after a shot.
    extra: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"],
    prepare: async (pg) => {
      await pg.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
      await pg.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" }] });
      await pg.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
      await pg.send("Emulation.setLocaleOverride", { locale: "en-US" });
      await pg.addInitScript(INIT);
      // The smoke vite runs without HMR, so when it optimizes a dependency it
      // first met mid boot, its "reload" reaches no page and the page keeps
      // importing the old hash, which vite answers 504. Reload, as vite's own
      // client would.
      await pg.send("Network.enable");
      let reloadedAt = 0;
      pg.on((m) => {
        if (m.method !== "Network.responseReceived" || m.params.response.status !== 504 || !/\/deps\//.test(m.params.response.url)) return;
        if (Date.now() - reloadedAt < 15_000) return;
        reloadedAt = Date.now();
        console.log(`        (${who}: vite re-optimized its deps; reloading the page)`);
        pg.send("Page.reload", {}).catch(() => {});
      });
      await pg.send("Runtime.enable");
      pg.on((m) => {
        if (m.method === "Runtime.exceptionThrown") errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || "").split("\n")[0].slice(0, 200));
        if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push(String(m.params.args?.[0]?.value ?? m.params.args?.[0]?.description ?? "").split("\n")[0].slice(0, 200));
      });
    },
  });
  const side = { who, userId, name: p.name, email: p.email, child, page, errors, dir };
  try {
    // Signed in as the test identity, on the local deployment: the app holds
    // this person only if its token was minted there.
    const r = await waitIn(side, holds("window.__inboxStore?.getState().currentUser?.email"), BOOT_MS);
    if (r.value !== p.email) throw new Error(`${who} is signed in as ${r.value}, not ${p.email}`);
    // And the outside is out of reach from this browser: a no-cors fetch
    // resolves (opaque) from any host it can reach, and fails only when it
    // cannot. The same fetch to the local deployment is the control: it must
    // reach. Prod, and the font host whose race made shots flip between two
    // builds of the same face.
    const probe = (url) => page.evaluate(`fetch(${JSON.stringify(url)}, { mode: "no-cors" }).then(() => "reached", () => "unreachable")`);
    if ((await probe(`${dep.convexUrl}/version`)) !== "reached") throw new Error(`${who}'s browser cannot reach the local deployment, so the outside probes would prove nothing`);
    for (const url of ["https://convex.codecast.sh/version", "https://fonts.googleapis.com/css2?family=JetBrains+Mono", "https://fonts.gstatic.com/"]) {
      if ((await probe(url)) !== "unreachable") throw new Error(`${who}'s browser reached ${new URL(url).host}; the resolver block is not in force`);
    }
    return side;
  } catch (e) {
    await page.screenshot(join(dir, `boot-${who}-failed.png`)).catch(() => {});
    killChrome(child);
    throw new Error(`${who} never signed in: ${e.message}${errors.length ? ` (page errors: ${[...new Set(errors)].slice(0, 4).join(" | ")})` : ""}`);
  }
}

const lib = (side) => side.page.evaluate(PAGE_LIB);

/** Run an in page wait (`%MS%` is its timeout) until it answers. A reload
 *  under it (a 504 reload, a navigation) destroys the context it ran in: the
 *  helpers go back in and the wait resumes with the time left. A wait that
 *  timed out in the page is a real failure and is thrown as it is. */
async function waitIn(side, expr, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = Math.max(1000, deadline - Date.now());
    try {
      await lib(side);
      return await side.page.evaluate(expr.replace("%MS%", String(left)));
    } catch (e) {
      if (/timed out after/.test(e.message) || Date.now() >= deadline) throw e;
      await sleep(1000);
    }
  }
}

/** Move to a page inside the running app, as a click on a link does: the
 *  app's own routerNavigate (lib/tabRoutes.ts), served by the smoke vite.
 *  A full navigation would boot the whole app again for every leg, minutes
 *  each on a loaded machine, and the boot is not what a leg checks. */
async function go(side, path) {
  await lib(side);
  const moved = await side.page.evaluate(`import("/lib/tabRoutes.ts").then((m) => m.routerNavigate(${JSON.stringify(path)}))`);
  if (moved !== true) throw new Error(`routerNavigate(${path}) did not move ${side.who}'s page`);
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
  async check(what, side, expr, timeoutMs = 120_000) {
    try {
      const r = await waitIn(side, expr, timeoutMs);
      this.checks.push({ what: `${what} [${side.who}]`, ok: true, ms: r.ms });
      console.log(`  ok    ${String(r.ms).padStart(6)} ms  ${what} [${side.who}]`);
      return r;
    } catch (e) {
      const why = e.message.split("\n")[0].replace(/^eval: Error: /, "");
      this.checks.push({ what: `${what} [${side.who}]`, ok: false, detail: why });
      this.problems.push(`${what} [${side.who}]: ${why}`);
      console.log(`  FAIL           ${what} [${side.who}]: ${why}`);
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
const text = (t, scope) => `__smoke.text(${JSON.stringify(quoteFree(t))}, ${JSON.stringify(scope ?? null)}, %MS%)`;
const sel = (q) => `__smoke.sel(${JSON.stringify(q)}, %MS%)`;
const holds = (src) => `__smoke.eval(${JSON.stringify(src)}, %MS%)`;

/** The session's liveness overlay is in Riley's store. The board and the
 *  rail file a session by its is_idle and bucket, which arrive in that
 *  overlay after the row itself; a shot before it shows a finished session
 *  as one that went quiet. */
const livenessLanded = (leg, R, fixtures) =>
  leg.check("the session's liveness has arrived", R, holds(`window.__inboxStore.getState().sessions[${JSON.stringify(fixtures.conversationId)}]?.is_idle != null`));

const LEGS = {
  /** Riley's inbox lists this run's session under its title. */
  async inbox(leg, { R, dep, fixtures }) {
    await go(R, "/inbox");
    // The board itself ([data-main-scroll]), not the rail beside it, which
    // lists the same session.
    await leg.check("the board lists the seeded session", R, text(SMOKE_SESSION.title, "[data-main-scroll]"));
    await leg.check("the team is the workspace", R, text(SMOKE_TEAM));
    // The seeded session has no agent behind it, so once its idle grace
    // passes it is finished. The board reads the overlay's shipped is_idle
    // rather than re-deriving it, so it shows "went quiet" under Needs you
    // until the server's time flip lands (ct-56701); a person waits for
    // that too, and the shot is of the settled board.
    await leg.check("the board files the session under Finished", R, text("0 RUNNING · 0 NEED YOU · 1 FINISHED", "[data-main-scroll]"), 240_000);
    await leg.shot(R);
  },
  /** The session's page shows both of its messages. */
  async conversation(leg, { R, dep, fixtures }) {
    await go(R, `/conversation/${fixtures.conversationId}`);
    // In the transcript's own rows: the rail beside it quotes the user message too.
    await leg.check("the user message renders", R, text(SMOKE_SESSION.user.slice(0, 60), '[data-cc-message="user"]'));
    await leg.check("the assistant message renders", R, text(SMOKE_SESSION.assistant.slice(0, 60), '[data-cc-message="assistant"]'));
    await livenessLanded(leg, R, fixtures);
    await leg.shot(R);
  },
  /** Jordan types a line in the channel's composer and sends it; Riley's
   *  open channel shows it under Jordan's name. */
  async chat(leg, { R, J, dep, fixtures }) {
    for (const s of [R, J]) await go(s, `/chat/${fixtures.channelId}`);
    for (const s of [R, J]) {
      await leg.check("the channel is open", s, text(SMOKE_CHANNEL.name));
      await leg.check("the composer is ready", s, sel(".ch-composer textarea"));
    }
    await J.page.evaluate(`document.querySelector(".ch-composer textarea").focus(); "ok"`);
    await J.page.send("Input.insertText", { text: CHAT_LINE });
    const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await J.page.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
    await J.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
    const sent = Date.now();
    await leg.check("the line is in the sender's channel", J, text(CHAT_LINE, "[data-message-id]"), 30_000);
    await leg.check("the line reaches the other person", R, text(CHAT_LINE, "[data-message-id]"), 60_000);
    const author = `[...document.querySelectorAll("[data-message-id]")].some((m) => m.textContent.includes(${JSON.stringify(CHAT_LINE)}) && m.textContent.includes(${JSON.stringify(SMOKE_PEOPLE.jordan.name)}))`;
    await leg.check("it is signed with the sender's name", R, holds(author), 10_000);
    console.log(`        ${Date.now() - sent} ms from Enter on Jordan's side to the checks on Riley's`);
    await J.page.evaluate(`document.activeElement?.blur(); "ok"`);
    await livenessLanded(leg, R, fixtures);
    for (const s of [R, J]) await leg.shot(s, [".ch-msg-time", ".ch-msg-hovertime"]);
  },
  /** The org chart draws, with Riley on it. */
  async org(leg, { R, dep, fixtures }) {
    await go(R, "/org");
    await leg.check("the chart header renders", R, sel('[data-org-header="chart"]'));
    const node = (t) => holds(`[...document.querySelectorAll("[data-org-node]")].some((n) => n.textContent.includes(${JSON.stringify(t)}) && __smoke.visible(n))`);
    await leg.check("Riley has a node on the chart", R, node(SMOKE_PEOPLE.riley.name));
    await leg.check("her session has a node under her", R, node(SMOKE_SESSION.title.slice(0, 24)));
    await livenessLanded(leg, R, fixtures);
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
  const opened = await Promise.allSettled([openSide("riley", world.riley, dep, dir, "/inbox"), openSide("jordan", world.jordan, dep, dir, "/inbox")]);
  for (const o of opened) if (o.status === "fulfilled") sides.push(o.value);
  const notOpen = opened.find((o) => o.status === "rejected");
  if (notOpen) throw notOpen.reason;
  const [R, J] = sides;
  console.log(`both signed in on the local deployment, prod unreachable from both browsers [${Date.now() - t0} ms]`);
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
