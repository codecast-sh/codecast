#!/usr/bin/env bun
/**
 * Soak + chaos for `cast browser` in real mode, against one isolated rig.
 *
 * K agent sessions (distinct CAST_SESSION_ID keys) each loop realistic
 * scenarios through the CLI from checkout source: open, snapshot, click,
 * type, a second tab opened and closed, a screenshot, a handoff armed and
 * cancelled. Meanwhile a chaos loop fires, one event at a time: kill -9 the
 * bridge host, stop the extension's service worker, restart the rig Chrome,
 * detach the debugger behind the extension's back, freeze the host
 * (SIGSTOP, then SIGCONT).
 *
 * The pages come from this script's own server, and every click and
 * keystroke on them posts a beacon naming the page's owner session. That is
 * the oracle, independent of the CLI's own account:
 *
 *   - isolation: a beacon from session S's page must match an action S has
 *     outstanding on that page; any other beacon is an action on someone
 *     else's tab (or a replayed one), and a snapshot that shows another
 *     session's page is the same failure in the read direction;
 *   - no silent success: a click or type the CLI reports as done must
 *     produce its beacon on the element it named;
 *   - no hang: every command runs under a hard deadline (--deadline);
 *   - clear errors: a failed command says why (no empty output, no stack);
 *   - recovery: after each chaos event a probe session must complete
 *     open + snapshot within --recovery-bound seconds;
 *   - no leaks: at the end no soak page is left open after every session
 *     closed its tab, no command process outlives its run, at most one
 *     bridge host listens on the rig port and none is stopped.
 *
 * Usage (rig first: bun packages/cli/scripts/browser-rig.ts up --fixtures --name <n>):
 *
 *   bun packages/cli/scripts/browser-stress/soak.ts --rig <n> [--sessions 4] [--minutes 3]
 *       [--chaos-every 40] [--chaos host-kill9,sw-stop,chrome-restart,debugger-detach,host-freeze]
 *       [--recovery-bound 120] [--deadline 150] [--seed N] [--long] [--force] [--max-load 400]
 *
 * --minutes over 10 needs --long (the machine is shared). Results (tasks,
 * chaos, beacons, violations, summary.md) land in $TMPDIR/cast-browser-stress/.
 * Exit 0 only when no invariant was violated.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bridgeHostPidsOnPort } from "../../src/browser/bridge/host.ts";
import { BRIDGE_EXTENSION_ID } from "../../src/browser/bridge/protocol.ts";
import {
  alive, args, CdpClient, checkLoad, cli, die, inWorker, liveChildren, oneLine, pipeHolders, processTree, procState, requireRig, Rng, rigBridge, RIG_SCRIPT, run, RunLog, sleep, type RunResult,
} from "./lib.ts";

const A = args();
const rig = requireRig(A.opt("rig"));
const SESSIONS = A.num("sessions", 4);
const MINUTES = A.num("minutes", 3);
if (MINUTES > 10 && !A.flag("long")) die("--minutes over 10 needs --long: the machine is shared");
const CHAOS_EVERY_MS = A.num("chaos-every", 40) * 1000;
const ALL_CHAOS = ["host-kill9", "sw-stop", "chrome-restart", "debugger-detach", "host-freeze"] as const;
type Chaos = (typeof ALL_CHAOS)[number];
const CHAOS = (A.opt("chaos", ALL_CHAOS.join(","))!.split(",").filter((c) => c && c !== "none")) as Chaos[];
for (const c of CHAOS) if (!ALL_CHAOS.includes(c)) die(`unknown chaos event ${c}; known: ${ALL_CHAOS.join(", ")}`);
const RECOVERY_BOUND_MS = A.num("recovery-bound", 120) * 1000;
const DEADLINE_MS = A.num("deadline", 150) * 1000;
const SEED = A.num("seed", Date.now() % 100_000);
const load = checkLoad(A.num("max-load", 400), A.flag("force"));
const rng = new Rng(SEED);
/**
 * Which driver the CLI uses: the engine (agent-browser), as every machine with
 * it installed runs, or the built-in driver (--legacy). The rig's HOME has no
 * engine of its own, so the human's installed copy is named by path; only its
 * binary is read, and its daemons keep their sockets in the rig directory.
 */
const LEGACY = A.flag("legacy");
const ENGINE = LEGACY ? null : (A.opt("engine") ?? findInstalledEngine());
if (!LEGACY && !ENGINE) die("no agent-browser engine found; pass --engine <path> or --legacy for the built-in driver");
const driverEnv: Record<string, string> = LEGACY ? { CAST_BROWSER_LEGACY: "1" } : { CAST_BROWSER_ENGINE: ENGINE! };
const log = new RunLog("soak", SEED);
const RUN = `s${SEED}`;

console.log(`soak: rig ${rig.name}, ${LEGACY ? "built-in driver" : `engine ${ENGINE}`}, ${SESSIONS} sessions, ${MINUTES} min, chaos every ~${CHAOS_EVERY_MS / 1000}s [${CHAOS.join(", ") || "none"}], seed ${SEED}, load ${load.toFixed(0)}`);
console.log(`soak: results in ${log.dir}`);

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

type Kind = "cross-session" | "silent-success" | "hang" | "unclear-error" | "no-recovery" | "leak" | "duplicate-tab" | "host-crash";
const violations: Array<{ kind: Kind; detail: string }> = [];
function violation(kind: Kind, detail: string): void {
  violations.push({ kind, detail });
  log.write("violations.jsonl", { kind, detail });
  console.log(`  !! ${kind}: ${oneLine(detail, 300)}`);
}

// ---------------------------------------------------------------------------
// The pages and their beacons
// ---------------------------------------------------------------------------

interface Beacon { owner: string; n: number; kind: "click" | "input"; item?: number; value?: string; at: number; url: string }
const beacons: Beacon[] = [];
interface Expect { owner: string; n: number; kind: "click" | "input"; item?: number; token?: string; since: number; settled?: Beacon[] }
const expectations: Expect[] = [];

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/beacon" && req.method === "POST") {
      const b = (await req.json().catch(() => null)) as Beacon | null;
      if (b && typeof b.owner === "string") {
        b.at = Date.now();
        beacons.push(b);
        log.write("beacons.jsonl", b as any);
        match(b);
      }
      return new Response("ok", { headers: { "access-control-allow-origin": "*" } });
    }
    if (url.pathname === "/page") {
      const owner = url.searchParams.get("owner") ?? "?";
      const n = Number(url.searchParams.get("n") ?? 0);
      const esc = Bun.escapeHTML;
      const items = [0, 1, 2, 3].map((j) => `<li><button data-item="${j}">Pick ${esc(owner)}-${n}-${j}</button></li>`).join("");
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>soak ${esc(owner)} ${n}</title></head><body>
<h1>Page ${esc(owner)} ${n}</h1><ul>${items}</ul>
<label>Note <input id="note" aria-label="Note"></label>
<script>
const meta = { owner: ${JSON.stringify(owner)}, n: ${n} };
const post = (b) => fetch("/beacon", { method: "POST", keepalive: true, body: JSON.stringify({ ...meta, ...b, url: location.href }) }).catch(() => {});
document.querySelector("ul").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) post({ kind: "click", item: Number(b.dataset.item) }); });
let t; document.getElementById("note").addEventListener("input", (e) => { clearTimeout(t); const v = e.target.value; t = setTimeout(() => post({ kind: "input", value: v }), 250); });
</script></body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }
    return new Response("not found", { status: 404 });
  },
});
const ORIGIN = `http://127.0.0.1:${server.port}`;
const pageUrl = (owner: string, n: number, extra = "") => `${ORIGIN}/page?owner=${encodeURIComponent(owner)}&n=${n}&run=${RUN}${extra}`;

/** Pair a beacon with the action that should have caused it. */
function match(b: Beacon): void {
  const e = expectations.find((x) =>
    x.owner === b.owner && x.n === b.n && x.kind === b.kind &&
    (b.kind === "click" ? x.item === b.item && !x.settled?.length : typeof b.value === "string" && !!x.token && (x.token.startsWith(b.value) || b.value.includes(x.token))));
  if (e) (e.settled ??= []).push(b);
  else unmatched.push(b);
}
const unmatched: Beacon[] = [];

/** Unmatched beacons older than a grace window are actions nobody asked for on that page. */
function sweepUnmatched(final = false): void {
  const cutoff = Date.now() - 10_000;
  for (let i = unmatched.length - 1; i >= 0; i--) {
    const b = unmatched[i];
    if (!final && b.at > cutoff) continue;
    unmatched.splice(i, 1);
    // A late beacon for an expectation that already gave up is still the right page and element.
    const late = expectations.find((x) => x.owner === b.owner && x.n === b.n && x.kind === b.kind && (b.kind === "click" ? x.item === b.item : !!x.token && !!b.value && b.value.includes(x.token)));
    if (late && b.kind === "click" && late.settled?.length) {
      violation("cross-session", `a click on ${b.owner}'s page n=${b.n} item ${b.item} arrived twice: the action was replayed`);
    } else if (!late) {
      violation("cross-session", `${b.kind} on ${b.owner}'s page n=${b.n} (${b.kind === "click" ? `item ${b.item}` : JSON.stringify(b.value)}) that no session asked for there`);
    }
  }
}

// ---------------------------------------------------------------------------
// Chaos windows: failures inside one are excused, everything else is not
// ---------------------------------------------------------------------------

const windows: Array<{ kind: string; start: number; end: number | null }> = [];
const excused = (start: number, end: number) => windows.some((w) => start <= (w.end ?? Infinity) + 5_000 && end >= w.start);
let chromeRestartedAt = 0;

// ---------------------------------------------------------------------------
// Running the CLI as a session
// ---------------------------------------------------------------------------

const stats = { commands: 0, ok: 0, failed: 0, excusedFailures: 0, iterations: 0, iterationsOk: 0 };
const latency: Record<string, number[]> = {};

/** When each soak page was opened: a page left over from before a Chrome restart is Chrome's session restore, not a leak. */
const openedAt = new Map<string, number>();
let lastChromeRestart = 0;

async function step(session: string, argv: string[]): Promise<RunResult> {
  if (argv[0] === "open") for (const a of argv) if (a.startsWith(ORIGIN)) openedAt.set(a, Date.now());
  const r = await cli(rig, session, argv, DEADLINE_MS, driverEnv, (pid) => dumpHang(session, argv, pid));
  stats.commands++;
  const verb = argv[0];
  (latency[verb] ??= []).push(r.ms);
  const out = `${r.stdout}\n${r.stderr}`.trim();
  const end = Date.now();
  const start = end - r.ms;
  log.write("tasks.jsonl", { session, argv, code: r.code, ms: r.ms, hung: r.hung, out: oneLine(out, 600) });
  if (r.hung) {
    violation("hang", `${session}: \`browser ${argv.join(" ")}\` ran past its ${DEADLINE_MS / 1000}s deadline${r.exitedMs !== null ? ` (the process exited at ${r.exitedMs}ms; its output stayed open)` : ""}`);
  } else if (r.code !== 0) {
    stats.failed++;
    if (excused(start, end)) stats.excusedFailures++;
    // A clear error is a sentence the agent can act on, not silence or a stack trace.
    if (!out || /^\s+at .+:\d+:\d+\)?$/m.test(out) || /TypeError|ReferenceError|undefined is not|Cannot read properties/.test(out)) {
      violation("unclear-error", `${session}: \`browser ${argv.join(" ")}\` exited ${r.code} with ${out ? `a stack or engine error: ${oneLine(out, 400)}` : "no output at all"}`);
    }
  } else stats.ok++;
  return r;
}

let hangs = 0;
let restoredByChrome = 0;
/** Before a hung command is killed: its process tree, whether the host still answers, and the worker's own notes. */
async function dumpHang(session: string, argv: string[], pid: number): Promise<void> {
  const b = rigBridge(rig);
  const t = Date.now();
  const list = await fetch(`http://127.0.0.1:${b.port}/json/list?token=${b.token}`, { signal: AbortSignal.timeout(20_000) })
    .then(async (r) => `${r.status} in ${Date.now() - t}ms: ${oneLine(await r.text(), 600)}`, (e) => `no answer in ${Date.now() - t}ms: ${(e as Error).message}`);
  const notes = await inWorker(rig.cdpPort, BRIDGE_EXTENSION_ID, `recent.slice(-25).join("\\n")`).catch((e) => `unreadable: ${(e as Error).message}`);
  const file = log.text(`hang-${++hangs}.txt`, [
    `${session}: browser ${argv.join(" ")}`,
    "", "## process tree", processTree(pid),
    "", "## other processes holding our output pipes", pipeHolders().map((l) => {
      const holder = Number(l.split(/\s+/)[1]);
      return `${l}\n    ${Bun.spawnSync(["ps", "-o", "pid=,ppid=,etime=,command=", "-p", String(holder)]).stdout.toString().trim().slice(0, 300)}`;
    }).join("\n") || "(none)",
    "", "## bridge /json/list", list,
    "", "## extension notes", String(notes),
    "", "## host log tail", fs.readFileSync(path.join(rig.dir, "logs", "bridge-host.log"), "utf-8").split("\n").slice(-15).join("\n"),
  ].join("\n"));
  console.log(`  hang dump: ${file}`);
}

/** Wait for the beacons an action should cause; returns them, or [] once the window passes. */
async function awaitBeacon(e: Expect, ms = 8_000): Promise<Beacon[]> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (e.settled?.length && (e.kind === "click" || e.settled.some((b) => b.value?.includes(e.token!)))) return e.settled;
    await sleep(150);
  }
  return e.settled ?? [];
}

interface Ref { role: string; name: string; ref: string }
/** Refs from either driver's snapshot: the engine's `- button "x" [ref=e3]`, the built-in `button "x" #e3`. */
function refs(snapshot: string): Ref[] {
  const out: Ref[] = [];
  for (const m of snapshot.matchAll(/^\s*- (\w+) "([^"]*)" \[(?:[^\]]*, )?ref=(e\d+)\]/gm)) out.push({ role: m[1], name: m[2].trim(), ref: `@${m[3]}` });
  for (const m of snapshot.matchAll(/^(\w+) "([^"]*)"(?: \[[^\]]*\])* (#e\d+)$/gm)) out.push({ role: m[1], name: m[2].trim(), ref: m[3] });
  return out;
}

/** A snapshot's view must be this session's own page n, or it is reading someone else's tab. */
function checkView(session: string, n: number, snap: string, where: string): boolean {
  const owners = [...snap.matchAll(/owner=([\w-]+)/g)].map((m) => m[1]).concat([...snap.matchAll(/Pick ([\w-]+)-\d+-\d/g)].map((m) => m[1]));
  const foreign = owners.filter((o) => o !== session);
  if (foreign.length) {
    violation("cross-session", `${session} ${where}: its snapshot shows ${[...new Set(foreign)].join(", ")}'s page`);
    return false;
  }
  if (!new RegExp(`Pick ${session}-${n}-\\d`).test(snap)) return false; // not a violation: a stale page after chaos, caught by the scenario's failure
  return true;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Agent { session: string; rng: Rng; n: number; tab: string | null }

/** This session's tab showing page n (the engine lists all of its tabs, the built-in driver its one). */
async function myTab(a: Agent): Promise<string | null> {
  const r = await step(a.session, ["tabs"]);
  if (r.code !== 0) return null;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*\* \[?([0-9A-F]{8})\]?\s/.exec(line);
    if (m && (LEGACY || line.includes(`owner=${a.session}&n=${a.n}&`))) return m[1];
  }
  return null;
}

async function openPage(a: Agent): Promise<boolean> {
  a.n++;
  const r = await step(a.session, ["open", pageUrl(a.session, a.n)]);
  if (r.code !== 0) return false;
  a.tab = /\btab ([0-9A-F]{8})\b/.exec(r.stdout)?.[1] ?? a.tab;
  // `open` prints the page it landed on; another session's page there is a cross-tab navigate.
  const foreign = /owner=([\w-]+)/.exec(r.stdout)?.[1];
  if (foreign && foreign !== a.session) violation("cross-session", `${a.session} open printed ${foreign}'s page`);
  return true;
}

async function snapshot(a: Agent, where: string): Promise<Ref[] | null> {
  const r = await step(a.session, ["snapshot", LEGACY ? "--interactive" : "-i"]);
  if (r.code !== 0) return null;
  return checkView(a.session, a.n, r.stdout, where) ? refs(r.stdout) : null;
}

async function scenarioClick(a: Agent): Promise<boolean> {
  const list = await snapshot(a, "before click");
  const picks = list?.filter((r) => r.role === "button" && r.name.startsWith(`Pick ${a.session}-${a.n}-`)) ?? [];
  if (!picks.length) return false;
  const target = a.rng.pick(picks);
  const item = Number(target.name.split("-").pop());
  const e: Expect = { owner: a.session, n: a.n, kind: "click", item, since: Date.now() };
  expectations.push(e);
  const r = await step(a.session, ["click", target.ref]);
  const got = await awaitBeacon(e, r.code === 0 ? 8_000 : 3_000);
  if (r.code === 0 && !got.length && Date.now() - chromeRestartedAt > 30_000) {
    violation("silent-success", `${a.session} click ${target.ref} ("${target.name}") reported success but the page saw no click`);
  }
  return r.code === 0 && got.length > 0;
}

async function scenarioType(a: Agent): Promise<boolean> {
  const list = await snapshot(a, "before type");
  const box = list?.find((r) => r.role === "textbox" && r.name === "Note");
  if (!box) return false;
  const token = `tok-${a.session}-${a.n}-${a.rng.int(1e6)}`;
  const e: Expect = { owner: a.session, n: a.n, kind: "input", token, since: Date.now() };
  expectations.push(e);
  const r = await step(a.session, ["type", box.ref, token]);
  const got = await awaitBeacon(e, r.code === 0 ? 8_000 : 3_000);
  const full = got.some((b) => b.value?.includes(token));
  if (r.code === 0 && !full && Date.now() - chromeRestartedAt > 30_000) {
    violation("silent-success", `${a.session} type ${box.ref} reported success but the page holds ${JSON.stringify(got.at(-1)?.value ?? null)}, not ${token}`);
  }
  return r.code === 0 && full;
}

/** A second tab, then back to the first, the way an agent that wants its first tab back must. */
async function scenarioTabs(a: Agent): Promise<boolean> {
  const first = await myTab(a);
  if (!first) return false;
  a.n++;
  const r = await step(a.session, ["open", "--new-tab", pageUrl(a.session, a.n, `&second=1&op=${a.rng.int(1e9)}`)]);
  if (r.code !== 0) return false;
  const op = /[?&]op=(\d+)/.exec(r.stdout)?.[1];
  if (op) {
    const copies = (await chromePages()).filter((p) => p.url.includes(`op=${op}&`) || p.url.endsWith(`op=${op}`));
    if (copies.length > 1) violation("duplicate-tab", `${a.session}: one \`open --new-tab\` left ${copies.length} tabs at ${copies[0].url}`);
  }
  const second = /\btab ([0-9A-F]{8})\b/.exec(r.stdout)?.[1];
  const ok = !!(await snapshot(a, "in its second tab"));
  const closed = await step(a.session, LEGACY ? ["close"] : ["tab", "close", second ?? ""]);
  a.n--; // the first tab still shows the page before
  // The engine drives the session's remaining tab on its own after a close;
  // the built-in driver keeps one tab per session and is sent back by id.
  if (LEGACY && (await step(a.session, ["tab", first])).code !== 0) return false;
  return ok && !!second && closed.code === 0 && !!(await snapshot(a, "after closing its second tab"));
}

async function scenarioShot(a: Agent): Promise<boolean> {
  const r = await step(a.session, ["shot"]);
  if (r.code !== 0) return false;
  const file = /^\S+ (\/\S+\.(?:png|jpe?g|webp))/m.exec(r.stdout)?.[1];
  if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0) {
    violation("silent-success", `${a.session} shot reported success but wrote no image (${oneLine(r.stdout, 200)})`);
    return false;
  }
  fs.rmSync(file, { force: true });
  return true;
}

/** Arm a handoff on this session's tab (the extension's own Cast.handoff, as the verb sends it), read it back, cancel it. */
async function scenarioHandoff(a: Agent): Promise<boolean> {
  const tab = await myTab(a);
  if (!tab) return false;
  let c: CdpClient | null = null;
  try {
    const b = rigBridge(rig);
    c = await CdpClient.bridge(b.port, b.token);
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: tab, flatten: true }, undefined, 45_000);
    const armed = await c.send("Cast.handoff", { text: `soak handoff for ${a.session}`, id: `soak-${a.session}-${a.n}`, timeoutMs: 60_000 }, sessionId, 20_000);
    if (armed?.state !== "waiting") return false;
  } catch {
    return false;
  } finally {
    c?.close();
  }
  const status = await step(a.session, ["handoff", "--status"]);
  if (status.code === 0 && !/waiting/.test(status.stdout)) {
    violation("silent-success", `${a.session} armed a handoff but \`handoff --status\` says: ${oneLine(status.stdout, 200)}`);
  }
  const cancel = await step(a.session, ["handoff", "--cancel"]);
  if (cancel.code === 0 && !/cancelled|No handoff/.test(cancel.stdout)) {
    violation("silent-success", `${a.session} \`handoff --cancel\` exited 0 but said: ${oneLine(cancel.stdout, 200)}`);
  }
  return cancel.code === 0;
}

const SCENARIOS: Array<[string, number, (a: Agent) => Promise<boolean>]> = [
  ["click", 4, scenarioClick],
  ["type", 3, scenarioType],
  ["tabs", 2, scenarioTabs],
  ["shot", 1, scenarioShot],
  // The built-in driver has no handoff verb (cliEngine registers it).
  ...(LEGACY ? [] : [["handoff", 1, scenarioHandoff] as [string, number, (a: Agent) => Promise<boolean>]]),
];
const pickScenario = (r: Rng) => {
  let x = r.int(SCENARIOS.reduce((s, [, w]) => s + w, 0));
  for (const s of SCENARIOS) if ((x -= s[1]) < 0) return s;
  return SCENARIOS[0];
};

async function agentLoop(a: Agent, until: number): Promise<void> {
  while (Date.now() < until) {
    const [name, , fn] = pickScenario(a.rng);
    const start = Date.now();
    stats.iterations++;
    // Every iteration starts from a fresh page in this session's own tab, so a
    // chaos event that tore the last one down costs one iteration, not the run.
    const ok = (await openPage(a)) && (await fn(a));
    if (ok) stats.iterationsOk++;
    log.write("iterations.jsonl", { session: a.session, scenario: name, ok, ms: Date.now() - start, excused: excused(start, Date.now()) });
    sweepUnmatched();
    await sleep(200 + a.rng.int(800));
  }
}

// ---------------------------------------------------------------------------
// Chaos
// ---------------------------------------------------------------------------

/** The rig's own bridge host: the pid bridge.json names, and only if it listens on the rig port. */
function rigHostPid(): number | null {
  const pid = rigBridge(rig).hostPid;
  return pid && bridgeHostPidsOnPort(rig.bridgePort).includes(pid) ? pid : null;
}

async function onWorker<T>(fn: (c: CdpClient, sessionId: string) => Promise<T>): Promise<T | null> {
  const c = await CdpClient.chrome(rig.cdpPort);
  try {
    const { targetInfos } = await c.send("Target.getTargets");
    const sw = (targetInfos as any[]).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${BRIDGE_EXTENSION_ID}/`));
    if (!sw) return null;
    const { sessionId } = await c.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    return await fn(c, sessionId);
  } finally {
    c.close();
  }
}

const frozen = new Set<number>();
async function fire(kind: Chaos): Promise<string> {
  switch (kind) {
    case "host-kill9": {
      const pid = rigHostPid();
      if (!pid) return "no rig host up to kill";
      process.kill(pid, "SIGKILL");
      return `killed host ${pid}`;
    }
    case "host-freeze": {
      const pid = rigHostPid();
      if (!pid) return "no rig host up to freeze";
      const ms = 5_000 + rng.int(10_000);
      frozen.add(pid);
      process.kill(pid, "SIGSTOP");
      try {
        await sleep(ms);
      } finally {
        process.kill(pid, "SIGCONT");
        frozen.delete(pid);
      }
      return `froze host ${pid} for ${ms}ms`;
    }
    case "sw-stop": {
      const c = await CdpClient.chrome(rig.cdpPort);
      try {
        const { targetInfos } = await c.send("Target.getTargets");
        const sw = (targetInfos as any[]).find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${BRIDGE_EXTENSION_ID}/`));
        if (!sw) return "no extension worker running";
        await c.send("Target.closeTarget", { targetId: sw.targetId });
        return `stopped worker ${sw.targetId.slice(0, 8)}`;
      } finally {
        c.close();
      }
    }
    case "debugger-detach": {
      const r = await onWorker(async (c, sessionId) => {
        const expr = `(async () => {
          const ts = (await chrome.debugger.getTargets()).filter((t) => t.attached && t.tabId && /[?&]run=${RUN}/.test(t.url));
          if (!ts.length) return "no soak tab attached";
          const t = ts[${rng.int(1000)} % ts.length];
          await chrome.debugger.detach({ tabId: t.tabId }).catch((e) => String(e));
          return "detached tab " + t.tabId + " " + t.url;
        })()`;
        const res = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        return String(res.result?.value ?? res.exceptionDetails?.text);
      });
      return r ?? "no extension worker running";
    }
    case "chrome-restart": {
      chromeRestartedAt = Date.now();
      const r = await run("bun", [RIG_SCRIPT, "restart-chrome", "--name", rig.name], { deadlineMs: 300_000 });
      chromeRestartedAt = lastChromeRestart = Date.now();
      return r.code === 0 ? oneLine(r.stdout, 160) : `restart failed: ${oneLine(r.stderr || r.stdout, 300)}`;
    }
  }
}

/** The probe session completes open + snapshot; how long that took to work again. */
async function recover(since: number): Promise<number | null> {
  const probe: Agent = { session: `probe-${RUN}`, rng: rng.fork(999), n: 0, tab: null };
  while (Date.now() - since < RECOVERY_BOUND_MS) {
    const r = await cli(rig, probe.session, ["open", pageUrl(probe.session, ++probe.n)], DEADLINE_MS, driverEnv);
    if (r.hung) violation("hang", `probe open ran past its ${DEADLINE_MS / 1000}s deadline`);
    if (r.code === 0) {
      const s = await cli(rig, probe.session, ["snapshot", "-i"], DEADLINE_MS, driverEnv);
      if (s.code === 0 && checkView(probe.session, probe.n, s.stdout, "recovery probe")) return Date.now() - since;
    }
    await sleep(1_000);
  }
  return null;
}

async function chaosLoop(until: number): Promise<void> {
  if (!CHAOS.length) return;
  while (Date.now() < until) {
    await sleep(CHAOS_EVERY_MS * (0.7 + rng.next() * 0.6));
    if (Date.now() >= until) return;
    const kind = rng.pick(CHAOS);
    const w = { kind, start: Date.now(), end: null as number | null };
    windows.push(w);
    console.log(`chaos: ${kind}…`);
    let detail: string;
    try {
      detail = await fire(kind);
    } catch (err) {
      detail = `could not fire: ${(err as Error).message}`;
    }
    const fired = Date.now();
    const took = await recover(fired);
    w.end = Date.now();
    log.write("chaos.jsonl", { kind, detail, recoveredMs: took });
    console.log(`chaos: ${kind}: ${detail}; ${took === null ? "NOT recovered" : `recovered in ${(took / 1000).toFixed(1)}s`}`);
    if (took === null) violation("no-recovery", `after ${kind} (${detail}) the probe could not open and snapshot within ${RECOVERY_BOUND_MS / 1000}s`);
  }
}

// ---------------------------------------------------------------------------
// End of run
// ---------------------------------------------------------------------------

async function chromePages(): Promise<Array<{ id: string; url: string }>> {
  const list = (await (await fetch(`http://127.0.0.1:${rig.cdpPort}/json/list`, { signal: AbortSignal.timeout(10_000) })).json()) as any[];
  return list.filter((t) => t.type === "page").map((t) => ({ id: t.id, url: t.url }));
}

function rigProcesses(): Array<{ pid: number; cmd: string }> {
  const out = Bun.spawnSync(["ps", "-Ao", "pid=,command="]).stdout.toString();
  return out.split("\n").map((l) => /^\s*(\d+) (.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), cmd: m[2] }))
    .filter((p) => p.cmd.includes(rig.dir) && !p.cmd.includes("--user-data-dir=") && !p.cmd.includes("serve-fixtures") && p.pid !== process.pid);
}

async function finish(agents: Agent[]): Promise<void> {
  console.log("soak: closing every session's tab and checking for leaks…");
  for (const a of agents.concat([{ session: `probe-${RUN}`, rng, n: 0, tab: null }])) {
    if (LEGACY) {
      for (let i = 0; i < 3; i++) if ((await cli(rig, a.session, ["close"], DEADLINE_MS, driverEnv)).code !== 0) break;
    } else await cli(rig, a.session, ["stop"], DEADLINE_MS, driverEnv);
  }
  await sleep(2_000);
  sweepUnmatched(true);
  const left = (await chromePages()).filter((p) => p.url.includes(`run=${RUN}`));
  for (const p of left) {
    const opened = openedAt.get(p.url) ?? 0;
    if (opened && opened < lastChromeRestart) {
      restoredByChrome++;
      log.write("violations.jsonl", { kind: "restored-by-chrome", detail: `${p.url} came back with Chrome's session restore; the extension no longer counts it as an agent tab` });
    } else violation("leak", `tab ${p.id.slice(0, 8)} still open at ${p.url} after its session closed its tab`);
    // The rig's own Chrome: close it so the next run starts clean.
    await fetch(`http://127.0.0.1:${rig.cdpPort}/json/close/${p.id}`).catch(() => {});
  }
  const hosts = bridgeHostPidsOnPort(rig.bridgePort);
  if (hosts.length > 1) violation("leak", `${hosts.length} bridge hosts listen on the rig port: ${hosts.join(", ")}`);
  if (!hosts.length) violation("host-crash", "no bridge host listens on the rig port at the end");
  for (const pid of hosts) if (procState(pid) === "T") violation("leak", `bridge host ${pid} is still stopped`);
  for (const pid of liveChildren) if (alive(pid)) violation("leak", `command process ${pid} outlived its run`);
  const procs = rigProcesses().filter((p) => !hosts.includes(p.pid));
  if (procs.length > baselineProcs + SESSIONS + 1) {
    violation("leak", `${procs.length} rig processes besides Chrome and the host (started with ${baselineProcs}): ${procs.map((p) => `${p.pid} ${oneLine(p.cmd, 80)}`).join("; ")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const baselineProcs = rigProcesses().filter((p) => !bridgeHostPidsOnPort(rig.bridgePort).includes(p.pid)).length;
process.on("exit", () => {
  for (const pid of frozen) try { process.kill(pid, "SIGCONT"); } catch {}
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const started = Date.now();
const until = started + MINUTES * 60_000;
const agents: Agent[] = Array.from({ length: SESSIONS }, (_, i) => ({ session: `soak${i}-${RUN}`, rng: rng.fork(i), n: 0, tab: null }));
await Promise.all([...agents.map((a) => agentLoop(a, until)), chaosLoop(until)]);
await finish(agents);
server.stop(true);

const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0);
const unexcused = stats.failed - stats.excusedFailures;
const summary = [
  `# cast browser soak, seed ${SEED}`,
  "",
  `rig ${rig.name} · ${SESSIONS} sessions · ${((Date.now() - started) / 60_000).toFixed(1)} min · load at start ${load.toFixed(0)}`,
  "",
  `| | |`,
  `|---|---|`,
  `| iterations | ${stats.iterations} (${stats.iterationsOk} ok) |`,
  `| commands | ${stats.commands}: ${stats.ok} ok, ${stats.failed} failed (${stats.excusedFailures} inside a chaos window, ${unexcused} outside) |`,
  `| chaos events | ${windows.length}: ${windows.map((w) => w.kind).join(", ") || "none"} |`,
  `| beacons | ${beacons.length} |`,
  `| tabs Chrome restored after a restart | ${restoredByChrome} (closed; not counted as leaks) |`,
  `| violations | ${violations.length} |`,
  "",
  "| verb | n | p50 ms | p95 ms |",
  "|---|---|---|---|",
  ...Object.entries(latency).map(([v, xs]) => `| ${v} | ${xs.length} | ${pct(xs, 0.5)} | ${pct(xs, 0.95)} |`),
  "",
  ...(violations.length ? ["## Violations", "", ...violations.map((v) => `- **${v.kind}** ${v.detail}`)] : ["No invariant was violated."]),
  "",
];
const file = log.text("summary.md", summary.join("\n"));
console.log(summary.join("\n"));
console.log(`soak: ${file}`);
process.exit(violations.length ? 1 : 0);

function findInstalledEngine(): string | null {
  const link = path.join(os.userInfo().homedir, ".codecast/browser/engine/node_modules/.bin/agent-browser");
  try {
    return fs.realpathSync(link);
  } catch {
    return null;
  }
}
