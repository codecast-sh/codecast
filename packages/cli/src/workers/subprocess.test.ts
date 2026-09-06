import { afterEach, expect, test } from "bun:test";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkerHost } from "./host.js";
import { configureDaemonWorkers, closeDaemonWorkers } from "./bridge.js";
import { workerEnv, killWorkerGroup } from "./invocation.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { execFileAsync } from "../proc.js";
import { tmuxRunAsync, parseCodecastPaneRows, pickPaneForSession } from "../tmux.js";
const main = path.resolve(import.meta.dir, "../main.ts");
const fixture = path.join(import.meta.dir, "fixtures/parent.ts");
const hosts: WorkerHost[] = [];
const dirs: string[] = [];
const pids: number[] = [];
const invocation = (kind = "probe") => ({ command: process.execPath, args: [main, "_worker", kind] });
const host = () => { const h = new WorkerHost("probe", { invocation: invocation() }); hosts.push(h); return h; };
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "f1-worker-")); dirs.push(d); return d; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!fn()) { if (Date.now() > deadline) throw new Error("condition timed out"); await delay(30); }
}
afterEach(async () => {
  closeDaemonWorkers(); hosts.splice(0).forEach(h => h.close());
  pids.splice(0).forEach(killWorkerGroup);
  dirs.splice(0).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
});
function slowPs(dir: string) {
  fs.writeFileSync(path.join(dir, "ps"), '#!/bin/sh\nprintf "%s" "$$" > "'+dir+'/job.pid"\nsleep 60 &\nprintf "%s" "$!" > "'+dir+'/grandchild.pid"\nwait\n', { mode: 0o755 });
}
const read = (h: WorkerHost, options = {}) => h.request("read", { operation: "ps", args: ["aux"], options }, { timeoutMs: 10000 });
test("actual source entry roundtrip works for all worker kinds without config/CLI boot", async () => {
  const dir = temp();
  for (const kind of ["probe", "scan", "ingest"] as const) {
    const h = new WorkerHost(kind, { invocation: invocation(kind), env: { ...process.env, CODECAST_CONFIG_DIR: dir } }); hosts.push(h);
    expect(await h.request("ping", null)).toBe("pong");
    expect(h.state.pid).toBeGreaterThan(1); h.close();
  }
  expect(fs.readdirSync(dir)).toEqual([]);
});
test("production async wrapper routes probes on, keeps exact process IDs, and switches off with no child", async () => {
  const h = configureDaemonWorkers(true, { invocation: invocation() })!;
  const result = await execFileAsync("ps", ["-p", String(process.pid), "-o", "command="], { encoding: "utf-8", timeout: 5000 });
  expect(result.stdout).toContain("bun"); expect(h.state.pid).toBeGreaterThan(1);
  const pid = h.state.pid!;
  configureDaemonWorkers(false); await until(() => !alive(pid));
  expect((await execFileAsync("ps", ["-p", String(process.pid), "-o", "command="], { timeout: 5000 })).stdout).toContain("bun");
  expect(h.state.closed).toBe(true);
});
test("worker EOF kills its active read and subprocess descendants", async () => {
  const dir = temp(); slowPs(dir);
  const h = host(); const pending = read(h, { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  const settled = Promise.allSettled([pending]);
  await until(() => fs.existsSync(path.join(dir, "grandchild.pid")));
  const worker = h.state.pid!;
  const job = Number(fs.readFileSync(path.join(dir, "job.pid"), "utf8"));
  const grandchild = Number(fs.readFileSync(path.join(dir, "grandchild.pid"), "utf8"));
  (h as any).child.stdin.end();
  expect((await settled)[0].status).toBe("rejected");
  await until(() => !alive(worker) && !alive(job) && !alive(grandchild));
});
test("parent SIGKILL reaps worker and its entire process group without detached=false assumptions", async () => {
  const dir = temp(); slowPs(dir);
  const child = spawn(process.execPath, [fixture, main, `${dir}:${process.env.PATH}`], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODECAST_WORKER: undefined } });
  pids.push(child.pid!);
  let output = ""; child.stdout.on("data", b => { output += b; });
  await until(() => output.includes("\n") && fs.existsSync(path.join(dir, "grandchild.pid")));
  const worker = JSON.parse(output.trim()).workerPid; pids.push(worker);
  const job = Number(fs.readFileSync(path.join(dir, "job.pid"), "utf8"));
  const grandchild = Number(fs.readFileSync(path.join(dir, "grandchild.pid"), "utf8"));
  process.kill(child.pid!, "SIGKILL");
  await until(() => !alive(child.pid!) && !alive(worker) && !alive(job) && !alive(grandchild));
});
test("deadline kills slow child descendants; no late result survives", async () => {
  const dir = temp(); slowPs(dir); const h = host();
  const p = h.request("read", { operation: "ps", args: ["aux"], options: { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } } }, { timeoutMs: 1000 });
  const settled = Promise.allSettled([p]);
  await until(() => fs.existsSync(path.join(dir, "grandchild.pid")));
  const worker = h.state.pid!;
  const job = Number(fs.readFileSync(path.join(dir, "job.pid"), "utf8"));
  const grandchild = Number(fs.readFileSync(path.join(dir, "grandchild.pid"), "utf8"));
  expect((await settled)[0].status).toBe("rejected");
  await until(() => !alive(worker) && !alive(job) && !alive(grandchild)); expect(h.state.pending).toBe(0);
});
test("killing worker mid-request allows async fallback and replacement after backoff", async () => {
  const dir = temp(); slowPs(dir);
  const h = configureDaemonWorkers(true, { invocation: invocation(), backoffMs: [20, 30, 40] })!;
  const p = execFileAsync("ps", ["aux"], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, timeout: 5000 });
  const settled = Promise.allSettled([p]);
  await until(() => fs.existsSync(path.join(dir, "job.pid")));
  fs.writeFileSync(path.join(dir, "ps"), '#!/bin/sh\nprintf "fallback\\n"\n', { mode: 0o755 });
  process.kill(h.state.pid!, "SIGKILL");
  expect((await settled)[0]).toMatchObject({ status: "fulfilled", value: { stdout: "fallback\n" } });
  await delay(40); expect(await h.request("ping", null)).toBe("pong");
});
test("read-only tmux listing/capture matches direct async path on an isolated socket; full-ID collision stays exact", async () => {
  const socket = `f1-probe-${process.pid}-${Date.now()}`;
  const tmux = (a: string[]) => execFileSync("tmux", ["-L", socket, ...a], { encoding: "utf8", timeout: 3000 });
  const names = ["cast-term-collision-a", "cast-term-collision-b"];
  try {
    for (let i = 0; i < 2; i++) { tmux(["new-session", "-d", "-s", names[i], "sh", "-c", "printf 'probe fixture\\n'; exec sleep 60"]); tmux(["set-option", "-t", names[i], "@codecast_session_id", `sameprefix-${i}-full`]); }
    const args = ["-L", socket, "list-sessions", "-F", "#{@codecast_session_id}|#{session_created}|#{session_name}"];
    const direct = await tmuxRunAsync(args);
    const h = configureDaemonWorkers(true, { invocation: invocation() })!;
    const routed = await tmuxRunAsync(args); expect(routed).toEqual(direct); expect(h.state.pid).toBeGreaterThan(1);
    const panes = parseCodecastPaneRows(routed.stdout);
    expect(pickPaneForSession(panes, "sameprefix-1-full", "collision-b")).toBe(names[1]);
    expect(pickPaneForSession(panes, "sameprefix-X-full", "collision-b")).toBeNull();
    const capture = ["-L", socket, "capture-pane", "-p", "-t", names[0]];
    await delay(100);
    const workerCapture = await tmuxRunAsync(capture); configureDaemonWorkers(false);
    expect(workerCapture).toEqual(await tmuxRunAsync(capture)); expect(workerCapture.stdout).toContain("probe fixture");
    configureDaemonWorkers(true, { invocation: invocation() });
    const missing = await tmuxRunAsync(["-L", socket, "has-session", "-t", "does-not-exist"]);
    expect(missing.status).toBe(1); expect(missing.stderr).toContain("find");
  } finally { tmux(["kill-server"]); }
});
test("raw invalid frames terminate worker predictably and recursive CLI entry is refused", async () => {
  const child = spawn(process.execPath, [main, "_worker", "probe"], { env: workerEnv(process.env), detached: true, stdio: ["pipe", "pipe", "pipe"] }); pids.push(child.pid!);
  const frames: unknown[] = []; const decoder = new FrameDecoder(); let diagnostics = "";
  child.stdout.on("data", b => frames.push(...decoder.push(b))); child.stderr.on("data", b => { diagnostics += b; });
  const exited = new Promise(resolve => child.on("exit", resolve));
  child.stdin.write(JSON.stringify({ v: 1, kind: "probe", type: "request", id: "bad", operation: "read", payload: { operation: "tmux", args: ["list-sessions", ";", "kill-server"], options: {} }, deadline: Date.now() + 5000 }) + "\n");
  await exited; expect(diagnostics).toContain("protocol rejected"); expect(frames.every((f: any) => f.type === "heartbeat")).toBe(true);
  const dir = temp();
  const recursion = spawn(process.execPath, [main, "_daemon"], { env: { ...workerEnv(process.env), CODECAST_CONFIG_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
  const code = await new Promise(resolve => recursion.on("exit", resolve)); expect(code).toBe(64); expect(fs.readdirSync(dir)).toEqual([]);
});

test("synthetic keychain output transits only the result; failed reads redact output and keep exit status", async () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "security"), '#!/bin/sh\nprintf "synthetic-private-value"\nprintf "synthetic-diagnostic" >&2\nexit 7\n', { mode: 0o755 });
  const h = host();
  const result: any = await h.request("read", { operation: "keychain", args: ["find-generic-password", "-s", "f1-fixture", "-w"], options: { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } } });
  expect(result).toMatchObject({ status: 7, stdout: "", stderr: "", signal: null });
  fs.writeFileSync(path.join(dir, "security"), '#!/bin/sh\nprintf "synthetic-private-value"\n', { mode: 0o755 });
  const success: any = await h.request("read", { operation: "keychain", args: ["find-generic-password", "-s", "f1-fixture", "-w"], options: { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } } });
  expect(success).toMatchObject({ status: 0, stdout: "synthetic-private-value", stderr: "" });
});
