/**
 * The laptop side of a cloud host's `cast browser sync`: the args contract,
 * the host resolution that never wakes a box, the carry's security order,
 * the daemon handler's serialization, and the words the host prints.
 * Everything here runs with injected deps — no ssh, no AWS, no Chrome.
 */

import { describe, expect, test } from "bun:test";
import {
  BROWSER_SYNC_CARRY_DEADLINE_MS,
  BROWSER_SYNC_CHILD_TIMEOUT_MS,
  browserSyncArgv,
  carryLoginsToHost,
  carrySummaryLine,
  cloudHostSignInHint,
  DATACENTER_IP_NOTE,
  explainSyncFailure,
  handleBrowserSyncCommand,
  noRegistryEntryReason,
  parseBrowserSyncArgs,
  pickLaptopProfile,
  resolveCarryHost,
  type CarryDeps,
  type CarryHostDeps,
  type CarryOutcome,
} from "./browserSync.js";
import { OWN_LOGIN_REASON } from "../browser/credentials.js";
import { AwsCliFailed, type CloudHost } from "../browser/cloudHost.js";
import type { RemoteHost } from "../remote/session-move.js";
import type { InstanceState } from "../browser/instance.js";

const daemonJson = JSON.stringify({ host_device_id: "box-device-id", cdp_port: 37121, origin: "https://github.com", all: false });

describe("parseBrowserSyncArgs — the daemon's JSON, validated like the mutation", () => {
  test("accepts the daemon's shape and passes conversation_id through", () => {
    expect(parseBrowserSyncArgs(daemonJson)).toEqual({ hostDeviceId: "box-device-id", cdpPort: 37121, origin: "https://github.com", all: false });
    expect(parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 1, origin: null, all: true, conversation_id: "conv" })))
      .toEqual({ hostDeviceId: "b", cdpPort: 1, origin: null, all: true, conversationId: "conv" });
  });
  test("refuses a missing host, a bad port, a non-http origin, origin+all and neither", () => {
    expect(() => parseBrowserSyncArgs(undefined)).toThrow("missing host_device_id");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", origin: "https://a.com" }))).toThrow("is not a port");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 1.5, origin: "https://a.com" }))).toThrow("is not a port");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 70000, origin: "https://a.com" }))).toThrow("is not a port");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 9, origin: "ftp://a.com" }))).toThrow("not an http(s) origin");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 9, origin: "https://a.com/path?token=x" }))).toThrow("not an http(s) origin");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 9, origin: "https://a.com", all: true }))).toThrow("exclusive");
    expect(() => parseBrowserSyncArgs(JSON.stringify({ host_device_id: "b", cdp_port: 9 }))).toThrow("name an origin or all");
    expect(() => parseBrowserSyncArgs("{not json")).toThrow("not JSON");
  });
  test("browserSyncArgv round-trips through the child's flags", () => {
    expect(browserSyncArgv(parseBrowserSyncArgs(daemonJson))).toEqual(["cloud", "browser-sync", "box-device-id", "--port", "37121", "--origin", "https://github.com"]);
    expect(browserSyncArgv({ hostDeviceId: "b", cdpPort: 1, origin: null, all: true, conversationId: "c" }))
      .toEqual(["cloud", "browser-sync", "b", "--port", "1", "--all", "--conversation", "c"]);
  });
});

describe("pickLaptopProfile — whose cookies are carried", () => {
  const profiles = [{ dir: "Profile 2", name: "work", email: null, lastUsed: false }, { dir: "Profile 7", name: "me", email: null, lastUsed: true }];
  test("prefers the managed browser's source profile and channel", () => {
    const state = { sourceProfile: "Profile 2", channel: "canary" } as unknown as InstanceState;
    expect(pickLaptopProfile(state, profiles)).toEqual({ profileDir: "Profile 2", channel: "canary" });
  });
  test("a remote state (no sourceProfile) falls back to Chrome's last-used profile, then Default", () => {
    const remote = { sourceProfile: null, channel: "chrome", remote: { host: "h", user: "u" } } as unknown as InstanceState;
    expect(pickLaptopProfile(remote, profiles)).toEqual({ profileDir: "Profile 7", channel: "chrome" });
    expect(pickLaptopProfile(null, [])).toEqual({ profileDir: "Default", channel: "chrome" });
  });
});

const cloud: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.1.1.1", deviceId: "box-device-id" };
const remoteOf = (h: CloudHost): RemoteHost => ({ address: h.address!, user: h.user, keyPath: h.keyPath, remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" });

function hostDeps(over: Partial<CarryHostDeps> & { reachable?: (addr: string) => boolean } = {}) {
  const calls = { sshReachable: [] as string[], hostState: 0, patchHost: [] as Array<[string, Partial<CloudHost>]> };
  const deps: CarryHostDeps = {
    hostForDevice: over.hostForDevice ?? ((id) => (id === "box-device-id" ? cloud : undefined)),
    toRemoteHost: over.toRemoteHost ?? remoteOf,
    sshReachable: async (h) => { calls.sshReachable.push(h.address); return (over.reachable ?? (() => true))(h.address); },
    hostState: over.hostState ?? ((h) => { calls.hostState++; return { state: "running", address: h.address }; }),
    patchHost: (id, patch) => { calls.patchHost.push([id, patch]); return { ...cloud, ...patch }; },
  };
  return { deps, calls };
}

describe("resolveCarryHost — the registry, then AWS state, never a wake", () => {
  test("no registry entry: refused with the --via hint, before any probe", async () => {
    const { deps, calls } = hostDeps();
    const r = await resolveCarryHost("unknown-device", deps);
    expect(r).toEqual({ ok: false, reason: noRegistryEntryReason("unknown-device") });
    expect((r as any).reason).toContain("--via");
    expect(calls.sshReachable).toEqual([]);
  });
  test("browserSync:false in the registry is refused before ssh", async () => {
    const { deps, calls } = hostDeps({ hostForDevice: () => ({ ...cloud, browserSync: false }) });
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("browserSync: false");
    expect(calls.sshReachable).toEqual([]);
  });
  test("a reachable host returns the registry address without asking AWS", async () => {
    const { deps, calls } = hostDeps();
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r).toEqual({ ok: true, host: remoteOf(cloud), cloud });
    expect(calls.hostState).toBe(0);
    expect(calls.patchHost).toEqual([]);
  });
  test("unreachable + running at a NEW address: patchHost records it and the new address is probed", async () => {
    const { deps, calls } = hostDeps({ reachable: (a) => a === "2.2.2.2", hostState: () => ({ state: "running", address: "2.2.2.2" }) });
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r).toEqual({ ok: true, host: { ...remoteOf(cloud), address: "2.2.2.2" }, cloud: { ...cloud, address: "2.2.2.2" } });
    expect(calls.sshReachable).toEqual(["1.1.1.1", "2.2.2.2"]);
    expect(calls.patchHost).toEqual([["i-1", { address: "2.2.2.2" }]]);
  });
  test("unreachable + stopped: refused, nothing patched, and there is no wake dep at all", async () => {
    const { deps, calls } = hostDeps({ reachable: () => false, hostState: () => ({ state: "stopped" }) });
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r).toEqual({ ok: false, reason: "host i-1 is stopped — nothing was carried (a sleeping host is never woken for cookies)" });
    expect(calls.patchHost).toEqual([]);
    expect(Object.keys(deps).sort()).toEqual(["hostForDevice", "hostState", "patchHost", "sshReachable", "toRemoteHost"]);
  });
  test("unreachable + the aws CLI failing names the CLI", async () => {
    const { deps } = hostDeps({ reachable: () => false, hostState: () => { throw new AwsCliFailed("the aws CLI is not installed"); } });
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r.ok).toBe(false);
    expect((r as any).reason).toContain("aws CLI could not check its state: the aws CLI is not installed");
  });
  test("unreachable + running at the SAME address is a plain unreachable", async () => {
    const { deps, calls } = hostDeps({ reachable: () => false });
    const r = await resolveCarryHost("box-device-id", deps);
    expect(r).toEqual({ ok: false, reason: "host i-1 is running but not reachable at 1.1.1.1 — nothing was carried" });
    expect(calls.patchHost).toEqual([]);
  });
});

function carryDeps(over: Partial<CarryDeps> & { policy?: any } = {}) {
  const calls = { resolve: [] as string[], tunnel: [] as number[], provision: [] as any[] };
  const deps: CarryDeps = {
    resolveCarryHost: async (id) => { calls.resolve.push(id); return { ok: true, host: remoteOf(cloud), cloud }; },
    withCdpTunnel: async (_h, port, fn) => { calls.tunnel.push(port); return fn(45678); },
    provisionLocalLogins: async (port, url, source) => { calls.provision.push([port, url, source]); return { injected: 3, host: "github.com" }; },
    loadMachinePolicy: () => over.policy ?? null,
    readState: () => ({ sourceProfile: "Profile 2", channel: "chrome" } as unknown as InstanceState),
    listRealProfiles: () => [],
    ...over,
  };
  return { deps, calls };
}
const args = { hostDeviceId: "box-device-id", cdpPort: 37121, origin: "https://github.com", all: false };

describe("carryLoginsToHost — the security order, then the tunnel", () => {
  test("a Google origin returns OWN_LOGIN_REASON before the host is even resolved", async () => {
    const { deps, calls } = carryDeps();
    expect(await carryLoginsToHost({ ...args, origin: "https://mail.google.com" }, deps)).toEqual({ ok: true, injected: 0, host: "mail.google.com", reason: OWN_LOGIN_REASON });
    expect(calls.resolve).toEqual([]);
  });
  test("a machine allowlist refuses the whole jar and an origin outside it, before any ssh", async () => {
    const policy = { sources: [{ file: "/l/config.json", key: "browser_allow", patterns: ["github.com"] }], errors: [] };
    const all = carryDeps({ policy });
    expect(await carryLoginsToHost({ ...args, origin: null, all: true }, all.deps)).toEqual({ ok: false, reason: expect.stringContaining("name the site") });
    const outside = carryDeps({ policy });
    const r = await carryLoginsToHost({ ...args, origin: "https://gitlab.com" }, outside.deps);
    expect(r).toEqual({ ok: false, reason: "this laptop refuses to carry its login: https://gitlab.com is not in the site allowlist" });
    expect(all.calls.resolve).toEqual([]);
    expect(outside.calls.resolve).toEqual([]);
    const inside = carryDeps({ policy });
    expect((await carryLoginsToHost(args, inside.deps)).ok).toBe(true);
  });
  test("happy path: the host's cdp port goes to the tunnel, the tunnel's local port and the picked profile to provisionLocalLogins, the result through untouched", async () => {
    const { deps, calls } = carryDeps({ provisionLocalLogins: async () => ({ injected: 2, host: "github.com", rejected: 1 }) });
    expect(await carryLoginsToHost(args, deps)).toEqual({ ok: true, injected: 2, host: "github.com", rejected: 1 });
    expect(calls.resolve).toEqual(["box-device-id"]);
    expect(calls.tunnel).toEqual([37121]);
  });
  test("the picked profile is the laptop's source profile; a whole-jar carry passes url null", async () => {
    const { deps, calls } = carryDeps();
    await carryLoginsToHost({ ...args, origin: null, all: true }, deps);
    expect(calls.provision).toEqual([[45678, null, { profileDir: "Profile 2", channel: "chrome" }]]);
  });
  test("a refused host resolution is passed through; a tunnel failure becomes a reason", async () => {
    const refused = carryDeps({ resolveCarryHost: async () => ({ ok: false, reason: "host i-1 is stopped" }) });
    expect(await carryLoginsToHost(args, refused.deps)).toEqual({ ok: false, reason: "host i-1 is stopped" });
    expect(refused.calls.tunnel).toEqual([]);
    const dead = carryDeps({ withCdpTunnel: async () => { throw new Error("the host's Chrome on port 37121 never answered through the tunnel"); } });
    expect(await carryLoginsToHost(args, dead.deps)).toEqual({ ok: false, reason: "the host's Chrome on port 37121 never answered through the tunnel" });
  });
});

describe("carrySummaryLine — counts only", () => {
  test("keeps only the allowed keys, never a cookie", () => {
    const leaky = { ok: true, injected: 2, host: "github.com", rejected: 1, sites: 1, reason: undefined, cookies: [{ name: "user_session", value: "SECRET" }] } as unknown as CarryOutcome;
    const line = carrySummaryLine(leaky);
    expect(JSON.parse(line)).toEqual({ ok: true, injected: 2, sites: 1, rejected: 1, host: "github.com" });
    expect(line).not.toContain("user_session");
    expect(line).not.toContain("SECRET");
    expect(carrySummaryLine({ ok: false, reason: "why" })).toBe('{"ok":false,"reason":"why"}');
    expect(JSON.parse(carrySummaryLine({ ok: true, injected: 0, host: "x", reason: "already has the same cookies" }))).toEqual({ ok: true, injected: 0, host: "x", reason: "already has the same cookies" });
  });
});

describe("handleBrowserSyncCommand — the daemon's case", () => {
  function harness(child: (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>, remote = false) {
    const runs: string[][] = [];
    const logs: string[] = [];
    const inFlight = new Map<string, Promise<unknown>>();
    const deps = {
      isRemoteDevice: () => remote,
      runCastCommand: async (a: string[]) => { runs.push(a); return child(a); },
      log: (m: string) => { logs.push(m); },
      childErrorDetail: (stderr: string, stdout = "") => (stderr || stdout).trim().split("\n")[0] ?? "",
      inFlight,
    };
    return { deps, runs, logs, inFlight };
  }
  test("a remote device reports an error without spawning", async () => {
    const h = harness(async () => ({ code: 0, stdout: "{}", stderr: "" }), true);
    expect(await handleBrowserSyncCommand(daemonJson, h.deps)).toEqual({ error: "cloud_browser_sync: a cloud host holds no logins to carry" });
    expect(h.runs).toEqual([]);
  });
  test("bad args are an error without spawning", async () => {
    const h = harness(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    expect(await handleBrowserSyncCommand("{}", h.deps)).toEqual({ error: "cloud_browser_sync: missing host_device_id" });
    expect(h.runs).toEqual([]);
  });
  test("a code-0 child's last JSON line is the result; the log names the origin and counts only", async () => {
    const h = harness(async () => ({ code: 0, stdout: "noise\n{\"ok\":true,\"injected\":3,\"host\":\"github.com\"}\n", stderr: "" }));
    expect(await handleBrowserSyncCommand(daemonJson, h.deps)).toEqual({ result: '{"ok":true,"injected":3,"host":"github.com"}' });
    expect(h.runs).toEqual([["cloud", "browser-sync", "box-device-id", "--port", "37121", "--origin", "https://github.com"]]);
    expect(h.logs[0]).toBe("[BROWSER-SYNC] carrying https://github.com to device box-devi:37121 (async child)");
    expect(h.inFlight.size).toBe(0);
  });
  test("a child that prints {ok:false,reason} reports that reason as the error; a bare failure gets the exit code + stderr", async () => {
    const refused = harness(async () => ({ code: 1, stdout: '{"ok":false,"reason":"host i-1 is stopped — nothing was carried"}\n', stderr: "" }));
    expect(await handleBrowserSyncCommand(daemonJson, refused.deps)).toEqual({ error: "host i-1 is stopped — nothing was carried" });
    const crashed = harness(async () => ({ code: 2, stdout: "", stderr: "TypeError: boom\n  at x" }));
    expect(await handleBrowserSyncCommand(daemonJson, crashed.deps)).toEqual({ error: "login carry failed (exit 2): TypeError: boom" });
  });
  test("any number of commands for the same host serialize, one child at a time; different hosts run concurrently", async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = new Promise<void>((r) => { release = r; });
    let running = 0;
    let peak = 0;
    const h = harness(async (a) => {
      running++;
      peak = Math.max(peak, running);
      order.push(`start ${a[2]}`);
      if (a[2] === "box-device-id" && order.filter((o) => o === "start box-device-id").length === 1) await first;
      order.push(`end ${a[2]}`);
      running--;
      return { code: 0, stdout: '{"ok":true,"injected":0,"host":"github.com"}', stderr: "" };
    });
    const p1 = handleBrowserSyncCommand(daemonJson, h.deps);
    await Promise.resolve();
    // Two more parked on the same host: they must NOT wake together when p1 ends.
    const p2 = handleBrowserSyncCommand(daemonJson, h.deps);
    const p4 = handleBrowserSyncCommand(daemonJson, h.deps);
    const other = JSON.stringify({ host_device_id: "other-box", cdp_port: 1, origin: "https://a.com", all: false });
    const p3 = handleBrowserSyncCommand(other, h.deps);
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["start box-device-id", "start other-box", "end other-box"]);
    release();
    await Promise.all([p1, p2, p3, p4]);
    expect(order).toEqual([
      "start box-device-id", "start other-box", "end other-box", "end box-device-id",
      "start box-device-id", "end box-device-id", "start box-device-id", "end box-device-id",
    ]);
    expect(h.inFlight.size).toBe(0);
    const boxRuns = order.filter((o) => o.includes("box-device-id"));
    for (let i = 0; i < boxRuns.length; i += 2) expect([boxRuns[i], boxRuns[i + 1]]).toEqual(["start box-device-id", "end box-device-id"]);
    expect(peak).toBe(2); // one box carry + the other host, never two box carries
  });
  test("the child cap is three minutes, the child's own carry deadline is shorter, and the cap kills the child's process group", async () => {
    expect(BROWSER_SYNC_CHILD_TIMEOUT_MS).toBe(180_000);
    expect(BROWSER_SYNC_CARRY_DEADLINE_MS).toBeLessThan(BROWSER_SYNC_CHILD_TIMEOUT_MS);
    expect(BROWSER_SYNC_CHILD_TIMEOUT_MS - BROWSER_SYNC_CARRY_DEADLINE_MS).toBeGreaterThanOrEqual(10_000);
    const opts: unknown[] = [];
    const deps = {
      isRemoteDevice: () => false,
      runCastCommand: async (_a: string[], o: unknown) => { opts.push(o); return { code: 0, stdout: "{}", stderr: "" }; },
      log: () => {},
      childErrorDetail: () => "",
      inFlight: new Map<string, Promise<unknown>>(),
    };
    await handleBrowserSyncCommand(daemonJson, deps);
    expect(opts).toEqual([{ timeoutMs: BROWSER_SYNC_CHILD_TIMEOUT_MS, killGroup: true }]);
  });
});

describe("the words the host prints", () => {
  test("explainSyncFailure maps each outcome to an actionable line", () => {
    expect(explainSyncFailure("expired_ttl").message).toContain("never picked the request up within 5 minutes");
    expect(explainSyncFailure("Unknown command: cloud_browser_sync").message).toContain("older than this host's");
    const reg = explainSyncFailure(noRegistryEntryReason("box-device-id"));
    expect(reg.message).toContain("no entry for device box-devi");
    expect(reg.hint).toContain("--via");
    expect(explainSyncFailure("could not read the Chrome key from the login Keychain").hint).toContain("Always Allow");
    expect(explainSyncFailure("host i-1 is stopped — nothing was carried")).toEqual({ message: "host i-1 is stopped — nothing was carried" });
    expect(explainSyncFailure("cookie carries into host i-1 are disabled in ~/.codecast/browser/hosts.json (browserSync: false)").message).toContain("browserSync: false");
  });
  test("cloudHostSignInHint names the sync command, Google, the missing account and the datacenter note — never the laptop's advice", () => {
    const note = cloudHostSignInHint("https://github.com/login?return_to=x")!;
    expect(note).toContain("`cast browser sync github.com`");
    expect(note).toContain("Google");
    expect(note).toContain("no Google account");
    expect(note).toContain(DATACENTER_IP_NOTE);
    for (const banned of ["cast browser login", "extension", "signs it in from your account"]) expect(note).not.toContain(banned);
    expect(cloudHostSignInHint("https://github.com/settings/profile")).toBeNull();
  });
});
