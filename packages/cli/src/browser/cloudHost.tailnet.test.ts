/**
 * Which address the laptop dials for a cloud host, and above all that the
 * public address stays the answer whenever the tailnet cannot be trusted.
 *
 * A fake `tailscale` binary on PATH stands in for the real one, so the binary
 * lookup, the spawn and its timeout all run for real. Every case in the first
 * block must resolve to the public address: no tailscale, tailscale stopped,
 * the peer offline, a different node at that IP, a hanging or broken binary.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dialRemoteHost, noteDialError, noteDialFailure, probedRemoteHost, reachableRemoteHosts, resetDialFailuresForTests, toRemoteHost, writeHosts, type CloudHost } from "./cloudHost";
import { localTailnetAsync, readHostTailnet } from "../cloud/tailnet";
import { resolveCarryHost } from "../cloud/browserSync";
import { readProjectRegistrations } from "../cloud/mirror/projectRefresh";
import type { RemoteHost } from "../remote/session-move";

const PUBLIC = "54.1.2.3";
const TAILNET = "100.101.102.103";
const NODE = "codecast-box.tail1234.ts.net.";
const host = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: PUBLIC, deviceId: "box" } as CloudHost;
const onTailnet = { ...host, tailnet: { ip: TAILNET, name: NODE, checkedAt: 1 } } as CloudHost;

let dir: string, prevPath: string | undefined, prevBin: string | undefined, prevDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-tailnet-"));
  prevPath = process.env.PATH; prevBin = process.env.CODECAST_TAILSCALE_BIN; prevDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
  // No binary anywhere unless a test installs one: a real Tailscale.app on
  // the machine running the suite must not decide these cases.
  process.env.CODECAST_TAILSCALE_BIN = path.join(dir, "no-such-tailscale");
  process.env.PATH = `/usr/bin:/bin`;
  resetDialFailuresForTests();
});

afterEach(() => {
  process.env.PATH = prevPath;
  if (prevBin === undefined) delete process.env.CODECAST_TAILSCALE_BIN; else process.env.CODECAST_TAILSCALE_BIN = prevBin;
  if (prevDir === undefined) delete process.env.CODECAST_DIR; else process.env.CODECAST_DIR = prevDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake `tailscale` whose `status --json` prints `body` (or runs `script`). */
function fakeTailscale(opts: { status?: unknown; script?: string }): void {
  const bin = path.join(dir, `bin-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(bin);
  const json = path.join(bin, "status.json");
  if (opts.status !== undefined) fs.writeFileSync(json, JSON.stringify(opts.status));
  fs.writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\n${opts.script ?? `cat '${json}'`}\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  delete process.env.CODECAST_TAILSCALE_BIN;
}

const status = (backend: string, peer: { ip?: string; name?: string; online?: boolean } = {}) => ({
  BackendState: backend,
  Self: { DNSName: "laptop.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1"], Online: true },
  Peer: {
    "nodekey:abc": { DNSName: peer.name ?? NODE, TailscaleIPs: [peer.ip ?? TAILNET, "fd7a:115c:a1e0::1"], Online: peer.online ?? true },
  },
});

describe("the public address stays the answer when the tailnet cannot be trusted", () => {
  test("no tailscale binary: public, recorded tailnet or not", () => {
    expect(toRemoteHost(host).address).toBe(PUBLIC);
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("tailscale installed but stopped or logged out: public", () => {
    fakeTailscale({ status: status("Stopped") });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
    fakeTailscale({ status: status("NeedsLogin") });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("the host's node is offline: public", () => {
    fakeTailscale({ status: status("Running", { online: false }) });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("a different node holds the recorded IP (the host left, the IP was reissued): public", () => {
    fakeTailscale({ status: status("Running", { name: "someone-else.tail1234.ts.net." }) });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("the recorded IP is not on this laptop's tailnet at all: public", () => {
    fakeTailscale({ status: status("Running", { ip: "100.9.9.9" }) });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("a host with no tailnet record: public even on a running tailnet", () => {
    fakeTailscale({ status: status("Running") });
    expect(toRemoteHost(host).address).toBe(PUBLIC);
  });
  test("broken binary (exit 1, garbage JSON): public", () => {
    fakeTailscale({ script: "echo 'failed to connect to local tailscaled' >&2; exit 1" });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
    fakeTailscale({ script: "echo '{not json'" });
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
  });
  test("a hanging binary is cut off quickly and answers public", () => {
    fakeTailscale({ script: "sleep 30" });
    const t = Date.now();
    expect(toRemoteHost(onTailnet).address).toBe(PUBLIC);
    expect(Date.now() - t).toBeLessThan(5_000);
  });
  test("no address at all still throws the start-it-first error", () => {
    expect(() => toRemoteHost({ ...host, address: undefined })).toThrow("start it first");
  });
});

describe("the relay's carry resolves the public address without a tailnet", () => {
  const deps = (reachable: (a: string) => boolean) => ({
    hostForDevice: (id: string) => (id === "box" ? onTailnet : undefined),
    toRemoteHost,
    sshReachable: async (h: RemoteHost) => reachable(h.address),
    hostState: (h: CloudHost) => ({ state: "running" as const, address: h.address }),
    patchHost: () => undefined,
  });
  test("no tailscale: the carry dials the public address", async () => {
    const r = await resolveCarryHost("box", deps(() => true));
    expect(r.ok && r.host.address).toBe(PUBLIC);
  });
  test("tailnet down: the carry still dials the public address", async () => {
    fakeTailscale({ status: status("Running", { online: false }) });
    const r = await resolveCarryHost("box", deps((a) => a === PUBLIC));
    expect(r.ok && r.host.address).toBe(PUBLIC);
  });
});

describe("mirror registrations find the host by the address the laptop dialed", () => {
  test("public dial maps back to the registry id", () => {
    writeHosts([onTailnet]);
    const file = path.join(dir, "regs.json");
    fs.writeFileSync(file, JSON.stringify([{ host: "ubuntu@old-address", hostId: "i-1", sourceRoot: "/src", targetRoot: "/home/ubuntu/work/x" }]));
    expect(readProjectRegistrations(toRemoteHost(onTailnet), file)).toHaveLength(1);
  });
});

describe("with the host's node online on this laptop's tailnet", () => {
  test("the tailnet IP is dialed", () => {
    fakeTailscale({ status: status("Running") });
    expect(toRemoteHost(onTailnet).address).toBe(TAILNET);
  });
  test("the carry takes the tailnet when it answers", async () => {
    fakeTailscale({ status: status("Running") });
    const probed: string[] = [];
    const r = await resolveCarryHost("box", {
      hostForDevice: () => onTailnet, toRemoteHost, patchHost: () => undefined,
      hostState: () => ({ state: "running" as const, address: PUBLIC }),
      sshReachable: async (h) => { probed.push(h.address); return true; },
    });
    expect(r.ok && r.host.address).toBe(TAILNET);
    expect(probed).toEqual([TAILNET]);
  });
  test("the tailnet claims the node but does not carry the connection: the carry falls back to public", async () => {
    fakeTailscale({ status: status("Running") });
    const probed: string[] = [];
    const r = await resolveCarryHost("box", {
      hostForDevice: () => onTailnet, toRemoteHost, patchHost: () => undefined,
      hostState: () => ({ state: "running" as const, address: PUBLIC }),
      sshReachable: async (h) => { probed.push(h.address); return h.address === PUBLIC; },
    });
    expect(r.ok && r.host.address).toBe(PUBLIC);
    expect(probed).toEqual([TAILNET, PUBLIC]);
  });
  test("the daemon's reachable-host list falls back per host the same way", async () => {
    fakeTailscale({ status: status("Running") });
    writeHosts([onTailnet, { ...host, id: "i-2", address: "54.9.9.9" }]);
    expect((await reachableRemoteHosts([], async () => true)).map((h) => h.address)).toEqual([TAILNET, "54.9.9.9"]);
    expect((await reachableRemoteHosts([], async (h) => h.address !== TAILNET)).map((h) => h.address)).toEqual([PUBLIC, "54.9.9.9"]);
    expect(await reachableRemoteHosts([], async () => false)).toEqual([]);
  });
  test("mirror registrations find the host by its tailnet address too", () => {
    fakeTailscale({ status: status("Running") });
    writeHosts([onTailnet]);
    const file = path.join(dir, "regs.json");
    fs.writeFileSync(file, JSON.stringify([{ host: "ubuntu@old-address", hostId: "i-1", sourceRoot: "/src", targetRoot: "/home/ubuntu/work/x" }]));
    const remote = toRemoteHost(onTailnet);
    expect(remote.address).toBe(TAILNET);
    expect(readProjectRegistrations(remote, file)).toHaveLength(1);
  });
});

describe("readHostTailnet — what ensureUp records from the host's own status", () => {
  const self = (backend: string, ips: string[], name = NODE) => JSON.stringify({ BackendState: backend, Self: { DNSName: name, TailscaleIPs: ips } });
  test("a running node gives its IPv4 and name", () => {
    expect(readHostTailnet(self("Running", ["fd7a:115c:a1e0::1", TAILNET]), 7)).toEqual({ ip: TAILNET, name: NODE, checkedAt: 7 });
  });
  test("no tailscale, stopped, no IPv4, no name: no record (which clears a stale one)", () => {
    expect(readHostTailnet("")).toBeUndefined();
    expect(readHostTailnet(self("Stopped", [TAILNET]))).toBeUndefined();
    expect(readHostTailnet(self("Running", ["fd7a:115c:a1e0::1"]))).toBeUndefined();
    expect(readHostTailnet(self("Running", [TAILNET], ""))).toBeUndefined();
    expect(readHostTailnet("{oops")).toBeUndefined();
  });
});

describe("localTailnetAsync — the daemon's non-blocking read", () => {
  test("concurrent callers share one spawn and its answer", async () => {
    const count = path.join(dir, "spawns");
    fakeTailscale({ status: { ...status("Running"), Self: { DNSName: "laptop.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1"], UserID: 7 } } });
    const bin = process.env.PATH!.split(":")[0];
    fs.writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\necho x >> '${count}'\ncat '${path.join(bin, "status.json")}'\n`, { mode: 0o755 });
    const all = await Promise.all([localTailnetAsync(), localTailnetAsync(), localTailnetAsync()]);
    expect(all[0]?.Self?.UserID).toBe(7);
    expect(all[1]).toBe(all[0]);
    expect(all[2]).toBe(all[0]);
    expect(fs.readFileSync(count, "utf-8").trim().split("\n")).toHaveLength(1);
    expect(await localTailnetAsync()).toBe(all[0]);
    expect(fs.readFileSync(count, "utf-8").trim().split("\n")).toHaveLength(1);
  });
  test("stopped, missing or broken: null", async () => {
    expect(await localTailnetAsync()).toBeNull();
    fakeTailscale({ status: status("Stopped") });
    expect(await localTailnetAsync()).toBeNull();
    fakeTailscale({ script: "exit 1" });
    expect(await localTailnetAsync()).toBeNull();
  });
});

describe("a caller that dials every few seconds and cannot probe each time", () => {
  test("after a failed tailnet dial it uses public for a while, then tries the tailnet again", () => {
    fakeTailscale({ status: status("Running") });
    const t0 = 5_000_000;
    expect(dialRemoteHost(onTailnet, t0).address).toBe(TAILNET);
    expect(noteDialFailure(onTailnet, t0)).toBe(true);
    expect(dialRemoteHost(onTailnet, t0 + 60_000).address).toBe(PUBLIC);
    expect(toRemoteHost(onTailnet).address).toBe(TAILNET);
    expect(dialRemoteHost(onTailnet, t0 + 5 * 60_000 + 1).address).toBe(TAILNET);
  });
  test("a failure while dialing public shuns nothing", () => {
    expect(noteDialFailure(onTailnet, 1)).toBe(false);
    fakeTailscale({ status: status("Running") });
    expect(dialRemoteHost(onTailnet, 2).address).toBe(TAILNET);
  });
  test("only an ssh connect failure moves the dial; a git or script error does not", () => {
    fakeTailscale({ status: status("Running") });
    expect(noteDialError(onTailnet, new Error("on the host: fatal: not a git repository"), 1)).toBe(false);
    expect(dialRemoteHost(onTailnet, 2).address).toBe(TAILNET);
    expect(noteDialError(onTailnet, new Error(`on the host: ssh: connect to host ${TAILNET} port 22: Operation timed out`), 3)).toBe(true);
    expect(dialRemoteHost(onTailnet, 4).address).toBe(PUBLIC);
    expect(noteDialError(onTailnet, new Error(`on the host: ssh: connect to host ${PUBLIC} port 22: Operation timed out`), 5)).toBe(false);
    expect(noteDialError(null, new Error("ssh: connect to host x port 22: No route to host"))).toBe(false);
  });
  test("a one-shot command probes once and takes public when the tailnet drops traffic", async () => {
    fakeTailscale({ status: status("Running") });
    const probed: string[] = [];
    expect((await probedRemoteHost(onTailnet, async (h) => { probed.push(h.address); return h.address === PUBLIC; })).address).toBe(PUBLIC);
    expect(probed).toEqual([TAILNET, PUBLIC]);
  });
  test("ensureUp falling back from the tailnet leaves later dials in that process on public", async () => {
    fakeTailscale({ status: status("Running") });
    const home = path.join(dir, "home");
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, "aws"), `#!/bin/sh
case "$*" in
  *describe-instances*) echo '{"Reservations":[{"Instances":[{"State":{"Name":"running"},"PublicIpAddress":"${PUBLIC}"}]}]}';;
  *) echo '{}';;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(localBin, "ssh"), `#!/bin/sh\ncase "$*" in *${TAILNET}*) exit 255;; esac\nexit 0\n`, { mode: 0o755 });
    writeHosts([onTailnet]);
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", `
      import { dialRemoteHost, ensureUp } from ${JSON.stringify(path.resolve(import.meta.dir, "cloudHost.ts"))};
      const h = ${JSON.stringify(onTailnet)};
      const before = dialRemoteHost(h).address;
      await ensureUp(h);
      console.log(JSON.stringify([before, dialRemoteHost(h).address]));
    `], { env: { ...process.env, HOME: home, PATH: `${localBin}:${process.env.PATH}` }, timeout: 30_000 });
    expect(JSON.parse(stdout.trim().split("\n").pop()!)).toEqual([TAILNET, PUBLIC]);
  }, 40_000);
});
