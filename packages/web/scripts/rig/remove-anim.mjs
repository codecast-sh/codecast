#!/usr/bin/env bun
// Frame cost of taking a session out of the inbox: the stash, kill and
// rest-filing gestures (store/undoActions.ts) on a seeded inbox, measured in a
// headless Chrome under CPU throttling on the rig's local deployment (never
// prod; the rows are the smoke identity's own test sessions, put back after
// every run).
//
//   bun scripts/rig/remove-anim.mjs [--throttle 4] [--runs 5] [--scenarios stash,kill,done,active,many,modern] [--trace]
//
// Per scenario it reports, over the collapse and the 600ms after it:
// frames drawn, frames dropped (rAF intervals past 1.5 vsyncs, counted in
// missed vsyncs), the longest frame, main-thread script/style/layout/paint
// from the trace, and the scripts the long animation frames name.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const OUT = arg("out", "/tmp/perf-pass/remove-anim");
const PORT = 9641;
const PROFILE = "/tmp/perf-pass/chrome-remove-anim";
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
  const marker = `${OUT}/seeded-${world.riley}`;
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

const pickTarget = (which) => `(() => {
  const s = __inboxStore.getState();
  const cards = [...document.querySelectorAll('[data-session-id]')].filter((el) => el.getBoundingClientRect().height > 0);
  const ours = cards.map((el) => el.getAttribute('data-session-id')).filter((id) => (s.sessions[id]?.project_path || s.conversations[id]?.project_path) === '/tmp/codecast-perf' || /^Perf session/.test(s.sessions[id]?.title || s.conversations[id]?.title || ''));
  const uniq = [...new Set(ours)];
  if (${JSON.stringify(which)} === 'many') return uniq.slice(2, 5);
  return uniq.slice(2, 3);
})()`;

const measure = (gesture) => `(async () => {
  const ra = window.__ra; ra.frames = []; ra.loafs = []; ra.animStart = 0; ra.animEnd = 0; ra.on = true;
  await new Promise((r) => setTimeout(r, 150));
  const t0 = performance.now();
  performance.mark('ra-start');
  let tCommit = 0;
  const unsub = __inboxStore.subscribe(() => { if (!tCommit) tCommit = performance.now(); });
  await (${gesture})();
  unsub();
  const tDone = performance.now();
  performance.mark('ra-done');
  await new Promise((r) => setTimeout(r, 700));
  ra.on = false;
  return { t0, tCommit, tDone, animStart: ra.animStart, animEnd: ra.animEnd, frames: ra.frames.slice(), loafs: ra.loafs.slice() };
})()`;

const UI = args.includes("--ui");
// Production builds cannot import app modules: press the card's own buttons
// and wait for the card to leave the document.
const CLICK = (ids, label) => `async () => {
  for (const id of ${JSON.stringify(ids)}) document.querySelector('[data-session-id="' + id + '"] [aria-label="${label}"]').click();
  const until = performance.now() + 4000;
  while (performance.now() < until && ${JSON.stringify(ids)}.some((id) => document.querySelector('[data-session-id="' + id + '"]'))) await new Promise((r) => setTimeout(r, 10));
}`;
const STASH = (ids) => UI ? CLICK(ids, "Stash") : `async () => { const m = await import('/store/undoActions.ts'); await m.animatedHideSessions(${JSON.stringify(ids)}, 'stash'); }`;
const KILL = (ids) => UI ? CLICK(ids, "Kill Session") : `async () => { const m = await import('/store/undoActions.ts'); await m.animatedHideSessions(${JSON.stringify(ids)}, 'kill'); }`;
const REST = (ids, rest) => `async () => { const m = await import('/store/undoActions.ts'); await m.animatedSetSessionRest(${JSON.stringify(ids)}, ${JSON.stringify(rest)}); }`;

function summarize(r, vsync) {
  const inWin = (t) => t >= r.t0 && t <= r.tDone + 600;
  const fr = r.frames.filter(inWin);
  const gaps = fr.slice(1).map((t, i) => t - fr[i]);
  const dropped = gaps.reduce((n, g) => n + Math.max(0, Math.round(g / vsync) - 1), 0);
  const animEnd = r.animEnd || r.tDone;
  const anim = r.frames.filter((t) => t >= r.t0 && t <= animEnd);
  const animGaps = anim.slice(1).map((t, i) => t - anim[i]);
  const animDropped = animGaps.reduce((n, g) => n + Math.max(0, Math.round(g / vsync) - 1), 0);
  const scripts = new Map();
  for (const l of r.loafs.filter((l) => inWin(l.start))) for (const s of l.scripts) scripts.set(s.src, (scripts.get(s.src) ?? 0) + s.dur);
  return {
    animMs: Math.round(animEnd - r.t0),
    gestureMs: Math.round(r.tDone - r.t0),
    commitAt: r.tCommit ? Math.round(r.tCommit - r.t0) : null,
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
  await page.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.frame,blink.user_timing,toplevel,v8.execute", transferMode: "ReportEvents" });
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

// Self and inclusive time by function over the profile, the idle and
// program nodes left out.
function profileTop(profile) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const dt = new Map();
  profile.samples.forEach((id, i) => dt.set(id, (dt.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0)));
  const label = (n) => `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").slice(-2).join("/").replace(/\?.*/, "")}:${n.callFrame.lineNumber + 1}`;
  const self = new Map(), incl = new Map();
  for (const [id, us] of dt) {
    const n = byId.get(id);
    if (/^\((idle|program|garbage collector)\)$/.test(n.callFrame.functionName)) { self.set(n.callFrame.functionName, (self.get(n.callFrame.functionName) ?? 0) + us); continue; }
    self.set(label(n), (self.get(label(n)) ?? 0) + us);
    const seen = new Set();
    for (let x = id; x != null; x = parent.get(x)) { const l = label(byId.get(x)); if (!seen.has(l)) { seen.add(l); incl.set(l, (incl.get(l) ?? 0) + us); } }
  }
  const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k).map(([l, us]) => `${Math.round(us / 1000)}ms ${l}`);
  return { self: top(self, 25), incl: top(incl, 60) };
}

async function main() {
  const dep = localDeployment();
  const world = await seedWorld(dep);
  await seedSessions(dep, world);
  const { child, page } = await launchSignedIn({ port: PORT, profile: PROFILE, fresh: false, dep, userId: world.riley, path: "/inbox" });
  try {
    for (let i = 0; i < 600; i++) {
      const n = await page.evaluate(`window.__inboxStore ? document.querySelectorAll('[data-session-id]').length : 0`).catch(() => 0);
      if (n >= 20) break;
      await sleep(1000);
    }
    await page.evaluate(RECORDER);
    const vsync = await page.evaluate(`new Promise((r) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 30) requestAnimationFrame(f); else { const g = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b); r(g[Math.floor(g.length / 2)]); } }; requestAnimationFrame(f); })`);
    console.log(`vsync ${vsync.toFixed(1)}ms, throttle ${THROTTLE}x, cards ${await page.evaluate(`document.querySelectorAll('[data-session-id]').length`)}`);
    const results = {};
    for (const sc of SCENARIOS) {
      if (sc === "modern") await page.evaluate(`(async () => { const s = __inboxStore.getState(); (s.updateClientUI ?? s.setClientUI)?.({ inbox_style: 'modern' }); await new Promise((r) => setTimeout(r, 1500)); })()`);
      results[sc] = [];
      for (let run = 0; run < RUNS; run++) {
        const ids = await page.evaluate(pickTarget(sc));
        if (!ids?.length) throw new Error(`${sc}: no test session card on screen`);
        if (sc === "active") {
          await page.evaluate(`(() => { const el = document.querySelector('[data-session-id="${ids[0]}"]'); el.click(); })()`);
          await sleep(2500);
        }
        const before = await page.evaluate(`Object.fromEntries(${JSON.stringify(ids)}.map((id) => [id, __inboxStore.getState().sessions[id]?.user_rest ?? null]))`);
        const gesture = sc === "kill" ? KILL(ids) : sc === "done" ? REST(ids, before[ids[0]] === "done" ? "dormant" : "done") : STASH(ids);
        await page.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });
        const doTrace = TRACE && run === RUNS - 1;
        const doProfile = PROFILE_CPU && run === RUNS - 1;
        if (doProfile) { await page.send("Profiler.enable"); await page.send("Profiler.setSamplingInterval", { interval: 200 }); await page.send("Profiler.start"); }
        const { out, events } = doTrace ? await traceDuring(page, () => page.evaluate(measure(gesture))) : { out: await page.evaluate(measure(gesture)), events: null };
        await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        const s = summarize(out, vsync);
        if (doProfile) {
          const { profile } = await page.send("Profiler.stop");
          writeFileSync(`${OUT}/${sc}.cpuprofile`, JSON.stringify(profile));
          s.profile = profileTop(profile);
        }
        if (events) {
          s.trace = traceTotals(events.filter((e) => e.ts / 1000 >= 0));
          writeFileSync(`${OUT}/${sc}.trace.json`, JSON.stringify({ traceEvents: events }));
        }
        results[sc].push(s);
        console.log(sc, run, JSON.stringify(s));
        // Put the rows back where they were.
        await page.evaluate(`(() => { const s = __inboxStore.getState(); for (const [id, rest] of Object.entries(${JSON.stringify(before)})) { if (${JSON.stringify(sc)} === 'done') s.setSessionRest(id, rest ?? 'needs_input'); else s.restoreSession(id); } })()`);
        await sleep(2000);
      }
      if (sc === "modern") await page.evaluate(`__inboxStore.getState().updateClientUI?.({ inbox_style: 'classic' })`);
    }
    const med = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    console.log("\nscenario  dropped(med)  anim-dropped  post-dropped  longest(med)  frames");
    for (const [sc, rs] of Object.entries(results)) {
      console.log(sc.padEnd(9), String(med(rs.map((r) => r.dropped))).padStart(12), String(med(rs.map((r) => r.animDropped))).padStart(13), String(med(rs.map((r) => r.postDropped))).padStart(13), String(med(rs.map((r) => r.longestFrame))).padStart(13), String(med(rs.map((r) => r.frames))).padStart(7));
    }
    writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  } finally {
    if (!args.includes("--keep")) killChrome(child, PROFILE);
  }
}

await main();
process.exit(0);
