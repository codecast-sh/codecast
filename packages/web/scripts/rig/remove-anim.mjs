#!/usr/bin/env bun
// Frame cost of taking a session out of the inbox: the stash, kill and
// rest-filing gestures (store/undoActions.ts) on a seeded inbox, measured in a
// headless Chrome under CPU throttling on the rig's local deployment (never
// prod; the rows are the smoke identity's own test sessions, put back after
// every run).
//
//   bun scripts/rig/remove-anim.mjs [--throttle 4] [--runs 5] [--scenarios stash,kill,done,active,many]
//       [--ui] [--modern] [--probe] [--trace] [--profile] [--keep] [--out dir] [--cleanup]
//
// Scenarios: stash, kill, done (file as done, which collapses the row and
// grows it into its new section), active (stash the open session, so the
// next one opens), many (a three-row selection), and the right-click menu's
// ctx-stashhide, ctx-defer, ctx-snooze and ctx-delete (the last two through
// the palette step the menu opens; ctx-delete deletes its test rows). The
// ctx- scenarios press the real menu, so they run on any build. Against the smoke vite
// (stack.mjs) the gestures call store/undoActions.ts; --ui presses the card's
// own Stash / Kill buttons instead, for a production build (vite build, then
// vite preview, and RIG_WEB_PORT=<its port>), which can run stash, kill and
// active only. --modern runs in the Modern inbox style.
//
// Per scenario it reports the collapse (from the press to the row's
// animationend, or its removal if that comes first: `cut`) and the 600ms
// after it: frames drawn, frames dropped (rAF gaps in missed vsyncs), the
// longest frame, the long animation frames and the scripts they name.
// --probe times every store action during the gesture, --trace saves a CDP
// trace and --profile a CPU profile of the last run (summarize it with
// scripts/cdp-cpu-summary.mjs against the build's dist). --cleanup deletes
// the seeded sessions.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { localDeployment, adminClient } from "./stack.mjs";
import { seedWorld } from "./seed.mjs";
import { launchSignedIn, killChrome } from "./chrome.mjs";
import { sleep } from "./cdp.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const THROTTLE = Number(arg("throttle", "4"));
const RUNS = Number(arg("runs", "5"));
const SCENARIOS = arg("scenarios", "stash,kill,done,active,many,modern").split(",");
const TRACE = args.includes("--trace");
const PROFILE_CPU = args.includes("--profile");
const PROBE = args.includes("--probe");
const MODERN = args.includes("--modern");
const UI = args.includes("--ui");
const OUT = arg("out", "/tmp/codecast-remove-anim");
const PORT = 9641;
const PROFILE = "/tmp/codecast-remove-anim-chrome";
const PROJECT_HASH = "codecast-perf-remove-anim";
const SESSIONS = 90;
mkdirSync(OUT, { recursive: true });

const LOREM = [
  "Refactor the session list so it stops re-rendering on every heartbeat.",
  "Here is the diff:\n\n```ts\nexport function sigOf(rows: Row[]) {\n  return rows.map((r) => r.id + r.status).join('|');\n}\n```\n\nIt keeps the identity stable.",
  "Run the tests and tell me what fails.",
  "Two tests fail: `inbox.test.ts` expects the old order, and `sync.test.ts` times out waiting for the echo. Both are fixed in the next commit.",
];

async function seedSessions(dep, world) {
  const riley = adminClient(dep, world.riley);
  const marker = `${PROFILE}-seeded-${world.riley}`;
  const have = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
  if (have >= SESSIONS) return;
  const now = Date.now();
  for (let i = have; i < SESSIONS; i++) {
    const id = String(await riley.mutation("conversations:createConversation", {
      user_id: world.riley, team_id: world.teamId, agent_type: "claude_code", session_id: crypto.randomUUID(),
      project_hash: PROJECT_HASH, project_path: "/tmp/codecast-perf", title: `Perf session ${i}: ${LOREM[i % 2].slice(0, 40)}`,
      started_at: now - i * 60_000,
    }));
    const n = i < 3 ? 120 : 6;
    for (let m = 0; m < n; m++) {
      await riley.mutation("messages:addMessage", { conversation_id: id, role: m % 2 ? "assistant" : "user", content: LOREM[m % LOREM.length], message_uuid: crypto.randomUUID() });
    }
    writeFileSync(marker, String(i + 1));
  }
}

// Installed in the page once: a rAF recorder and a LoAF observer.
const RECORDER = `(() => {
  if (window.__ra) return;
  const ra = window.__ra = { frames: [], loafs: [], on: false, animStart: 0, animEnd: 0 };
  document.addEventListener('animationstart', (e) => { if (ra.on && /sessionDismiss/.test(e.animationName) && !ra.animStart) ra.animStart = performance.now(); }, true);
  document.addEventListener('animationend', (e) => { if (ra.on && /sessionDismiss/.test(e.animationName) && !ra.animEnd) { ra.animEnd = performance.now(); performance.mark('ra-animend'); } }, true);
  const tick = (t) => { if (ra.on) ra.frames.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => { if (ra.on) for (const e of list.getEntries()) ra.loafs.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration, render: e.renderStart, style: e.styleAndLayoutStart, scripts: (e.scripts || []).map((s) => ({ dur: Math.round(s.duration), fwd: Math.round(s.forcedStyleAndLayoutDuration || 0), inv: s.invoker, src: (s.sourceURL || "").split("/").slice(-2).join("/") + ":" + (s.sourceFunctionName || "") })) }); }).observe({ type: "long-animation-frame", buffered: false });
  } catch {}
})()`;

// Every store action wrapped with a counter and a timer (nested calls count
// on their own too), reset per run.
const PROBE_JS = `(() => {
  if (window.__raProbe) { window.__raProbe.calls = {}; return; }
  const p = window.__raProbe = { calls: {} };
  const st = __inboxStore.getState();
  const wrapped = {};
  for (const [k, fn] of Object.entries(st)) {
    if (typeof fn !== 'function' || k.startsWith('use')) continue;
    wrapped[k] = function (...a) { const t = performance.now(); try { return fn.apply(this, a); } finally { const c = p.calls[k] || (p.calls[k] = [0, 0]); c[0]++; c[1] += performance.now() - t; } };
  }
  __inboxStore.setState(wrapped);
})()`;
const PROBE_READ = `Object.entries(window.__raProbe?.calls || {}).sort((a, b) => b[1][1] - a[1][1]).slice(0, 25).map(([k, [n, ms]]) => k + ' x' + n + ' ' + Math.round(ms) + 'ms')`;

const pickTarget = (which) => `(() => {
  const s = __inboxStore.getState();
  const cards = [...document.querySelectorAll('[data-session-id]')].filter((el) => el.getBoundingClientRect().height > 0);
  const ours = cards.map((el) => el.getAttribute('data-session-id')).filter((id) => (s.sessions[id]?.project_path || s.conversations[id]?.project_path) === '/tmp/codecast-perf' || /^Perf session/.test(s.sessions[id]?.title || s.conversations[id]?.title || ''));
  const uniq = [...new Set(ours)];
  if (${JSON.stringify(which)} === 'many') return uniq.slice(2, 5);
  return uniq.slice(2, 3);
})()`;

const measure = (gesture, prep) => `(async () => {
  ${prep ? `await (${prep})();` : ""}
  const ra = window.__ra; ra.frames = []; ra.loafs = []; ra.animStart = 0; ra.animEnd = 0; ra.on = true;
  await new Promise((r) => setTimeout(r, 150));
  let removedAt = 0;
  const mo = new MutationObserver(() => { if (!removedAt && ra.animStart && !document.querySelector('.session-dismissing')) { removedAt = performance.now(); performance.mark('ra-removed'); } });
  mo.observe(document.body, { childList: true, subtree: true });
  const t0 = performance.now();
  performance.mark('ra-start');
  await (${gesture})();
  mo.disconnect();
  const tDone = performance.now();
  performance.mark('ra-done');
  await new Promise((r) => setTimeout(r, 700));
  ra.on = false;
  return { t0, tDone, animStart: ra.animStart, animEnd: ra.animEnd, removedAt, frames: ra.frames.slice(), loafs: ra.loafs.slice() };
})()`;

// Production builds cannot import app modules: press the card's own buttons
// and wait for the card to leave the document.
const CLICK = (ids, label) => `async () => {
  for (const id of ${JSON.stringify(ids)}) document.querySelector('[data-session-id="' + id + '"] [aria-label="${label}"]').click();
  const until = performance.now() + 4000;
  while (performance.now() < until && ${JSON.stringify(ids)}.some((id) => document.querySelector('[data-session-id="' + id + '"]'))) await new Promise((r) => setTimeout(r, 10));
}`;
// The right-click menu: opened (and, for an item that hands off to the
// palette, the palette row found) before the window starts, so the window
// times the press that removes the row. Done when the row has changed in the
// store and nothing on the page is still collapsing; a deferred or snoozed row
// can stay on the page.
const WAIT_FOR = `const waitFor = async (f, ms = 4000) => { const until = performance.now() + ms; for (;;) { const v = f(); if (v || performance.now() > until) return v; await new Promise((r) => setTimeout(r, 10)); } };`;
const MENU_PREP = (id, item, paletteRow, openOnly) => `async () => {
  ${WAIT_FOR}
  const card = document.querySelector('[data-session-id="${id}"]');
  const r = card.getBoundingClientRect();
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 30, clientY: r.top + 10, button: 2 }));
  const entry = await waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((el) => el.textContent.trim().startsWith(${JSON.stringify(item)})));
  if (!entry) throw new Error('no menu item ${item}');
  if (${openOnly ? "true" : "false"}) { entry.focus(); await new Promise((r) => setTimeout(r, 300)); return; }
  if (${JSON.stringify(paletteRow ?? "")}) {
    entry.click();
    window.__raPress = await waitFor(() => [...document.querySelectorAll('[role=dialog] button, [cmdk-item]')].find((el) => el.textContent.includes(${JSON.stringify(paletteRow ?? "")})));
    if (!window.__raPress) throw new Error('no palette row ${paletteRow}');
  } else window.__raPress = entry;
  await new Promise((r) => setTimeout(r, 300));
}`;
// Close the open menu without choosing anything: Escape, or a press on the
// page behind it. Done when no menu is left.
const MENU_CLOSE = (how) => `async () => {
  ${WAIT_FOR}
  if (${JSON.stringify(how)} === 'escape') document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  else { const el = document.querySelector('main') || document.body; const r = el.getBoundingClientRect(); const o = { bubbles: true, cancelable: true, clientX: r.right - 40, clientY: r.top + 200, button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true }; el.dispatchEvent(new PointerEvent('pointerdown', o)); el.dispatchEvent(new PointerEvent('pointerup', o)); el.dispatchEvent(new MouseEvent('click', o)); }
  await waitFor(() => !document.querySelector('[role=menu]'));
}`;
const MENU = (id) => `async () => {
  ${WAIT_FOR}
  const before = __inboxStore.getState().sessions[${JSON.stringify(id)}];
  window.__raPress.click();
  await waitFor(() => __inboxStore.getState().sessions[${JSON.stringify(id)}] !== before && !document.querySelector('.session-dismissing'));
}`;
const MENU_SCENARIOS = {
  "ctx-stashhide": { item: "Stash and hide", restore: "restoreSession" },
  "ctx-defer": { item: "Defer" },
  "ctx-snooze": { item: "Snooze", palette: "1 day", restore: "wakeSnoozedSession" },
  "ctx-delete": { item: "Delete session", palette: "for good" },
  "ctx-escape": { close: "escape" },
  "ctx-outside": { close: "outside" },
};
const STASH = (ids) => UI ? CLICK(ids, "Stash") : `async () => { const m = await import('/store/undoActions.ts'); await m.animatedHideSessions(${JSON.stringify(ids)}, 'stash'); }`;
const KILL = (ids) => UI ? CLICK(ids, "Kill Session") : `async () => { const m = await import('/store/undoActions.ts'); await m.animatedHideSessions(${JSON.stringify(ids)}, 'kill'); }`;
const REST = (ids, rest) => `async () => { const m = await import('/store/undoActions.ts'); await m.animatedSetSessionRest(${JSON.stringify(ids)}, ${JSON.stringify(rest)}); }`;

function summarize(r, vsync) {
  const inWin = (t) => t >= r.t0 && t <= r.tDone + 600;
  const fr = r.frames.filter(inWin);
  const gaps = fr.slice(1).map((t, i) => t - fr[i]);
  const dropped = gaps.reduce((n, g) => n + Math.max(0, Math.round(g / vsync) - 1), 0);
  const animEnd = Math.min(r.animEnd || Infinity, r.removedAt || Infinity, r.tDone);
  const cut = !!r.removedAt && (!r.animEnd || r.removedAt < r.animEnd);
  const anim = r.frames.filter((t) => t >= r.t0 && t <= animEnd);
  const animGaps = anim.slice(1).map((t, i) => t - anim[i]);
  const animDropped = animGaps.reduce((n, g) => n + Math.max(0, Math.round(g / vsync) - 1), 0);
  const scripts = new Map();
  for (const l of r.loafs.filter((l) => inWin(l.start))) for (const s of l.scripts) scripts.set(s.src, (scripts.get(s.src) ?? 0) + s.dur);
  return {
    animMs: Math.round(animEnd - r.t0),
    gestureMs: Math.round(r.tDone - r.t0),
    firstFrameMs: r.animStart ? Math.round(r.animStart - r.t0) : null,
    cut,
    frames: fr.length,
    dropped,
    animDropped,
    postDropped: dropped - animDropped,
    longestFrame: Math.round(Math.max(0, ...gaps)),
    loafs: r.loafs.filter((l) => inWin(l.start)).map((l) => Math.round(l.dur)),
    topScripts: [...scripts].sort((a, b) => b[1] - a[1]).slice(0, 5),
  };
}

async function traceDuring(page, fn) {
  const chunks = [];
  const off = page.on((m) => { if (m.method === "Tracing.dataCollected") chunks.push(...m.params.value); });
  await page.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking,disabled-by-default-devtools.timeline.frame,blink.user_timing,toplevel,v8.execute", transferMode: "ReportEvents" });
  const out = await fn();
  const done = new Promise((res) => { const o = page.on((m) => { if (m.method === "Tracing.tracingComplete") { o(); res(); } }); });
  await page.send("Tracing.end");
  await done;
  off();
  return { out, events: chunks };
}

function traceTotals(events) {
  const main = events.filter((e) => e.ph === "X" && e.dur);
  const tid = (() => {
    const names = events.filter((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain");
    return new Set(names.map((e) => `${e.pid}:${e.tid}`));
  })();
  const on = main.filter((e) => tid.has(`${e.pid}:${e.tid}`));
  const sum = (re) => Math.round(on.filter((e) => re.test(e.name)).reduce((a, e) => a + e.dur, 0) / 1000);
  const layouts = on.filter((e) => e.name === "Layout");
  return {
    script: sum(/^(FunctionCall|EvaluateScript|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|v8\.callFunction)$/),
    style: sum(/^(UpdateLayoutTree|RecalculateStyles)$/),
    layout: sum(/^Layout$/),
    layoutCount: layouts.length,
    paint: sum(/^(Paint|PaintImage|PrePaint|Layerize|UpdateLayer|CompositeLayers|Commit)$/),
    gc: sum(/GC/),
  };
}

async function cleanup(dep, world) {
  const riley = adminClient(dep, world.riley);
  // deleteByProjectHash removes one session 50 messages a call.
  let deleted = 0;
  for (let convId, i = 0; i < 20_000; i++) {
    const r = await riley.mutation("conversations:deleteByProjectHash", { project_hash: PROJECT_HASH, ...(convId ? { conv_id: convId } : {}) });
    convId = r.hasMore ? r.conv_id : undefined;
    if (r.deleted && !r.hasMore) deleted++;
    if (!r.hasMore && !r.deleted) break;
  }
  rmSync(`${PROFILE}-seeded-${world.riley}`, { force: true });
  console.log(`deleted ${deleted} seeded sessions`);
}

async function main() {
  const dep = localDeployment();
  const world = await seedWorld(dep);
  if (args.includes("--cleanup")) return cleanup(dep, world);
  await seedSessions(dep, world);
  const { child, page } = await launchSignedIn({ port: PORT, profile: PROFILE, fresh: false, dep, userId: world.riley, path: "/inbox" });
  const cardsUp = async () => {
    for (let i = 0; i < 600; i++) {
      const n = await page.evaluate(`window.__inboxStore ? document.querySelectorAll('[data-session-id]').length : 0`).catch(() => 0);
      if (n >= 20) return;
      await sleep(1000);
    }
  };
  // The Modern style is a per-browser switch with a server mirror
  // (ThemeProvider): set both, then load the inbox again.
  const setModern = async (on) => {
    await page.evaluate(`(() => { localStorage.setItem('codecast-modern-style', '${on ? 1 : 0}'); __inboxStore.getState().updateClientUI({ visual_style: 'classic', modern_style: ${on} }); })()`);
    await sleep(1500);
    await page.navigate(`${dep.appUrl}/inbox`);
    await cardsUp();
  };
  try {
    await cardsUp();
    if (MODERN) await setModern(true);
    // The boot warm loop fills cold rows for a while (60 a pass); a gesture
    // measured inside it measures the loop. Wait until it plans nothing.
    for (let i = 0, quiet = 0; i < 240 && quiet < 3; i++) {
      const idle = await page.evaluate(`(() => { const w = window.__inboxWarm; return !!w?.lastPass && w.lastPass.planned === 0 && w.inFlight.size === 0; })()`).catch(() => false);
      quiet = idle ? quiet + 1 : 0;
      await sleep(1000);
    }
    await page.evaluate(RECORDER);
    const vsync = await page.evaluate(`new Promise((r) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 30) requestAnimationFrame(f); else { const g = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b); r(g[Math.floor(g.length / 2)]); } }; requestAnimationFrame(f); })`);
    console.log(`vsync ${vsync.toFixed(1)}ms, throttle ${THROTTLE}x, cards ${await page.evaluate(`document.querySelectorAll('[data-session-id]').length`)}`);
    const results = {};
    for (const sc of SCENARIOS) {
      results[sc] = [];
      for (let run = 0; run < RUNS; run++) {
        const ids = await page.evaluate(pickTarget(sc));
        if (!ids?.length) throw new Error(`${sc}: no test session card on screen`);
        if (sc === "active") {
          await page.evaluate(`(() => { const el = document.querySelector('[data-session-id="${ids[0]}"]'); el.click(); })()`);
          await sleep(2500);
        }
        const before = await page.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, __inboxStore.getState().sessions[id]?.user_rest ?? null]))`);
        const menu = MENU_SCENARIOS[sc];
        const gesture = menu?.close ? MENU_CLOSE(menu.close) : menu ? MENU(ids[0]) : sc === "kill" ? KILL(ids) : sc === "done" ? REST(ids, before[ids[0]] === "done" ? "dormant" : "done") : STASH(ids);
        const prep = menu ? MENU_PREP(ids[0], menu.item ?? "Rename", menu.palette, !!menu.close) : null;
        if (PROBE) await page.evaluate(PROBE_JS);
        await page.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
        const doTrace = TRACE && run === RUNS - 1;
        const doProfile = PROFILE_CPU && run === RUNS - 1;
        if (doProfile) { await page.send("Profiler.enable"); await page.send("Profiler.setSamplingInterval", { interval: 200 }); await page.send("Profiler.start"); }
        const { out, events } = doTrace ? await traceDuring(page, () => page.evaluate(measure(gesture, prep))) : { out: await page.evaluate(measure(gesture, prep)), events: null };
        await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        const s = summarize(out, vsync);
        if (PROBE) s.actions = await page.evaluate(PROBE_READ);
        if (doProfile) {
          const { profile } = await page.send("Profiler.stop");
          writeFileSync(`${OUT}/${sc}.cpuprofile`, JSON.stringify(profile));
        }
        if (events) {
          s.trace = traceTotals(events.filter((e) => e.ts / 1000 >= 0));
          writeFileSync(`${OUT}/${sc}.trace.json`, JSON.stringify({ traceEvents: events }));
        }
        results[sc].push(s);
        console.log(sc, run, JSON.stringify(s));
        // Put the rows back where they were.
        const restore = menu ? menu.restore : sc === "done" ? null : "restoreSession";
        await page.evaluate(`(() => { const s = __inboxStore.getState(); for (const [id, rest] of Object.entries(${JSON.stringify(before)})) { if (${JSON.stringify(sc)} === 'done') s.setSessionRest(id, rest ?? 'needs_input'); else if (${JSON.stringify(restore)}) s[${JSON.stringify(restore)}](id); } })()`);
        await sleep(2000);
      }
    }
    const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log("\nscenario  dropped(med)  anim-dropped  post-dropped  longest(med)  frames");
    for (const [sc, rs] of Object.entries(results)) {
      console.log(sc.padEnd(9), String(med(rs.map((r) => r.dropped))).padStart(12), String(med(rs.map((r) => r.animDropped))).padStart(13), String(med(rs.map((r) => r.postDropped))).padStart(13), String(med(rs.map((r) => r.longestFrame))).padStart(13), String(med(rs.map((r) => r.frames))).padStart(7));
    }
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
    if (MODERN) await setModern(false);
  } finally {
    if (!args.includes("--keep")) killChrome(child, PROFILE);
  }
}

await main();
process.exit(0);
