import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { configureDaemonWorkers, closeDaemonWorkers, scanWorkerHost } from "../bridge.js";
import { acquireSessionProcessOwnership, ensureSessionFileIndex, resetSessionFileIndexForTests, orphanReaperForTests, hibernationConcurrencyForTests, trackSessionPaneForTests } from "../../daemon.js";

const run = promisify(execFile);
const [mode, pane] = process.argv.slice(2);
const enabled = mode === "true", root = process.env.HOME!, conv = "orphan-fixture-conversation";
const main = path.resolve(import.meta.dir, "../../main.ts");
configureDaemonWorkers(enabled, { invocation: { command: process.execPath, args: [main, "_worker", "probe"] } }, { invocation: { command: process.execPath, args: [main, "_worker", "scan"] } });
const { io, reapOrphanedAgent: reap } = orphanReaperForTests;
const originalIo = { ...io };
const owned: Array<{ pid: number; ids: string[] }> = [];
const write = (file: string, value: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const waitUntil = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 3000;
  while (!await check()) { assert.ok(Date.now() < deadline, "fixture transition timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
};
const ps = async (pid: number) => (await run("ps", ["-ww", "-p", String(pid), "-o", "ppid=,command="], { timeout: 2000 })).stdout.trim();
let restore = () => {}, release = () => {}, signals: number[] = [], workerPid: number | null = null;
io.conversationId = () => conv;
io.signal = pid => { signals.push(pid); };
write(path.join(root, ".codecast/session-registry/.keep"), "");
fs.mkdirSync(path.join(root, ".codex/sessions"), { recursive: true });

async function fixture() {
  const id = crypto.randomUUID(), replacement = crypto.randomUUID(), base = path.join(root, id);
  const marker = base + ".switch", fifo = base + ".fifo", pidFile = base + ".pid", script = base + ".sh";
  await run("mkfifo", [fifo]);
  write(base + ".ts", "setInterval(() => {}, 1000);\n");
  write(script, `#!/bin/bash\nexec 3<> '${fifo}'\nprintf '%s' "$$" > '${pidFile}'\nwhile [ ! -e '${marker}' ]; do read -r -t .02 -u 3 line; done\nexec '${process.execPath}' '${base}.ts' --session-id ${replacement}\n`);
  for (const sid of [id, replacement]) write(path.join(root, ".claude/projects/p", sid + ".jsonl"), "{}\n");
  await run(process.execPath, ["-e", `const p=Bun.spawn(['/bin/bash',${JSON.stringify(script)},'--session-id',${JSON.stringify(id)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'});p.unref();`]);
  await waitUntil(async () => fs.existsSync(pidFile));
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  owned.push({ pid, ids: [id, replacement] }); write(path.join(root, "owned.json"), JSON.stringify(owned));
  await waitUntil(async () => (await ps(pid)).startsWith("1 "));
  trackSessionPaneForTests(id, pane, { status: "idle" });
  resetSessionFileIndexForTests(); await ensureSessionFileIndex();
  assert.equal(await acquireSessionProcessOwnership(id), "owned");
  return { id, pid, replacement, switch: async () => { write(marker, "go"); await waitUntil(async () => (await ps(pid)).includes(replacement)); } };
}

async function holdScan() {
  let arrived!: () => void, held = false;
  const entered = new Promise<void>(resolve => { arrived = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (enabled) {
    const host = scanWorkerHost()!, request = host.request.bind(host);
    host.request = async (...args: Parameters<typeof host.request>) => {
      const result = await request(...args), job = (args[1] as any)?.job;
      if (!held && job?.name === "walk" && job.root === path.join(root, ".codex/sessions")) { held = true; workerPid = host.state.pid; arrived(); await gate; }
      return result;
    };
    restore = () => { host.request = request; };
  } else {
    const readdir = fs.promises.readdir;
    fs.promises.readdir = (async (...args: any[]) => {
      const result = await (readdir as any)(...args);
      if (!held && String(args[0]) === path.join(root, ".codex/sessions")) { held = true; arrived(); await gate; }
      return result;
    }) as typeof readdir;
    restore = () => { fs.promises.readdir = readdir; };
  }
  return entered;
}

const refusals: string[] = [];
let stable = 0, execAfterScan = 0, execAfterDescendants = 0, actualOwnedSignal = false;
try {
  const a = await fixture();
  await reap(a.id, a.pid, pane); assert.deepEqual(signals, [a.pid]); stable = signals.length; signals = [];
  for (const kind of ["cancel", "resume", "delivery", "switch", "command", "cache"] as const) {
    const waiting = holdScan();
    const controller = new AbortController();
    const pending = reap(a.id, a.pid, pane, controller.signal);
    await waiting;
    let moved: Promise<unknown> | undefined;
    if (kind === "cancel") controller.abort();
    if (kind === "resume") {
      hibernationConcurrencyForTests.setResumeInner(async () => false);
      moved = hibernationConcurrencyForTests.autoResumeSession(a.id, "", {}, undefined, undefined, "claude", { userInitiated: true });
    }
    if (kind === "delivery") moved = orphanReaperForTests.withTmuxLock(pane, async () => {});
    if (kind === "switch") orphanReaperForTests.pendingAgentSwitches.set(conv, "fixture-switch");
    if (kind === "command") orphanReaperForTests.processedCommandIds.add("fixture-new-command");
    if (kind === "cache") trackSessionPaneForTests(a.id, pane + "-moved");
    release(); await pending; await moved; await new Promise(resolve => setImmediate(resolve)); restore(); restore = () => {};
    assert.deepEqual(signals, [], kind); refusals.push(kind);
    orphanReaperForTests.pendingAgentSwitches.delete(conv);
    orphanReaperForTests.processedCommandIds.delete("fixture-new-command");
    trackSessionPaneForTests(a.id, pane, { status: "idle" });
  }
  for (const kind of ["pane", "claims", "start", "uid", "descendants"] as const) {
    let reads = 0;
    if (kind === "pane") io.panes = async () => ({ ...await originalIo.panes(), stdout: String(a.pid) });
    if (kind === "claims") write(path.join(root, ".codecast/session-registry", a.replacement + ".json"), JSON.stringify({ pid: a.pid, ts: Date.now() / 1000, term: "fixture" }));
    if (kind === "start" || kind === "uid") io.identity = async (...args) => {
      const identity = await originalIo.identity(...args);
      if (++reads > 1 && identity) return { ...identity, ...(kind === "start" ? { start: identity.start + " changed" } : { uid: identity.uid! + 1 }) };
      return identity;
    };
    if (kind === "descendants") io.processes = async () => [...await originalIo.processes(), { pid: 2147483647, ppid: a.pid, uid: process.getuid?.(), command: "fixture descendant observation" }];
    await reap(a.id, a.pid, pane); assert.deepEqual(signals, [], kind); refusals.push(kind);
    io.identity = originalIo.identity; io.panes = originalIo.panes; io.processes = originalIo.processes;
    fs.rmSync(path.join(root, ".codecast/session-registry", a.replacement + ".json"), { force: true });
  }
  const waiting = holdScan(), pending = reap(a.id, a.pid, pane);
  await waiting; await a.switch(); release(); await pending; restore(); restore = () => {};
  assert.deepEqual(signals, [], "exec during real ownership scan"); execAfterScan = signals.length;
  const b = await fixture();
  io.processes = async () => { const rows = await originalIo.processes(); await b.switch(); return rows; };
  await reap(b.id, b.pid, pane); assert.deepEqual(signals, [], "exec after descendant collection"); execAfterDescendants = signals.length;
  io.processes = originalIo.processes;
  const c = await fixture();
  io.signal = pid => { assert.equal(pid, c.pid); originalIo.signal(pid); actualOwnedSignal = true; };
  await reap(c.id, c.pid, pane); assert.equal(actualOwnedSignal, true);
  await waitUntil(async () => { try { process.kill(c.pid, 0); return false; } catch { return true; } });
} finally {
  release(); restore(); Object.assign(io, originalIo); hibernationConcurrencyForTests.setResumeInner(null);
  closeDaemonWorkers();
  for (const item of owned) {
    const identity = await ps(item.pid).catch(() => "");
    if (item.ids.some(id => identity.includes(id))) { try { process.kill(item.pid, "SIGKILL"); } catch {} }
    await waitUntil(async () => { try { process.kill(item.pid, 0); return false; } catch { return true; } });
    trackSessionPaneForTests(item.ids[0], null);
  }
}
assert.equal(hibernationConcurrencyForTests.hibernationInFlight.size, 0);
assert.equal(hibernationConcurrencyForTests.tmuxTargetLocks.size, 0);
console.log(JSON.stringify({ enabled, stable, execAfterScan, execAfterDescendants, refusals, actualOwnedSignal, cleaned: true, workerPid }));
process.exit(0);
