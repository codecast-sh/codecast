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
import { reachableRemoteHosts, toRemoteHost, writeHosts, type CloudHost } from "./cloudHost";
import { readHostTailnet } from "../cloud/tailnet";
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
