import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeHosts, type CloudHost } from "../browser/cloudHost";
import { FAKE_BOX, installFakeNamespace } from "../test-helpers/fakeNamespace";

const SOCKET = path.join(os.tmpdir(), "cast-ssh-devbox-cast_box");
const PROXY = "/b/devbox ssh-proxy cast-box";
const box: CloudHost = {
  id: "box123", provider: "namespace", region: "iad", platform: "linux", user: "devbox", keyPath: "/k/ns.key",
  address: "cast-box", proxyCommand: PROXY,
};

const IDENTITY = ["-i", "/k/ns.key", "-o", `ProxyCommand=${PROXY}`, "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null"];
const SSH_BASE = [
  ...IDENTITY,
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "ConnectTimeout=20",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=4",
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${SOCKET}`,
  "-o", "ControlPersist=120",
];

let dir: string, fake: ReturnType<typeof installFakeNamespace>, prev: string | undefined;
const SSH_EXIT = () => path.join(dir, "ssh-exit");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ssh-ns-"));
  fake = installFakeNamespace(dir);
  prev = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  writeHosts([box]);
  fake.set("devbox-list", JSON.stringify([FAKE_BOX]));
});

afterEach(() => {
  if (prev === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prev;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(body: string, sshExit = 0): Promise<{ calls: string[][]; out: unknown }> {
  const log = path.join(dir, "ssh.log");
  const folder = path.join(dir, "folder");
  fs.mkdirSync(folder, { recursive: true });
  for (const tool of ["ssh", "rsync"]) {
    const exit = tool === "ssh" ? `if [ -e '${SSH_EXIT()}' ]; then exit $(cat '${SSH_EXIT()}'); fi\nexit ${sshExit}` : "exit 0";
    fs.writeFileSync(path.join(fake.bin, tool), `#!/bin/sh\nIFS='|'\necho "$(basename "$0")|$*" >> '${log}'\n${exit}\n`, { mode: 0o755 });
  }
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
    import * as fs from "node:fs";
    import { dialsWithoutWaking, dialsWithoutWakingNow, ensureUp, reachableRemoteHost, reachableRemoteHosts, toRemoteHost } from ${JSON.stringify(path.resolve(import.meta.dir, "../browser/cloudHost.ts"))};
    import { gitEnv, pushPath, ssh, sshBase } from ${JSON.stringify(path.resolve(import.meta.dir, "session-move.ts"))};
    const box = ${JSON.stringify(box)};
    const folder = ${JSON.stringify(folder)};
    const sshExit = ${JSON.stringify(SSH_EXIT())};
    const nscCalls = () => { try { return fs.readFileSync(process.env.FAKE_NS + "/calls.log", "utf-8").split("\\n").filter((l) => l.startsWith("nsc|")).length; } catch { return 0; } };
    ${body}
  `], { env: { ...process.env, HOME: fake.home, FAKE_NS: fake.state, PATH: `${fake.bin}:${process.env.PATH}` }, timeout: 30_000 });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf-8").trim().split("\n").filter(Boolean).map((l) => l.split("|")) : [];
  return { calls, out: stdout.trim() ? JSON.parse(stdout) : undefined };
}

describe("the ssh target and identity for a Namespace host", () => {
  test("ssh() puts the proxy and the no-known-hosts options right after the key, then devbox@name", async () => {
    const { calls } = await run(`ssh(toRemoteHost(box), "uptime");`);
    expect(calls).toEqual([["ssh", ...SSH_BASE, "devbox@cast-box", "uptime"]]);
  }, 40_000);

  test("rsync -e quotes the one argument with a space, and a shell reads the string back to the same argv", async () => {
    const { calls } = await run(`await pushPath(toRemoteHost(box), folder);`);
    const rsync = calls.find((c) => c[0] === "rsync")!;
    const shell = rsync[rsync.indexOf("-e") + 1]!;
    expect(shell).toBe(
      `ssh -i /k/ns.key -o 'ProxyCommand=${PROXY}' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new ` +
      `-o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=4 -o ControlMaster=auto -o ControlPath=${SOCKET} -o ControlPersist=120`,
    );
    const parsed = spawnSync("bash", ["-c", `printf '%s\\n' ${shell.slice("ssh ".length)}`], { encoding: "utf-8" }).stdout.trimEnd().split("\n");
    expect(parsed).toEqual(SSH_BASE);
    expect(rsync.at(-1)).toMatch(/^devbox@cast-box:\/home\/devbox\/work\/.*\/$/);
  }, 40_000);

  test("GIT_SSH_COMMAND carries the key, the proxy and its own options", async () => {
    const { out } = await run(`console.log(JSON.stringify(gitEnv(toRemoteHost(box)).GIT_SSH_COMMAND));`);
    expect(out).toBe(
      `ssh -i /k/ns.key -o 'ProxyCommand=${PROXY}' -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20`,
    );
  }, 40_000);

  test("ensureUp on a running box probes through the proxy with a ConnectTimeout that outlasts a start", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const probe = (await run(`await ensureUp(box);`)).calls.find((c) => c[0] === "ssh" && c.at(-1) === "true" && c[1] === "-i");
    expect(probe).toEqual([
      "ssh", ...IDENTITY,
      "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=30",
      "-o", "BatchMode=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ControlMaster=auto",
      "-o", `ControlPath=${SOCKET}`,
      "-o", "ControlPersist=120",
      "devbox@cast-box", "true",
    ]);
    expect(fake.calls().some((c) => c[0] === "devbox" && c[1] !== "list")).toBe(false);
  }, 60_000);

  test("ensureUp on a stopped box starts nothing itself; the first probe through the proxy is what wakes it", async () => {
    const { calls } = await run(`console.log(JSON.stringify((await ensureUp(box)).address));`);
    expect(calls.some((c) => c[0] === "ssh" && c.at(-1) === "true" && c.includes(`ProxyCommand=${PROXY}`))).toBe(true);
    expect(fake.calls().filter((c) => c[0] === "devbox").map((c) => c[1])).toEqual(["list"]);
  }, 40_000);
});

describe("first -o wins: every builder's identity part reaches ssh before accept-new", () => {
  const realSsh = ["/usr/bin/ssh", "/bin/ssh"].find((p) => fs.existsSync(p));

  test.skipIf(!realSsh)("ssh -G resolves the proxy, no host key check and /dev/null known hosts for each builder", async () => {
    const { out } = await run(`
      const { heldSshArgs } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../cloud/agentBridge.ts"))});
      const { cdpTunnelArgs } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../browser/remote.ts"))});
      const { forwardSshArgs } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../cloud/hostForward.ts"))});
      const r = toRemoteHost(box);
      console.log(JSON.stringify({ sshBase: sshBase(r), held: heldSshArgs(r, "true"), cdp: cdpTunnelArgs(r, 9222, 9222), forward: forwardSshArgs(r, 5900) }));
    `);
    for (const [name, argv] of Object.entries(out as Record<string, string[]>)) {
      const r = spawnSync(realSsh!, ["-G", "-F", "/dev/null", ...argv, "devbox@cast-box"], { encoding: "utf-8" });
      const resolved = Object.fromEntries(r.stdout.split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]));
      expect(resolved.stricthostkeychecking, name).toBe("false");
      expect(resolved.userknownhostsfile, name).toBe("/dev/null");
      expect(resolved.proxycommand, name).toBe(PROXY);
    }
  }, 40_000);
});

describe("reachability never connects to a Namespace box", () => {
  test("a stopped box (nsc prints null): the only ssh that runs is -O check, and the box is not reachable", async () => {
    const { calls, out } = await run(`console.log(JSON.stringify({ hosts: await reachableRemoteHosts(), wakes: dialsWithoutWaking(box) }));`, 255);
    expect(out).toEqual({ hosts: [], wakes: false });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[0]).toBe("ssh");
      expect(c.slice(-3, -1)).toEqual(["-O", "check"]);
      expect(c.join(" ")).not.toContain("ProxyCommand");
    }
  }, 40_000);

  test("a running box with no live master is reachable from the provider's answer, still without a connection", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { calls, out } = await run(`console.log(JSON.stringify({ hosts: (await reachableRemoteHosts()).map((h) => h.address), dial: dialsWithoutWaking(box) }));`, 255);
    expect(out).toEqual({ hosts: ["cast-box"], dial: true });
    for (const c of calls) expect(c.slice(-3, -1)).toEqual(["-O", "check"]);
  }, 40_000);

  test("a live control master answers without asking Namespace at all", async () => {
    const { out } = await run(`console.log(JSON.stringify({ hosts: (await reachableRemoteHosts()).map((h) => h.address) }));`, 0);
    expect(out).toEqual({ hosts: ["cast-box"] });
    expect(fake.calls()).toEqual([]);
  }, 40_000);

  test("an nsc that fails means not reachable, never a connection", async () => {
    fake.set("nsc-fail");
    const { calls, out } = await run(`console.log(JSON.stringify({ hosts: await reachableRemoteHosts() }));`, 255);
    expect(out).toEqual({ hosts: [] });
    for (const c of calls) expect(c.slice(-3, -1)).toEqual(["-O", "check"]);
  }, 40_000);

  test("a timer that asks every few seconds never runs nsc itself: the first answer is no, a refresh runs beside it, and the next answer follows it", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const ticks = [dialsWithoutWaking(box), dialsWithoutWaking(box), dialsWithoutWaking(box)];
      const reached = !!(await reachableRemoteHost(box, { toRemoteHost, sshReachable: async () => false }));
      console.log(JSON.stringify({ ticks, reached, after: dialsWithoutWaking(box), nsc: nscCalls() }));
    `, 255);
    expect(out).toEqual({ ticks: [false, false, false], reached: true, after: true, nsc: 1 });
  }, 40_000);

  test("a command-line process answers from a fresh read: the first answer is yes, from one nsc call", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const first = await dialsWithoutWakingNow(box);
      console.log(JSON.stringify({ first, nsc: nscCalls() }));
    `, 255);
    expect(out).toEqual({ first: true, nsc: 1 });
  }, 40_000);

  test("a command-line process still answers no for a stopped box", async () => {
    const { out } = await run(`console.log(JSON.stringify({ first: await dialsWithoutWakingNow(box) }));`, 255);
    expect(out).toEqual({ first: false });
  }, 40_000);

  test("three reads in flight at once share one nsc call", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const deps = { toRemoteHost, sshReachable: async () => false };
      const reached = (await Promise.all([1, 2, 3].map(() => reachableRemoteHost(box, deps)))).map((h) => !!h);
      console.log(JSON.stringify({ reached, nsc: nscCalls() }));
    `, 255);
    expect(out).toEqual({ reached: [true, true, true], nsc: 1 });
  }, 40_000);

  test("nsc failing leaves the timer's answer at no, now and after the refresh", async () => {
    fake.set("nsc-fail");
    const { out } = await run(`
      const ticks = [dialsWithoutWaking(box)];
      const reached = !!(await reachableRemoteHost(box, { toRemoteHost, sshReachable: async () => false }));
      console.log(JSON.stringify({ ticks, reached, after: dialsWithoutWaking(box) }));
    `, 255);
    expect(out).toEqual({ ticks: [false], reached: false, after: false });
  }, 40_000);
});

describe("a Namespace box that is stopping is never read as running", () => {
  test("a control master that was alive and is found dead holds the box off for 90 s, whatever nsc still lists", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const base = Date.now();
      const deps = (up) => ({ toRemoteHost, sshReachable: async () => up });
      const answers = [];
      for (const [up, at] of [[true, 0], [false, 1_000], [false, 30_000], [false, 89_000]]) answers.push(!!(await reachableRemoteHost(box, deps(up), base + at)));
      const during = nscCalls();
      answers.push(!!(await reachableRemoteHost(box, deps(false), base + 91_000)));
      console.log(JSON.stringify({ answers, during, after: nscCalls() }));
    `, 255);
    expect(out).toEqual({ answers: [true, false, false, false, true], during: 0, after: 1 });
  }, 40_000);

  test("dialsWithoutWaking says no for the same 90 s and asks nsc nothing", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const base = Date.now();
      const alive = dialsWithoutWaking(box, base);
      fs.writeFileSync(sshExit, "255");
      const lost = dialsWithoutWaking(box, base + 1_000);
      const held = dialsWithoutWaking(box, base + 89_000);
      const reach = !!(await reachableRemoteHost(box, { toRemoteHost, sshReachable: async () => false }, base + 2_000));
      console.log(JSON.stringify({ alive, lost, held, reach, nsc: nscCalls() }));
    `, 0);
    expect(out).toEqual({ alive: true, lost: false, held: false, reach: false, nsc: 0 });
  }, 40_000);

  test("a running answer is trusted for 10 s and read again after", async () => {
    fake.set("nsc-list", JSON.stringify([{ created_at: "2026-11-17T10:00:00Z" }]));
    const { out } = await run(`
      const base = Date.now();
      const deps = { toRemoteHost, sshReachable: async () => false };
      const counts = [];
      for (const at of [0, 9_000, 11_000]) { await reachableRemoteHost(box, deps, base + at); counts.push(nscCalls()); }
      console.log(JSON.stringify(counts));
    `, 255);
    expect(out).toEqual([1, 1, 2]);
  }, 40_000);

  test("a not-running answer is trusted for 30 s and read again after", async () => {
    const { out } = await run(`
      const base = Date.now();
      const deps = { toRemoteHost, sshReachable: async () => false };
      const counts = [];
      for (const at of [0, 29_000, 31_000]) { await reachableRemoteHost(box, deps, base + at); counts.push(nscCalls()); }
      console.log(JSON.stringify(counts));
    `, 255);
    expect(out).toEqual([1, 1, 2]);
  }, 40_000);
});
