import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { isProcessRunning, readPidFile, releasePidFileIfOwned, tryAcquirePidFileLock } from "../pidFileLock.js";
import { relayChildEnv, relayPaths, runRelayCommand, type RelayConvexClient, type RelayRuntimeDeps } from "./relayCommand.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function harness(over: Partial<RelayRuntimeDeps> = {}, clientOver: Partial<RelayConvexClient> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  dirs.push(dir);
  const pidFile = path.join(dir, "relay.pid");
  const logs: string[] = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const subs: Array<{ name: string; args: any; onResult: (v: any) => void; onError: (e: Error) => void }> = [];
  const state = { unsubscribed: 0, closed: 0, spawned: 0, signal: () => {} };
  const client: RelayConvexClient = {
    mutation: async (name, args) => { mutations.push({ name, args }); return { success: true }; },
    query: async () => [],
    onUpdate: (name, args, onResult, onError) => { subs.push({ name, args, onResult, onError }); return () => { state.unsubscribed++; }; },
    close: () => { state.closed++; },
    ...clientOver,
  };
  const deps: RelayRuntimeDeps = {
    config: { auth_token: "tok", convex_url: "https://x" },
    deviceId: "dev",
    pidFile,
    isRunning: () => { const pid = readPidFile(pidFile); return !!pid && isProcessRunning(pid); },
    acquire: () => tryAcquirePidFileLock(pidFile, process.pid),
    release: () => void releasePidFileIfOwned(pidFile, process.pid),
    spawnBackground: () => { state.spawned++; },
    makeClient: () => client,
    adapter: { deliver: async () => ({ kind: "ok" }), probe: async () => ({ kind: "alive" }) },
    log: (l) => logs.push(l),
    onSignal: (h) => { state.signal = h; },
    intervals: { heartbeat: 10_000, retry: 10_000, sweep: 10_000 },
    ...over,
  };
  return { deps, pidFile, logs, mutations, subs, state, client };
}


describe("relay lock", () => {
  test("a second relay exits 0 saying it is already running, and leaves the first's lock", async () => {
    const a = harness();
    const first = runRelayCommand({}, a.deps);
    await pollUntil(() => fs.existsSync(a.pidFile), "first relay lock");
    expect(fs.existsSync(a.pidFile)).toBe(true);

    const b = harness({ pidFile: a.pidFile, acquire: () => tryAcquirePidFileLock(a.pidFile, process.pid + 1, { isProcessRunning: () => true }) });
    expect(await runRelayCommand({}, b.deps)).toBe(0);
    expect(b.logs.join("\n")).toContain("already running");
    expect(b.subs).toEqual([]);
    expect(fs.existsSync(a.pidFile)).toBe(true);

    a.state.signal();
    expect(await first).toBe(0);
  });

  test("the lock is the pid file: a live holder refuses, a dead one is taken over", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-lock-"));
    dirs.push(dir);
    const pidFile = path.join(dir, "relay.pid");
    expect(tryAcquirePidFileLock(pidFile, 111, { isProcessRunning: () => true })).toBe(true);
    expect(tryAcquirePidFileLock(pidFile, 222, { isProcessRunning: () => true })).toBe(false);
    expect(tryAcquirePidFileLock(pidFile, 333, { isProcessRunning: () => false, staleGraceMs: 0, nowMs: Date.now() + 10 })).toBe(true);
    expect(readPidFile(pidFile)).toBe(333);
  });

  test("relay.pid lives in the config dir beside relay.log", () => {
    expect(relayPaths("/c")).toEqual({ pidFile: "/c/relay.pid", logFile: "/c/relay.log" });
  });
});

describe("--background", () => {
  test("spawns when no relay runs, and exits 0 without taking the lock", async () => {
    const h = harness();
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.spawned).toBe(1);
    expect(fs.existsSync(h.pidFile)).toBe(false);
    expect(h.subs).toEqual([]);
  });

  test("never fails a hook: not logged in or a failed spawn still exits 0 with one log line", async () => {
    const out = harness({ config: null });
    expect(await runRelayCommand({ background: true }, out.deps)).toBe(0);
    expect(out.logs).toHaveLength(1);
    const boom = harness({ spawnBackground: () => { throw new Error("spawn ENOENT\nstack"); } });
    expect(await runRelayCommand({ background: true }, boom.deps)).toBe(0);
    expect(boom.logs).toEqual(["could not start the relay: spawn ENOENT"]);
  });

  test("does not spawn when one already runs", async () => {
    const h = harness({ isRunning: () => true });
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.spawned).toBe(0);
    expect(h.logs.join("\n")).toContain("already running");
  });

  test("the child's env drops PASEO_AGENT_ID, HERDR_* and the Claude markers and keeps the rest", () => {
    const env = relayChildEnv({
      PASEO_AGENT_ID: "a", PASEO_HOME: "/p", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s", HERDR_ENV: "1",
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin", HOME: "/h",
    });
    expect(env).toEqual({ PASEO_HOME: "/p", PATH: "/bin", HOME: "/h" });
  });
});

describe("running relay", () => {
  test("subscribes to pendingForDevice, heartbeats at start, and stops cleanly on a signal", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0 && h.mutations.length > 0, "subscription and heartbeat");
    expect(h.subs[0].name).toBe("pendingMessages:pendingForDevice");
    expect(h.subs[0].args).toEqual({ api_token: "tok", device_id: "dev" });
    expect(h.mutations.map((m) => m.name)).toContain("registeredSessions:relayHeartbeat");
    expect(h.logs.join("\n")).toContain("relay started");
    h.state.signal();
    expect(await done).toBe(0);
    expect(h.state.unsubscribed).toBe(1);
    expect(h.state.closed).toBe(1);
    expect(fs.existsSync(h.pidFile)).toBe(false);
  });

  test("rows pushed by the subscription are delivered and acked", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.subs[0].onResult([{ _id: "m1", content: "hello", session_id: "s", delivery_target: { kind: "paseo", agent_id: "a" } }]);
    await pollUntil(() => h.mutations.some((m) => m.name === "pendingMessages:updateMessageStatus"), "the ack");
    expect(h.mutations.find((m) => m.name === "pendingMessages:updateMessageStatus")!.args).toMatchObject({ message_id: "m1", status: "delivered" });
    h.state.signal();
    await done;
  });

  test("an authentication or query error from the subscription exits non-zero, logs it and releases the lock", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.subs[0].onError(new Error("Authentication failed: invalid token or session"));
    expect(await done).toBe(1);
    expect(h.logs.join("\n")).toContain("Authentication failed");
    expect(fs.existsSync(h.pidFile)).toBe(false);
    expect(h.state.closed).toBe(1);
  });

  test("not logged in exits non-zero without taking the lock", async () => {
    const h = harness({ config: null });
    expect(await runRelayCommand({}, h.deps)).toBe(1);
    expect(fs.existsSync(h.pidFile)).toBe(false);
  });
});
