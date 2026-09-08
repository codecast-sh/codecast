import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sshBase, type RemoteHost } from "../../remote/session-move";
import { mirrorForPrepare } from "../prepare";
import { MIRROR_MAGIC, buildMirrorBundle, parseMirrorBundle, type BuiltBundle } from "./bundle";
import {
  MIRROR_APPLY_COMMAND, NOT_LOGGED_IN_REASON, OLDER_HOST_REASON, hostKey, mirrorHomeToHost, pushMirrorToHostAsync, readLocalStamps, runMirrorTick,
  writeLocalStamps, type LocalMirrorStamps, type MirrorDeps, type MirrorPushOutcome,
} from "./push";

let dir: string;
let savedEnv: NodeJS.ProcessEnv;
const host: RemoteHost = { address: "cloud-test.invalid", user: "ubuntu", keyPath: "/test key", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

function installFakeSsh(): void {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "ssh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const command = args.at(-1);
const wire = fs.readFileSync(0);
const input = require("node:zlib").gunzipSync(wire);
fs.writeFileSync(process.env.PUSH_TEST_ARGV, JSON.stringify(args));
fs.writeFileSync(process.env.PUSH_TEST_ARGV + ".pid", String(process.pid));
fs.writeFileSync(process.env.PUSH_TEST_STDIN, input);
if (process.env.PUSH_TEST_MODE === "decode") { const r=require("node:child_process").spawnSync("/bin/sh",["-c",command],{input:wire}); fs.writeSync(1,r.stdout); fs.writeSync(2,r.stderr); process.exit(r.status ?? 1); }
else if (process.env.PUSH_TEST_MODE === "hang") { setTimeout(() => {}, 600000); }
else if (process.env.PUSH_TEST_MODE === "refuse") { fs.writeSync(1, '{"hash":"h","applied":[],"unchanged":0,"host_edited":[],"pruned":[],"errors":[],"refused":"other_device"}\\n'); process.exit(3); }
else if (process.env.PUSH_TEST_MODE === "old") { fs.writeSync(2, "error: unknown command 'mirror-apply'\\n"); process.exit(1); }
else if (process.env.PUSH_TEST_MODE === "nocast") { fs.writeSync(2, "bash: line 1: cast: command not found\\n"); process.exit(127); }
else if (process.env.PUSH_TEST_MODE === "fail") { fs.writeSync(1, "SECRET_STDOUT"); fs.writeSync(2, "boom: SECRET_STDERR_LINE\\n"); process.exit(7); }
else { fs.writeSync(1, "install noise\\n" + JSON.stringify({ hash: process.env.PUSH_TEST_HASH || "h", applied: ["a"], unchanged: 1, host_edited: [], pruned: [], errors: [] }) + "\\n"); process.exit(0); }
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PUSH_TEST_ARGV = path.join(dir, "argv.json");
  process.env.PUSH_TEST_STDIN = path.join(dir, "stdin.bin");
}

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mirror-push-")));
  installFakeSsh();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

const bundle = Buffer.concat([Buffer.from(MIRROR_MAGIC), Buffer.from("payload-bytes-that-must-not-leak")]);

describe("pushMirrorToHostAsync", () => {
  test("runs ssh with sshBase args and the exact remote command, streams the bundle, parses the last JSON line", async () => {
    const r = await pushMirrorToHostAsync(host, bundle);
    expect(r.pushed).toBe(true);
    expect(r.result?.applied).toEqual(["a"]);
    const argv = JSON.parse(fs.readFileSync(process.env.PUSH_TEST_ARGV!, "utf-8"));
    expect(argv).toEqual([...sshBase(host), "ubuntu@cloud-test.invalid", `gzip -dc | ( ${MIRROR_APPLY_COMMAND} )`]);
    expect(MIRROR_APPLY_COMMAND).toBe('export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; cast cloud mirror-apply --stdin');
    expect(fs.readFileSync(process.env.PUSH_TEST_STDIN!).equals(bundle)).toBe(true);
  });

  test("exit 3 → the refused reason; unknown command → the older-host reason", async () => {
    process.env.PUSH_TEST_MODE = "refuse";
    expect(await pushMirrorToHostAsync(host, bundle)).toMatchObject({ pushed: false, reason: "other_device" });
    process.env.PUSH_TEST_MODE = "old";
    expect(await pushMirrorToHostAsync(host, bundle)).toMatchObject({ pushed: false, reason: OLDER_HOST_REASON });
    // No cast on the host's PATH at all (exit 127): the same cure, provisioning.
    process.env.PUSH_TEST_MODE = "nocast";
    expect(await pushMirrorToHostAsync(host, bundle)).toMatchObject({ pushed: false, reason: OLDER_HOST_REASON });
  });

  test("a transport failure throws without the bundle or the host's stdout; a hang is killed after the timeout", async () => {
    process.env.PUSH_TEST_MODE = "fail";
    let message = "";
    try { await pushMirrorToHostAsync(host, bundle); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/mirror push failed \(exit 7\)/);
    expect(message).not.toContain("SECRET_STDOUT");
    expect(message).not.toContain("payload-bytes");
    process.env.PUSH_TEST_MODE = "hang";
    await expect(pushMirrorToHostAsync(host, bundle, { timeoutMs: 300 })).rejects.toThrow("mirror push timed out");
  });
});

describe("local stamps", () => {
  test("round-trip through a 0600 file", () => {
    const file = path.join(dir, "browser", "mirror-pushes.json");
    expect(readLocalStamps(file)).toEqual({});
    writeLocalStamps({ "ubuntu@h": { hash: "abc", at: "t" } }, file);
    expect(readLocalStamps(file)).toEqual({ "ubuntu@h": { hash: "abc", at: "t" } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

function fakeBuild(hash: string): BuiltBundle {
  const built = buildMirrorBundle([{ path: ".claude/CLAUDE.md", kind: "claude-md", mode: "0600", bytes: Buffer.from(hash) }], {
    source: { device_id: "d", user_id: "u", home: "/Users/a", platform: "darwin", cast_version: "1" }, target_home: "/home/ubuntu", managed_roots: [".claude"],
  });
  return { ...built, hash };
}

describe("mirrorHomeToHost", () => {
  function deps(stamps: LocalMirrorStamps, pushes: string[], outcome: MirrorPushOutcome = { pushed: true, hash: "H1", result: { hash: "H1", applied: ["x", "y"], unchanged: 0, host_edited: [], pruned: [], errors: [] } }, stampReads: string[] = [], remoteHash: string | null = null): Partial<MirrorDeps> {
    return {
      build: async () => fakeBuild("H1"),
      readLocalStamps: () => stamps,
      writeLocalStamps: (s) => { Object.assign(stamps, s); },
      push: async (h) => { pushes.push(hostKey(h)); return outcome; },
      readStamp: async (h) => { stampReads.push(hostKey(h)); return remoteHash ? { version: 1, complete: true, hash: remoteHash, source_device_id: "d", source_user_id: "u", applied_at: "", files: {}, managed_roots: [] } : null; },
      readConfig: () => ({ user_id: "u" }),
      now: () => new Date("2026-09-06T00:00:00Z"),
    };
  }

  test("skips ssh when the local stamp holds the hash; pushes otherwise; force overrides; failures are recorded", async () => {
    const stamps: LocalMirrorStamps = { "ubuntu@cloud-test.invalid": { hash: "H1", at: "earlier" } };
    const pushes: string[] = [];
    const r = await mirrorHomeToHost(host, { onlyIfChanged: true, deps: deps(stamps, pushes) });
    expect(r).toMatchObject({ pushed: false, skipped: "in step", hash: "H1", changed: 0 });
    expect(pushes).toEqual([]);

    const forced = await mirrorHomeToHost(host, { force: true, deps: deps(stamps, pushes) });
    expect(forced).toMatchObject({ pushed: true, changed: 2 });
    expect(pushes).toEqual(["ubuntu@cloud-test.invalid"]);
    expect(stamps["ubuntu@cloud-test.invalid"]).toEqual({ hash: "H1", at: "2026-09-06T00:00:00.000Z" });

    const stale: LocalMirrorStamps = { "ubuntu@cloud-test.invalid": { hash: "OLD", at: "earlier" } };
    await mirrorHomeToHost(host, { deps: deps(stale, pushes) });
    expect(pushes).toHaveLength(2);

    const refusing: LocalMirrorStamps = {};
    const r2 = await mirrorHomeToHost(host, { deps: deps(refusing, pushes, { pushed: false, reason: "unprovisioned" }) });
    expect(r2).toMatchObject({ pushed: false, reason: "unprovisioned" });
    expect(refusing["ubuntu@cloud-test.invalid"]!.last_failure).toMatchObject({ reason: "unprovisioned", hash: "H1" });

    const throwing: LocalMirrorStamps = {};
    await expect(mirrorHomeToHost(host, { deps: { ...deps(throwing, pushes), push: async () => { throw new Error("ssh exploded"); } } })).rejects.toThrow("ssh exploded");
    expect(throwing["ubuntu@cloud-test.invalid"]!.last_failure?.reason).toBe("ssh exploded");
  });

  test("ownership refusal remains retryable on prepare and force", async () => {
    const pushes: string[] = [];
    const stamps: LocalMirrorStamps = {};
    const refusing = deps(stamps, pushes, { pushed: false, reason: "other_device" });
    await mirrorHomeToHost(host, { deps: refusing });
    expect(pushes).toHaveLength(1);
    const again = await mirrorHomeToHost(host, { onlyIfChanged: true, deps: refusing });
    expect(again).toMatchObject({ pushed: false, reason: "other_device", skipped: "refused earlier" });
    expect(pushes).toHaveLength(1);
    await mirrorHomeToHost(host, { force: true, deps: refusing });
    expect(pushes).toHaveLength(2);
    const changed = { ...refusing, build: async () => fakeBuild("H2") };
    await mirrorHomeToHost(host, { deps: changed });
    expect(pushes).toHaveLength(3);
    // A transport failure is not a refusal: the next prepare retries it.
    const flaky: LocalMirrorStamps = { "ubuntu@cloud-test.invalid": { hash: "", at: "t", last_failure: { reason: "ssh exploded", at: "t", hash: "H1" } } };
    await mirrorHomeToHost(host, { deps: deps(flaky, pushes) });
    expect(pushes).toHaveLength(4);
  });

  test("no local memory of the host (a new address after a wake): the host's own stamp is read first, and an in-step host costs no upload", async () => {
    const pushes: string[] = [];
    const reads: string[] = [];
    const stamps: LocalMirrorStamps = {};
    const r = await mirrorHomeToHost(host, { deps: deps(stamps, pushes, undefined, reads, "H1") });
    expect(r).toMatchObject({ pushed: false, skipped: "in step", hash: "H1" });
    expect(reads).toEqual(["ubuntu@cloud-test.invalid"]);
    expect(pushes).toEqual([]);
    expect(stamps["ubuntu@cloud-test.invalid"]).toMatchObject({ hash: "H1" });
    // A host with a different (or no) stamp gets the push.
    const fresh: LocalMirrorStamps = {};
    const r2 = await mirrorHomeToHost(host, { deps: deps(fresh, pushes, undefined, reads, "OLD") });
    expect(r2.pushed).toBe(true);
    expect(pushes).toHaveLength(1);
    // With a local entry the remote stamp is not consulted.
    await mirrorHomeToHost(host, { deps: deps({ "ubuntu@cloud-test.invalid": { hash: "OLD", at: "t" } }, pushes, undefined, reads, "H1") });
    expect(reads).toHaveLength(3);
    expect(pushes).toHaveLength(1);
  });

  test("a laptop that is not logged in ships nothing and says so, before any ssh", async () => {
    const pushes: string[] = [];
    const reads: string[] = [];
    const stamps: LocalMirrorStamps = {};
    const r = await mirrorHomeToHost(host, { deps: { ...deps(stamps, pushes, undefined, reads), readConfig: () => ({}) } });
    expect(r).toMatchObject({ pushed: false, reason: NOT_LOGGED_IN_REASON, changed: 0 });
    expect(pushes).toEqual([]);
    expect(reads).toEqual([]);
    expect(stamps).toEqual({});
  });
});

describe("runMirrorTick", () => {
  const hostA: RemoteHost = { ...host, address: "a.invalid" };
  const hostB: RemoteHost = { ...host, address: "b.invalid" };

  function tickDeps(opts: { hash?: string; stamps?: LocalMirrorStamps; remote?: Record<string, string | null>; outcome?: (h: RemoteHost) => MirrorPushOutcome; hosts?: RemoteHost[] } = {}) {
    const stamps: LocalMirrorStamps = opts.stamps ?? {};
    const pushes: string[] = [];
    const stampReads: string[] = [];
    const logs: string[] = [];
    const deps: Partial<MirrorDeps> = {
      listHosts: async () => opts.hosts ?? [hostA, hostB],
      readStamp: async (h) => { stampReads.push(hostKey(h)); const r = opts.remote?.[hostKey(h)]; return r ? { version: 1, complete: true, hash: r, source_device_id: "d", source_user_id: "u", applied_at: "", files: {}, managed_roots: [] } : null; },
      push: async (h) => { pushes.push(hostKey(h)); return opts.outcome ? opts.outcome(h) : { pushed: true, hash: opts.hash ?? "H1", result: { hash: opts.hash ?? "H1", applied: ["a"], unchanged: 0, host_edited: [], pruned: [], errors: [] } }; },
      build: async () => fakeBuild(opts.hash ?? "H1"),
      readLocalStamps: () => stamps,
      writeLocalStamps: (s) => { Object.assign(stamps, s); },
      readConfig: () => ({ user_id: "u" }),
      log: (m) => logs.push(m),
      now: () => new Date("2026-09-06T00:00:00Z"),
      loggedFailures: new Set(),
    };
    return { deps, stamps, pushes, stampReads, logs };
  }

  test("onlyIfChanged: no ssh when every host's stamp equals the local hash; pushes only to the ones that differ", async () => {
    const t = tickDeps({ stamps: { "ubuntu@a.invalid": { hash: "H1", at: "t" }, "ubuntu@b.invalid": { hash: "H1", at: "t" } } });
    const r = await runMirrorTick({ reason: "mirror_changed", onlyIfChanged: true }, t.deps);
    expect(r).toEqual({ pushed: [], skipped: ["ubuntu@a.invalid", "ubuntu@b.invalid"], failed: [] });
    expect(t.pushes).toEqual([]);
    expect(t.stampReads).toEqual([]);

    const t2 = tickDeps({ stamps: { "ubuntu@a.invalid": { hash: "H1", at: "t" }, "ubuntu@b.invalid": { hash: "OLD", at: "t" } } });
    const r2 = await runMirrorTick({ reason: "mirror_changed", onlyIfChanged: true }, t2.deps);
    expect(r2.pushed).toEqual(["ubuntu@b.invalid"]);
    expect(t2.pushes).toEqual(["ubuntu@b.invalid"]);
    expect(t2.stamps["ubuntu@b.invalid"]!.hash).toBe("H1");
    expect(t2.logs).toEqual(["mirrored 1 changed config file(s) to ubuntu@b.invalid (mirror_changed, H1)"]);
  });

  test("verifyRemote: reads the remote stamp and pushes on mismatch (a re-provisioned host has none)", async () => {
    const t = tickDeps({ stamps: { "ubuntu@a.invalid": { hash: "H1", at: "t" }, "ubuntu@b.invalid": { hash: "H1", at: "t" } }, remote: { "ubuntu@a.invalid": "H1", "ubuntu@b.invalid": null } });
    const r = await runMirrorTick({ reason: "periodic", verifyRemote: true }, t.deps);
    expect(t.stampReads.sort()).toEqual(["ubuntu@a.invalid", "ubuntu@b.invalid"]);
    expect(r.pushed).toEqual(["ubuntu@b.invalid"]);
    expect(r.skipped).toEqual(["ubuntu@a.invalid"]);
  });

  test("a failed host is skipped on the fast tick until the local hash changes, retried on the periodic tick; failures log once per reason", async () => {
    const t = tickDeps({ outcome: () => ({ pushed: false, reason: "unprovisioned" }), hosts: [hostA] });
    await runMirrorTick({ reason: "daemon start" }, t.deps);
    expect(t.stamps["ubuntu@a.invalid"]!.last_failure).toMatchObject({ reason: "unprovisioned", hash: "H1" });
    expect(t.logs).toEqual(["mirror to ubuntu@a.invalid skipped (daemon start): unprovisioned — cast hosts provision <id>"]);
    const fast = await runMirrorTick({ reason: "mirror_changed", onlyIfChanged: true }, t.deps);
    expect(fast.skipped).toEqual(["ubuntu@a.invalid"]);
    expect(t.pushes).toHaveLength(1);
    // A refusal is final for this bundle: the periodic tick does not re-upload it either.
    const periodic = await runMirrorTick({ reason: "periodic", verifyRemote: true }, t.deps);
    expect(periodic.failed).toEqual(["ubuntu@a.invalid"]);
    expect(t.pushes).toHaveLength(2);
    // The one stamp read is the first contact's (an unknown host is asked before an upload), none since.
    expect(t.stampReads).toEqual(["ubuntu@a.invalid", "ubuntu@a.invalid"]);
    expect(t.logs).toHaveLength(1);
    // A new local hash retries on the fast tick.
    t.deps.build = async () => fakeBuild("H2");
    const changed = await runMirrorTick({ reason: "mirror_changed", onlyIfChanged: true }, t.deps);
    expect(changed.failed).toEqual(["ubuntu@a.invalid"]);
    expect(t.pushes).toHaveLength(3);

    // A transport failure (not a refusal) IS retried on the periodic tick.
    const flaky = tickDeps({ outcome: () => ({ pushed: true, hash: "H1", result: { hash: "H1", applied: [], unchanged: 1, host_edited: [], pruned: [], errors: [] } }), hosts: [hostA], stamps: { "ubuntu@a.invalid": { hash: "", at: "t", last_failure: { reason: "connection reset", at: "t", hash: "H1" } } } });
    const retried = await runMirrorTick({ reason: "periodic", verifyRemote: true }, flaky.deps);
    expect(retried.pushed).toEqual(["ubuntu@a.invalid"]);
  });

  test("a host the local stamps do not know (new address after a wake) has its stamp read before any upload, even on the fast tick", async () => {
    const t = tickDeps({ hosts: [hostA], remote: { "ubuntu@a.invalid": "H1" } });
    const r = await runMirrorTick({ reason: "mirror_changed", onlyIfChanged: true }, t.deps);
    expect(r.skipped).toEqual(["ubuntu@a.invalid"]);
    expect(t.stampReads).toEqual(["ubuntu@a.invalid"]);
    expect(t.pushes).toEqual([]);
    expect(t.stamps["ubuntu@a.invalid"]).toMatchObject({ hash: "H1" });
    const t2 = tickDeps({ hosts: [hostA], remote: { "ubuntu@a.invalid": null } });
    const r2 = await runMirrorTick({ reason: "daemon start" }, t2.deps);
    expect(r2.pushed).toEqual(["ubuntu@a.invalid"]);
  });

  test("a logged-out laptop pushes to nobody and logs the reason once per host", async () => {
    const t = tickDeps({ hosts: [hostA, hostB] });
    t.deps.readConfig = () => ({});
    const r = await runMirrorTick({ reason: "daemon start" }, t.deps);
    expect(r.skipped).toEqual(["ubuntu@a.invalid", "ubuntu@b.invalid"]);
    expect(t.pushes).toEqual([]);
    await runMirrorTick({ reason: "periodic", verifyRemote: true }, t.deps);
    expect(t.logs).toEqual([
      `mirror to ubuntu@a.invalid skipped (daemon start): ${NOT_LOGGED_IN_REASON}`,
      `mirror to ubuntu@b.invalid skipped (daemon start): ${NOT_LOGGED_IN_REASON}`,
    ]);
  });

  test("a throwing push is a recorded failure, not an exception; unreachable hosts are never listed", async () => {
    const t = tickDeps({ hosts: [hostA] });
    t.deps.push = async () => { throw new Error("connection reset"); };
    const r = await runMirrorTick({ reason: "daemon start" }, t.deps);
    expect(r.failed).toEqual(["ubuntu@a.invalid"]);
    expect(t.stamps["ubuntu@a.invalid"]!.last_failure?.reason).toBe("connection reset");
    expect(t.logs[0]).toContain("connection reset");
    const none = tickDeps({ hosts: [] });
    expect(await runMirrorTick({ reason: "daemon start" }, none.deps)).toEqual({ pushed: [], skipped: [], failed: [] });
  });
});

describe("mirrorForPrepare", () => {
  test("disabled mirror attempts nothing; a throwing or partial push blocks prepare and logs", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const mirror = (async () => { calls.push("push"); throw new Error("ssh down"); }) as any;
    for (const config of [{ cloud_mirror_enabled: false }, { cloud_mirror_enabled: "false" as any }]) {
      const line = await mirrorForPrepare(host, "i-1", (m) => lines.push(m), { config, mirror });
      expect(line).toBe("config mirror disabled");
    }
    expect(calls).toEqual([]);
    await expect(mirrorForPrepare(host, "i-1", (m) => lines.push(m), { config: { user_id: "u" }, mirror })).rejects.toThrow("config mirror failed: ssh down");
    expect(lines).toEqual(["config mirror failed: ssh down"]);
    const incomplete = (async () => ({ pushed: true, hash: "abcdef0123", changed: 3, result: { hash: "abcdef0123", applied: ["a"], unchanged: 0, host_edited: ["h"], pruned: [], errors: [] } })) as any;
    await expect(mirrorForPrepare(host, "i-1", () => {}, { config: { user_id: "u" }, mirror: incomplete })).rejects.toThrow("h: remote edit conflict");
    const unprov = (async () => ({ pushed: false, reason: "unprovisioned", changed: 0 })) as any;
    await expect(mirrorForPrepare(host, "i-1", () => {}, { config: { user_id: "u" }, mirror: unprov })).rejects.toThrow("cast hosts provision i-1");
    const inStep = (async () => ({ pushed: false, skipped: "in step", changed: 0, hash: "abcdef0123" })) as any;
    expect(await mirrorForPrepare(host, "i-1", () => {}, { config: { user_id: "u" }, mirror: inStep })).toBe("config mirror in step (abcdef01)");
  });
});

describe("the wire bundle the tick builds parses", () => {
  test("fakeBuild output is a valid bundle", async () => {
    const parsed = await parseMirrorBundle(fakeBuild("x").bytes);
    expect(parsed.files).toHaveLength(1);
  });
});

test("canceling a mirror push settles only after the SSH process exits", async () => {
  process.env.PUSH_TEST_MODE = "hang";
  const controller = new AbortController();
  const pending = pushMirrorToHostAsync(host, bundle, { signal: controller.signal });
  const outcome = pending.catch((error) => error);
  const pidFile = process.env.PUSH_TEST_ARGV! + ".pid";
  try {
    for (let n = 0; n < 200 && !fs.existsSync(pidFile); n++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(pidFile)).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    controller.abort();
    expect((await outcome).message).toBe("mirror operation aborted");
    let code: string | undefined;
    try { process.kill(pid, 0); } catch (error) { code = (error as NodeJS.ErrnoException).code; }
    expect(code).toBe("ESRCH");
  } finally {
    controller.abort();
    await outcome;
  }
});

test("partial results and false hashes never make a local stamp current; source failures clear prior success", async () => {
  let stamps: LocalMirrorStamps = { [hostKey(host)]: { hash: "H1", at: "earlier" } };
  const base: Partial<MirrorDeps> = {
    readConfig: () => ({ user_id: "u" }),
    readProjects: () => [],
    readLocalStamps: () => structuredClone(stamps),
    writeLocalStamps: (next) => { stamps = next; },
    build: async () => fakeBuild("H1"),
    readStamp: async () => null,
  };
  for (const result of [
    { hash: "H1", applied: [], unchanged: 0, host_edited: [], pruned: [], errors: [{ path: "x", error: "blocked" }] },
    { hash: "H1", applied: [], unchanged: 0, host_edited: ["x"], pruned: [], errors: [] },
    { hash: "wrong", applied: [], unchanged: 0, host_edited: [], pruned: [], errors: [] },
  ]) {
    const r = await mirrorHomeToHost(host, { deps: { ...base, push: async () => ({ pushed: true, hash: result.hash, result }) } });
    expect(r.pushed).toBe(false);
    expect(stamps[hostKey(host)]!.hash).toBe("");
    expect(stamps[hostKey(host)]!.last_failure).toBeDefined();
  }
  await expect(mirrorHomeToHost(host, { deps: { ...base, build: async () => { throw new Error("unreadable input"); } } })).rejects.toThrow("unreadable input");
  expect(stamps[hostKey(host)]!.last_failure?.reason).toBe("unreadable input");
});

test("disabled mirror skips all work and unchanged bundles recover from an older host after bounded backoff", async () => {
  let attempts = 0;
  let now = new Date("2026-09-06T00:00:00Z");
  let stamps: LocalMirrorStamps = {};
  const deps: Partial<MirrorDeps> = {
    readConfig: () => ({ user_id: "u" }), listHosts: async () => [host], readProjects: () => [],
    readLocalStamps: () => structuredClone(stamps), writeLocalStamps: (s) => { stamps = s; },
    build: async () => fakeBuild("H1"), now: () => now, readStamp: async () => null,
    push: async () => { attempts++; return attempts === 1 ? { pushed: false, reason: OLDER_HOST_REASON } : { pushed: true, hash: "H1", result: { hash: "H1", applied: [], unchanged: 0, host_edited: [], pruned: [], errors: [] } }; },
  };
  const disabled = { ...deps, readConfig: () => ({ user_id: "u", cloud_mirror_enabled: false }) };
  expect(await runMirrorTick({ reason: "disabled" }, disabled)).toEqual({ pushed: [], failed: [], skipped: [] });
  expect((await mirrorHomeToHost(host, { deps: disabled })).reason).toBe("config mirror disabled");
  expect(attempts).toBe(0);
  expect((await runMirrorTick({ reason: "start" }, deps)).failed).toHaveLength(1);
  expect((await runMirrorTick({ reason: "fast", onlyIfChanged: true }, deps)).skipped).toHaveLength(1);
  now = new Date(now.getTime() + 60_001);
  expect((await runMirrorTick({ reason: "retry", onlyIfChanged: true }, deps)).pushed).toHaveLength(1);
  expect(attempts).toBe(2);
});

test("concurrent targets retain each stamp and concurrent writes to one target serialize", async () => {
  let stamps: LocalMirrorStamps = {};
  const active = new Set<string>();
  const deps: Partial<MirrorDeps> = {
    readConfig: () => ({ user_id: "u" }), readProjects: () => [], build: async () => fakeBuild("H1"),
    readLocalStamps: () => structuredClone(stamps), writeLocalStamps: (next) => { stamps = next; }, readStamp: async () => null,
    push: async (target) => {
      expect(active.has(hostKey(target))).toBe(false);
      active.add(hostKey(target));
      await new Promise((r) => setTimeout(r, 20));
      active.delete(hostKey(target));
      return { pushed: true, hash: "H1", result: { hash: "H1", applied: [], unchanged: 1, host_edited: [], pruned: [], errors: [] } };
    },
  };
  await Promise.all([mirrorHomeToHost(host, { deps }), mirrorHomeToHost({ ...host, address: "second.invalid" }, { deps }), mirrorHomeToHost(host, { deps })]);
  expect(Object.keys(stamps).sort()).toEqual([hostKey(host), "ubuntu@second.invalid"].sort());
});


test("gzip transport feeds the unchanged validated protocol to an injected receiver command", async () => {
  process.env.PUSH_TEST_MODE = "decode";
  const receiver = path.join(dir, "receiver.ts");
  const parser = path.join(import.meta.dir, "bundle.ts");
  fs.writeFileSync(receiver, `import {parseMirrorBundle} from ${JSON.stringify(parser)}; const bundle=await parseMirrorBundle(process.stdin); console.log(JSON.stringify({hash:bundle.hash,applied:bundle.files.map(f=>f.path),unchanged:0,host_edited:[],pruned:[],errors:[]}));`);
  const built = fakeBuild("repeated context ".repeat(10000));
  const received = await pushMirrorToHostAsync(host, built.bytes, { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(receiver)}` });
  expect(received.pushed).toBe(true);
  expect(received.hash).toBe((await parseMirrorBundle(built.bytes)).hash);
  expect(received.result?.applied).toEqual([".claude/CLAUDE.md"]);
  expect(fs.readFileSync(process.env.PUSH_TEST_STDIN!).equals(built.bytes)).toBe(true);
});
