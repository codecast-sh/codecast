import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { isProcessRunning, readPidFile, releasePidFileIfOwned, tryAcquirePidFileLock } from "../pidFileLock.js";
import { LONGEST_ADAPTER_TIMEOUT_MS, HERDR_PROMPT_TIMEOUT_MS, PASEO_SEND_TIMEOUT_MS } from "./targets.js";
import { DEFAULT_INTERVALS, authHash, isAuthError, relayChildEnv, relayPaths, relaySpawnOptions, runRelayCommand, type RelayConfig, type RelayConvexClient, type RelayRuntimeDeps } from "./relayCommand.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const CONFIG: RelayConfig = { auth_token: "tok", convex_url: "https://x" };

function harness(over: Partial<RelayRuntimeDeps> = {}, clientOver: Partial<RelayConvexClient> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  dirs.push(dir);
  const pidFile = path.join(dir, "relay.pid");
  const authFile = path.join(dir, "relay.auth");
  const logs: string[] = [];
  const mutations: Array<{ name: string; args: any }> = [];
  const subs: Array<{ name: string; args: any; onResult: (v: any) => void; onError: (e: Error) => void; unsubscribed: boolean }> = [];
  const state = { closed: 0, spawned: 0, signalled: 0, signal: () => {}, config: CONFIG as RelayConfig | null, running: false, drainGate: null as Promise<void> | null };
  const client: RelayConvexClient = {
    mutation: async (name, args) => { mutations.push({ name, args }); return { success: true }; },
    query: async () => [],
    onUpdate: (name, args, onResult, onError) => {
      const sub = { name, args, onResult, onError, unsubscribed: false };
      subs.push(sub);
      return () => { sub.unsubscribed = true; };
    },
    close: () => { state.closed++; },
    ...clientOver,
  };
  const deps: RelayRuntimeDeps = {
    config: CONFIG,
    readConfig: () => state.config,
    deviceId: "dev",
    isRunning: () => state.running || (() => { const pid = readPidFile(pidFile); return !!pid && isProcessRunning(pid); })(),
    acquire: () => tryAcquirePidFileLock(pidFile, process.pid),
    release: () => void releasePidFileIfOwned(pidFile, process.pid),
    spawnBackground: () => { state.spawned++; },
    runningAuthHash: () => { try { return fs.readFileSync(authFile, "utf-8").trim() || null; } catch { return null; } },
    writeAuthHash: (h) => fs.writeFileSync(authFile, `${h}\n`, { mode: 0o600 }),
    clearAuthHash: () => fs.rmSync(authFile, { force: true }),
    signalRunning: () => { state.signalled++; },
    sleep: async () => {},
    makeClient: () => client,
    adapter: { deliver: async () => ({ kind: "ok" }), probe: async () => ({ kind: "alive" }), identify: async () => undefined },
    log: (l) => logs.push(l),
    onSignal: (h) => { state.signal = h; },
    intervals: { heartbeat: 10_000, retry: 10_000, sweep: 10_000, resubscribeMin: 5, resubscribeMax: 20, replaceWait: 300, drain: 2_000 },
    ...over,
  };
  return { deps, pidFile, authFile, logs, mutations, subs, state, client };
}

describe("relay lock", () => {
  test("a second relay exits 0 saying it is already running, and leaves the first's lock", async () => {
    const a = harness();
    const first = runRelayCommand({}, a.deps);
    await pollUntil(() => fs.existsSync(a.pidFile), "first relay lock");

    const b = harness({ acquire: () => tryAcquirePidFileLock(a.pidFile, process.pid + 1, { isProcessRunning: () => true }) });
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

  test("relay.pid, relay.auth and relay.log live in the config dir", () => {
    expect(relayPaths("/c")).toEqual({ pidFile: "/c/relay.pid", logFile: "/c/relay.log", authFile: "/c/relay.auth" });
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

  test("does not spawn when a relay with the same credentials already runs", async () => {
    const h = harness();
    h.state.running = true;
    h.deps.writeAuthHash(authHash(CONFIG));
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.spawned).toBe(0);
    expect(h.state.signalled).toBe(0);
    expect(h.logs.join("\n")).toContain("already running");
  });

  test("a running relay whose recorded hash is missing is left alone", async () => {
    const h = harness();
    h.state.running = true;
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.signalled).toBe(0);
    expect(h.state.spawned).toBe(0);
  });

  test("a running relay with other credentials is signalled, waited for, then replaced", async () => {
    const h = harness();
    h.state.running = true;
    h.deps.writeAuthHash(authHash({ auth_token: "old", convex_url: "https://x" }));
    h.deps.signalRunning = () => { h.state.signalled++; h.state.running = false; };
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.signalled).toBe(1);
    expect(h.state.spawned).toBe(1);
  });

  test("the wait for the old relay is bounded, and a relay that will not stop is left running", async () => {
    const h = harness();
    h.state.running = true;
    h.deps.writeAuthHash(authHash({ auth_token: "old", convex_url: "https://x" }));
    expect(await runRelayCommand({ background: true }, h.deps)).toBe(0);
    expect(h.state.signalled).toBe(1);
    expect(h.state.spawned).toBe(0);
    expect(h.logs.join("\n")).toContain("did not stop in time");
  });

  test("the hash is of the credentials and the file never holds the token", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => fs.existsSync(h.authFile), "auth hash file");
    const body = fs.readFileSync(h.authFile, "utf-8");
    expect(body.trim()).toBe(authHash(CONFIG));
    expect(body).not.toContain("tok");
    expect(fs.statSync(h.authFile).mode & 0o777).toBe(0o600);
    expect(authHash({ auth_token: "other", convex_url: "https://x" })).not.toBe(authHash(CONFIG));
    expect(authHash({ auth_token: "tok", convex_url: "https://y" })).not.toBe(authHash(CONFIG));
    h.state.signal();
    await done;
    expect(fs.existsSync(h.authFile)).toBe(false);
  });

  test("the child's env drops PASEO_AGENT_ID, HERDR_* and the Claude markers and keeps PASEO_CLI, PASEO_HOME and the rest", () => {
    const env = relayChildEnv({
      PASEO_AGENT_ID: "a", PASEO_HOME: "/p", PASEO_CLI: "/opt/paseo", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/s", HERDR_ENV: "1",
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", PATH: "/bin", HOME: "/h",
    });
    expect(env).toEqual({ PASEO_HOME: "/p", PASEO_CLI: "/opt/paseo", PATH: "/bin", HOME: "/h" });
  });

  test("the detached child starts in the home directory, not the hook's cwd", () => {
    const opts = relaySpawnOptions(7, { PASEO_AGENT_ID: "a", PATH: "/bin" });
    expect(opts).toEqual({ detached: true, stdio: ["ignore", 7, 7], env: { PATH: "/bin" }, cwd: os.homedir() });
  });
});

describe("shutdown and replacement waits outlast the slowest send", () => {
  test("drain is longer than every adapter timeout, and the replacement wait is longer than the drain", () => {
    expect(LONGEST_ADAPTER_TIMEOUT_MS).toBeGreaterThanOrEqual(Math.max(HERDR_PROMPT_TIMEOUT_MS, PASEO_SEND_TIMEOUT_MS));
    expect(DEFAULT_INTERVALS.drain).toBeGreaterThan(LONGEST_ADAPTER_TIMEOUT_MS);
    expect(DEFAULT_INTERVALS.replaceWait).toBeGreaterThan(DEFAULT_INTERVALS.drain);
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
    expect(h.subs[0].unsubscribed).toBe(true);
    expect(h.state.closed).toBe(1);
    expect(fs.existsSync(h.pidFile)).toBe(false);
  });

  test("rows pushed by the subscription are delivered and acked", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.subs[0].onResult([{ _id: "m1", content: "hello", session_id: "s", delivery_target: { kind: "paseo", agent_id: "a" } }]);
    await pollUntil(() => h.mutations.some((m) => m.name === "pendingMessages:updateMessageStatus"), "the ack");
    h.state.signal();
    await done;
  });

  test("stopping waits for a hand-off in flight and its ack", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const h = harness({ adapter: { deliver: async () => { await gate; return { kind: "ok" }; }, probe: async () => ({ kind: "alive" }), identify: async () => undefined } });
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.subs[0].onResult([{ _id: "m1", content: "hello", session_id: "s", delivery_target: { kind: "paseo", agent_id: "a" } }]);
    h.state.signal();
    let finished = false;
    void done.then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(finished).toBe(false);
    release();
    expect(await done).toBe(0);
    expect(h.mutations.some((m) => m.name === "pendingMessages:updateMessageStatus" && m.args.status === "delivered")).toBe(true);
    expect(h.state.closed).toBe(1);
  });

  test("not logged in exits non-zero without taking the lock", async () => {
    const h = harness({ config: null });
    expect(await runRelayCommand({}, h.deps)).toBe(1);
    expect(fs.existsSync(h.pidFile)).toBe(false);
  });
});

describe("subscription errors", () => {
  test("an authentication error exits non-zero, logs it and releases the lock", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.subs[0].onError(new Error("Authentication failed: invalid token or session"));
    expect(await done).toBe(1);
    expect(h.logs.join("\n")).toContain("Authentication failed");
    expect(fs.existsSync(h.pidFile)).toBe(false);
    expect(h.state.closed).toBe(1);
    expect(h.subs).toHaveLength(1);
  });

  test("any other error resubscribes with a growing, capped backoff and keeps the relay alive", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length === 1, "subscription");
    h.subs[0].onError(new Error("Could not find public function for 'pendingMessages:pendingForDevice'"));
    await pollUntil(() => h.subs.length === 2, "first resubscribe");
    expect(h.subs[0].unsubscribed).toBe(true);
    h.subs[1].onError(new Error("overloaded"));
    await pollUntil(() => h.subs.length === 3, "second resubscribe");
    expect(h.logs.filter((l) => l.includes("resubscribing in")).map((l) => l.match(/in (\d+)ms/)![1])).toEqual(["5", "10"]);
    h.subs[2].onError(new Error("overloaded"));
    await pollUntil(() => h.subs.length === 4, "third");
    h.subs[3].onError(new Error("overloaded"));
    await pollUntil(() => h.subs.length === 5, "fourth");
    expect(h.logs.filter((l) => l.includes("resubscribing in")).map((l) => l.match(/in (\d+)ms/)![1])).toEqual(["5", "10", "20", "20"]);
    expect(fs.existsSync(h.pidFile)).toBe(true);
    h.state.signal();
    expect(await done).toBe(0);
  });

  test("a good result resets the backoff, and a relay that resubscribed still delivers", async () => {
    const h = harness();
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length === 1, "subscription");
    h.subs[0].onError(new Error("overloaded"));
    await pollUntil(() => h.subs.length === 2, "resubscribe");
    h.subs[1].onResult([]);
    h.subs[1].onError(new Error("overloaded"));
    await pollUntil(() => h.subs.length === 3, "resubscribe again");
    expect(h.logs.filter((l) => l.includes("resubscribing in")).map((l) => l.match(/in (\d+)ms/)![1])).toEqual(["5", "5"]);
    h.subs[2].onResult([{ _id: "m1", content: "x", session_id: "s", delivery_target: { kind: "paseo", agent_id: "a" } }]);
    await pollUntil(() => h.mutations.some((m) => m.name === "pendingMessages:updateMessageStatus"), "ack");
    h.state.signal();
    await done;
  });

  test("a stop during the backoff cancels the resubscribe", async () => {
    const h = harness({ intervals: { heartbeat: 10_000, retry: 10_000, sweep: 10_000, resubscribeMin: 200, resubscribeMax: 400, replaceWait: 100, drain: 1_000 } });
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length === 1, "subscription");
    h.subs[0].onError(new Error("overloaded"));
    h.state.signal();
    await done;
    await new Promise((r) => setTimeout(r, 300));
    expect(h.subs).toHaveLength(1);
  });

  test("a synchronous throw from onUpdate is handled like an error", async () => {
    let n = 0;
    const h = harness({}, { onUpdate: () => { if (n++ === 0) throw new Error("socket not ready"); return () => {}; } });
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => n >= 2, "second attempt");
    h.state.signal();
    expect(await done).toBe(0);
  });

  test("what counts as an authentication error", () => {
    expect(isAuthError(new Error("Authentication failed: invalid token or session"))).toBe(true);
    expect(isAuthError(new Error("Unauthorized"))).toBe(true);
    expect(isAuthError(new Error("Could not find public function"))).toBe(false);
    expect(isAuthError(new Error("overloaded"))).toBe(false);
  });
});

describe("credentials changing under a running relay", () => {
  const fast = { heartbeat: 20, retry: 10_000, sweep: 10_000, resubscribeMin: 5, resubscribeMax: 20, replaceWait: 100, drain: 1_000 };

  test("a new token on a heartbeat tick stops the relay with exit 0 and frees the lock", async () => {
    const h = harness({ intervals: fast });
    const done = runRelayCommand({}, h.deps);
    await pollUntil(() => h.subs.length > 0, "subscription");
    h.state.config = { auth_token: "other-account", convex_url: "https://x" };
    expect(await done).toBe(0);
    expect(h.logs.join("\n")).toContain("credentials changed");
    expect(fs.existsSync(h.pidFile)).toBe(false);
    expect(fs.existsSync(h.authFile)).toBe(false);
  });

  test("a new convex_url stops it too, and an unreadable config does not", async () => {
    const a = harness({ intervals: fast });
    const first = runRelayCommand({}, a.deps);
    await pollUntil(() => a.subs.length > 0, "subscription");
    a.state.config = { auth_token: "tok", convex_url: "https://elsewhere" };
    expect(await first).toBe(0);

    const b = harness({ intervals: fast });
    const second = runRelayCommand({}, b.deps);
    await pollUntil(() => b.subs.length > 0, "subscription");
    b.state.config = null;
    const beats = () => b.mutations.filter((m) => m.name === "registeredSessions:relayHeartbeat").length;
    await pollUntil(() => beats() >= 3, "heartbeats keep coming");
    b.state.signal();
    expect(await second).toBe(0);
    expect(b.logs.join("\n")).not.toContain("credentials changed");
  });
});
