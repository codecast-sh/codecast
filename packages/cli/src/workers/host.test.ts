import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { WorkerHost } from "./host.js";
import { encodeFrame, MAX_INFLIGHT, MAX_QUEUE } from "./protocol.js";
import { configureDaemonWorkers, closeDaemonWorkers, routeProbe } from "./bridge.js";
const hosts: WorkerHost[] = [];
afterEach(() => { hosts.splice(0).forEach(h => h.close()); closeDaemonWorkers(); });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
function harness(backoff = [10, 20, 30]) {
  const children: any[] = [];
  let kills = 0;
  const options = {
    invocation: { command: "owned-fixture", args: [] }, backoffMs: backoff,
    spawnChild() {
      const child = Object.assign(new EventEmitter(), { pid: 900000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
      children.push(child); return child as unknown as ChildProcess;
    },
    killChild() { kills++; },
  };
  const host = new WorkerHost("probe", options); hosts.push(host);
  return { host, children, options, kills: () => kills };
}
const ping = (host: WorkerHost, timeoutMs = 1000) => host.request("ping", null, { timeoutMs });
function reply(child: any) {
  const requests = child.stdin.read()?.toString().trim().split("\n").map(JSON.parse) ?? [];
  requests.forEach((f: any) => child.stdout.write(encodeFrame({ v: 1, kind: "probe", type: "result", id: f.id, operation: "ping", result: "pong" })));
}
test("crash settles inflight and queued work; backoff excludes dead generation then third crash disables kind", async () => {
  const h = harness();
  const all = Promise.allSettled(Array.from({ length: 8 }, () => ping(h.host)));
  h.children[0].emit("exit", 1);
  expect((await all).every(r => r.status === "rejected")).toBe(true);
  expect(h.kills()).toBe(1); expect(h.host.state.pending).toBe(0);
  await expect(ping(h.host)).rejects.toThrow("unavailable");
  await tick(15);
  const next = ping(h.host); reply(h.children[1]); expect(await next).toBe("pong");
  h.children[0].emit("exit", 1); expect(h.host.state.pid).toBe(h.children[1].pid);
  h.children[1].emit("exit", 1); await tick(25);
  const third = ping(h.host); h.children[2].emit("exit", 1); await expect(third).rejects.toThrow();
  expect(h.host.state.disabled).toBe(true); await tick(35); await expect(ping(h.host)).rejects.toThrow("unavailable");
});
test("queue and inflight caps are enforced, timeout and close settle every caller", async () => {
  const h = harness();
  const pending = Array.from({ length: MAX_INFLIGHT + MAX_QUEUE }, () => ping(h.host, 40));
  const outcomes = Promise.allSettled(pending);
  expect(h.children[0].stdin.read().toString().trim().split("\n")).toHaveLength(MAX_INFLIGHT);
  await expect(ping(h.host)).rejects.toThrow("queue full");
  expect((await outcomes).every(r => r.status === "rejected")).toBe(true); expect(h.host.state.pending).toBe(0); expect(h.kills()).toBe(1);
  const next = harness(); const p = ping(next.host); next.host.close(); await expect(p).rejects.toThrow("closed"); expect(next.kills()).toBe(1);
});
test("cancel kills only the owned child, stale result cannot settle a replacement", async () => {
  const h = harness(); const controller = new AbortController();
  const p = h.host.request("ping", null, { signal: controller.signal });
  controller.abort(); await expect(p).rejects.toThrow("cancelled"); expect(h.kills()).toBe(1);
  await tick(15); const n = ping(h.host); reply(h.children[0]); reply(h.children[1]); expect(await n).toBe("pong");
});
test("malformed result, excessive diagnostics and wrong worker identity fail closed", async () => {
  for (const emit of [(c: any) => c.stdout.write('{"v":1}\n'), (c: any) => c.stderr.write(Buffer.alloc(9000)), (c: any) => c.stdout.write(encodeFrame({ v: 1, kind: "scan", type: "heartbeat", pid: c.pid }))]) {
    const h = harness(); const p = ping(h.host); emit(h.children[0]); await expect(p).rejects.toThrow(); expect(h.kills()).toBe(1);
  }
});
test("off switch runs existing async fallback with no child; crash fallback is only for validated reads", async () => {
  const h = harness(); let fallbacks = 0;
  const fallback = async () => { fallbacks++; return { stdout: "fallback", stderr: "" }; };
  configureDaemonWorkers(false, h.options);
  expect(await routeProbe("ps", ["aux"], {}, fallback)).toEqual({ stdout: "fallback", stderr: "" }); expect(h.children).toHaveLength(0);
  configureDaemonWorkers(true, h.options);
  const p = routeProbe("ps", ["aux"], { timeout: 1000 }, fallback); h.children[0].emit("exit", 1);
  expect(await p).toEqual({ stdout: "fallback", stderr: "" }); expect(fallbacks).toBe(2);
  await routeProbe("tmux", ["send-keys", "-t", "x", "Enter"], {}, fallback);
  expect(h.children).toHaveLength(1);
});
test("shutdown does not launch fallback work after the worker is closed", async () => {
  const h = harness(); configureDaemonWorkers(true, h.options); let called = false;
  const p = routeProbe("ps", ["aux"], { timeout: 1000 }, async () => { called = true; return {}; });
  closeDaemonWorkers(); await expect(p).rejects.toThrow("closed"); expect(called).toBe(false);
});

test("worker heartbeat cannot keep an expired request alive and missing heartbeats retire an idle worker", async () => {
  const h = harness(); const p = ping(h.host, 60);
  h.children[0].stdout.write(encodeFrame({ v: 1, kind: "probe", type: "heartbeat", pid: h.children[0].pid }));
  await expect(p).rejects.toThrow("deadline");
  const idle = new WorkerHost("probe", { ...h.options, heartbeatTimeoutMs: 10 }); hosts.push(idle);
  const ready = ping(idle); reply(h.children[1]); expect(await ready).toBe("pong");
  await tick(1100); expect(idle.state.pid).toBeNull(); expect(idle.state.pending).toBe(0);
});

test("suspend callback order never records sleep as a crash or accepts a pre-sleep read", async () => {
  const h = harness(); let wall = Date.now(); let mono = 100;
  const clock = { wall: () => wall, mono: () => mono };
  const runtime = new WorkerHost("probe", { ...h.options, clock }); hosts.push(runtime);
  for (let i = 0; i < 4; i++) {
    const p = ping(runtime);
    wall += 120000; mono += 1;
    if (i % 2) h.children[i].emit("exit", 1);
    else reply(h.children[i]);
    await expect(p).rejects.toThrow();
    expect(runtime.state.disabled).toBe(false); expect(runtime.state.retryAt).toBe(0);
    mono += 1001; wall += 1001;
  }
  const fresh = ping(runtime); reply(h.children[4]); expect(await fresh).toBe("pong");
});
