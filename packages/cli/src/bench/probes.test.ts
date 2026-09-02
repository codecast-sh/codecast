import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { readLoopbackIdentity, localAuthHeaders, runLoopLagProbe, runLatencyProbe } from "./probes.js";

describe("readLoopbackIdentity", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-identity-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("no hook-port means no port", () => {
    expect(readLoopbackIdentity(dir)).toEqual({ port: null, token: null, reason: "hook-port missing" });
  });

  test("missing identity file", () => {
    fs.writeFileSync(path.join(dir, "hook-port"), "40123\n");
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: null, reason: "missing" });
  });

  test("port mismatch marks the token stale", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 1, token: "t", pid: process.pid }));
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: null, reason: "port mismatch" });
  });

  test("dead pid marks the token stale", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 40123, token: "t", pid: 2 ** 22 - 1 }));
    expect(readLoopbackIdentity(dir).reason).toBe("pid not alive");
  });

  test("matching port and live pid yields the token", () => {
    fs.writeFileSync(path.join(dir, "loopback-identity.json"), JSON.stringify({ port: 40123, token: "secret", pid: process.pid }));
    expect(readLoopbackIdentity(dir)).toEqual({ port: 40123, token: "secret", reason: null });
  });
});

test("localAuthHeaders is the loopback origin plus the bearer token", () => {
  expect(localAuthHeaders(5, "abc")).toEqual({ Origin: "http://127.0.0.1:5", Authorization: "Bearer abc" });
});

// The stalling server runs in a child process: a busy loop inside the test
// process would freeze the probe's own timers along with the server.
const SERVER_SOURCE = `
const http = require("node:http");
let stalled = false;
const server = http.createServer((req, res) => {
  if (!stalled) { stalled = true; const until = Date.now() + 1200; while (Date.now() < until) {} }
  setTimeout(() => { res.writeHead(req.url === "/health" ? 200 : 400); res.end("ok"); }, 30);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
`;

describe("probes against a slow local server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-probe-"));
  let child: ChildProcess;
  let port = 0;

  beforeAll(async () => {
    const script = path.join(dir, "server.cjs");
    fs.writeFileSync(script, SERVER_SOURCE);
    child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "inherit"] });
    port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      child.stdout!.on("data", (d) => {
        buf += String(d);
        const m = /^(\d+)\n/.exec(buf);
        if (m) resolve(Number(m[1]));
      });
      child.once("exit", (code) => reject(new Error(`server exited ${code}`)));
      setTimeout(() => reject(new Error("server never printed its port")), 15_000);
    });
  }, 20_000);
  afterAll(() => {
    child?.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("loop lag probe reports the stall as samples over 1s", async () => {
    const r = await runLoopLagProbe({ port, durationMs: 1500, intervalMs: 100 });
    expect(r.summary.n).toBeGreaterThan(5);
    expect(r.summary.p50!).toBeGreaterThanOrEqual(30);
    // The requests queued behind the stall also finish late, so the count is
    // at least one and never more than the ticks that fit inside the stall.
    expect(r.summary.over1s).toBeGreaterThanOrEqual(1);
    expect(r.summary.over1s).toBeLessThanOrEqual(4);
    expect(r.summary.max!).toBeGreaterThanOrEqual(1200);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(0);
  }, 10_000);

  test("latency probe records statuses", async () => {
    const r = await runLatencyProbe({ url: `http://127.0.0.1:${port}/hook/status`, durationMs: 700, intervalMs: 200 });
    expect(r.summary.n).toBeGreaterThanOrEqual(3);
    expect(r.statuses["400"]).toBe(r.summary.n);
  }, 10_000);
});
