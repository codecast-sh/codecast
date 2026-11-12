import { afterEach, beforeEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import type { TailnetStatus } from "../cloud/tailnet";
import { firewallBlocksIncoming, grantBindAddress, verifyOwnerPeer } from "./identity";
import { acceptGrantSocket, closeAllGrants, liveGrantCount, MAX_LIVE_GRANTS, newGrantSecret, openGrant } from "./grant";
import { pullGrantInto } from "./pull";
import { unpackFolderStream } from "../folderSync";
import { pollUntil } from "../test-helpers/pollUntil";

// Nearly every test here spawns git or tar, or serves a real socket; under
// `bun test --parallel` on a loaded runner the 5 s default is not enough.
setDefaultTimeout(30_000);

const LOOP = "127.0.0.1";
const PEER = { ip: "100.64.0.2", name: "mini.tail1234.ts.net." };

function status(peer: Record<string, unknown> = {}, self: Record<string, unknown> = {}): TailnetStatus {
  return {
    BackendState: "Running",
    Self: { DNSName: "mbp.tail1234.ts.net.", TailscaleIPs: ["100.64.0.1", "fd7a::1"], Online: true, UserID: 7, ...self },
    Peer: { k: { DNSName: PEER.name, TailscaleIPs: [PEER.ip], Online: true, UserID: 7, ...peer } },
  };
}

describe("verifyOwnerPeer", () => {
  const code = (r: ReturnType<typeof verifyOwnerPeer>) => (r.ok ? "ok" : r.reason.split(":")[0]);
  test.each([
    ["same user, online", status(), PEER, "ok"],
    ["no tailnet", null, PEER, "not_on_tailnet"],
    ["stopped", { ...status(), BackendState: "Stopped" }, PEER, "not_on_tailnet"],
    ["no node at that ip", status(), { ...PEER, ip: "100.64.0.9" }, "not_on_tailnet"],
    ["another node holds the ip", status(), { ...PEER, name: "evil.tail1234.ts.net." }, "name_mismatch"],
    ["offline", status({ Online: false }), PEER, "offline"],
    ["shared in", status({ ShareeNode: true }), PEER, "shared_node"],
    ["another user on the same tailnet", status({ UserID: 8 }), PEER, "other_user"],
    ["peer user unknown", status({ UserID: undefined }), PEER, "other_user"],
    ["self user unknown", status({}, { UserID: undefined }), PEER, "other_user"],
    ["tagged peer", status({ Tags: ["tag:server"] }), PEER, "other_user"],
    ["tagged self", status({}, { Tags: ["tag:server"] }), PEER, "other_user"],
  ] as const)("%s", (_, s, peer, want) => {
    expect(code(verifyOwnerPeer(s as TailnetStatus | null, peer))).toBe(want);
  });
});

describe("grantBindAddress", () => {
  const iface = (address: string) => ({ address, family: "IPv4", netmask: "255.255.255.255", mac: "", internal: false, cidr: null }) as os.NetworkInterfaceInfo;
  test("Self's IPv4 on a local interface", () => {
    expect(grantBindAddress(status(), { utun4: [iface("100.64.0.1")] })).toEqual({ ok: true, ip: "100.64.0.1" });
  });
  test("userspace networking: the IP is on no interface", () => {
    const r = grantBindAddress(status(), { en0: [iface("192.168.1.5")] });
    expect(r.ok === false && r.reason.startsWith("userspace")).toBe(true);
  });
  test("not on a tailnet", () => {
    const r = grantBindAddress(null, { utun4: [iface("100.64.0.1")] });
    expect(r.ok === false && r.reason.startsWith("not_on_tailnet")).toBe(true);
  });
});

describe("firewallBlocksIncoming", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "peer-fw-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = (out: string, exit = 0) => {
    const p = path.join(dir, `fw-${Math.random().toString(36).slice(2)}`);
    fs.writeFileSync(p, `#!/bin/sh\necho '${out}'\nexit ${exit}\n`, { mode: 0o755 });
    return p;
  };
  test("block all enabled", async () => {
    expect(await firewallBlocksIncoming({ platform: "darwin", bin: bin("Firewall has block all state set to enabled.") })).toBe(true);
    expect(await firewallBlocksIncoming({ platform: "darwin", bin: bin("Block all ENABLED!") })).toBe(true);
  });
  test("disabled, broken, missing, or not macOS", async () => {
    expect(await firewallBlocksIncoming({ platform: "darwin", bin: bin("Firewall has block all state set to disabled.") })).toBe(false);
    expect(await firewallBlocksIncoming({ platform: "darwin", bin: bin("enabled", 1) })).toBe(false);
    expect(await firewallBlocksIncoming({ platform: "darwin", bin: path.join(dir, "missing") })).toBe(false);
    expect(await firewallBlocksIncoming({ platform: "linux", bin: bin("enabled") })).toBe(false);
  });
});

function producer(chunks: (Buffer | Error)[], opts: { stall?: boolean } = {}) {
  let killed = false;
  return {
    get killed() { return killed; },
    serve: () => {
      const stream = new PassThrough();
      setImmediate(() => {
        for (const c of chunks) {
          if (c instanceof Error) return stream.destroy(c);
          stream.write(c);
        }
        if (!opts.stall) stream.end();
      });
      return { stream, kill: () => { killed = true; stream.destroy(); } };
    },
  };
}

async function collect(body: NodeJS.ReadableStream): Promise<string> {
  let s = "";
  for await (const c of body as AsyncIterable<Buffer>) s += c.toString();
  return s;
}

function rawGet(port: number, p: string): Promise<number | string> {
  return new Promise((resolve) => {
    const req = http.get({ host: LOOP, port, path: p, agent: false }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
}

describe("a grant on loopback", () => {
  afterEach(async () => {
    closeAllGrants();
    await pollUntil(() => liveGrantCount() === 0, "grants closed");
  });

  test("a wrong secret gets 404 and the grant stays open for the right one", async () => {
    const { secret, hash } = newGrantSecret();
    const src = producer([Buffer.from("hello "), Buffer.from("world")]);
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve: src.serve });
    await expect(pullGrantInto({ ip: LOOP, port: g.port, secret: newGrantSecret().secret, maxBytes: 1e6, sink: collect as never })).rejects.toThrow("http_404");
    expect(await rawGet(g.port, "/other")).toBe(404);
    let got = "";
    const r = await pullGrantInto({ ip: LOOP, port: g.port, secret, maxBytes: 1e6, sink: async (b) => { got = await collect(b); } });
    expect(got).toBe("hello world");
    expect(r.bytes).toBe(11);
    expect(await g.done).toEqual({ served: true, reason: "served", bytes: 11 });
    expect(await rawGet(g.port, `/grant/${secret}`)).toBe("ECONNREFUSED");
  });

  test("a connection from any other address is dropped before a byte is read", async () => {
    const { secret, hash } = newGrantSecret();
    const g = await openGrant({ bindIp: LOOP, allowFrom: "127.0.0.2", tokenHash: hash, serve: producer([Buffer.from("x")]).serve });
    expect(await rawGet(g.port, `/grant/${secret}`)).toBe("ECONNRESET");
    expect(liveGrantCount()).toBe(1);
    g.close();
    expect((await g.done).reason).toBe("closed");
  });

  test("acceptGrantSocket compares normalized addresses", () => {
    expect(acceptGrantSocket({ remoteAddress: "::ffff:100.64.0.2", localAddress: "100.64.0.1" }, "100.64.0.1", "100.64.0.2")).toBe(true);
    expect(acceptGrantSocket({ remoteAddress: "100.64.0.3", localAddress: "100.64.0.1" }, "100.64.0.1", "100.64.0.2")).toBe(false);
    expect(acceptGrantSocket({ remoteAddress: "100.64.0.2", localAddress: "192.168.1.5" }, "100.64.0.1", "100.64.0.2")).toBe(false);
    expect(acceptGrantSocket({}, "100.64.0.1", "100.64.0.2")).toBe(false);
  });

  test("nobody connects: the grant closes at its connect deadline", async () => {
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: newGrantSecret().hash, serve: producer([]).serve, connectTimeoutMs: 50 });
    expect(await g.done).toEqual({ served: false, reason: "connect_timeout", bytes: 0 });
    expect(await rawGet(g.port, "/x")).toBe("ECONNREFUSED");
  });

  test("refuses wildcard binds and more than the live cap", async () => {
    const hash = newGrantSecret().hash;
    const serve = producer([]).serve;
    for (const bindIp of ["0.0.0.0", "::", ""]) await expect(openGrant({ bindIp, allowFrom: LOOP, tokenHash: hash, serve })).rejects.toThrow("refusing");
    for (let i = 0; i < MAX_LIVE_GRANTS; i++) await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve });
    await expect(openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve })).rejects.toThrow("already open");
  });

  test("the producer failing mid-stream fails the pull and leaves no folder", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "peer-pull-"));
    try {
      const { secret, hash } = newGrantSecret();
      const whole = gzipSync(Buffer.alloc(200_000, 7));
      const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve: producer([whole.subarray(0, 100), new Error("tar died")]).serve });
      const dest = path.join(parent, "proj");
      await expect(pullGrantInto({ ip: LOOP, port: g.port, secret, maxBytes: 1e9, sink: (b) => unpackFolderStream(b, dest) })).rejects.toThrow();
      expect((await g.done).reason).toBe("producer_failed: tar died");
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a stalled source trips the puller's idle deadline and the reader closing kills the producer", async () => {
    const { secret, hash } = newGrantSecret();
    const src = producer([Buffer.from("partial")], { stall: true });
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve: src.serve });
    await expect(pullGrantInto({ ip: LOOP, port: g.port, secret, maxBytes: 1e6, idleTimeoutMs: 100, sink: async (b) => { await collect(b); } })).rejects.toThrow("idle_timeout");
    expect((await g.done).reason).toBe("reader_closed");
    expect(src.killed).toBe(true);
  });

  test("a body past maxBytes is refused", async () => {
    const { secret, hash } = newGrantSecret();
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve: producer([Buffer.alloc(5000), Buffer.alloc(5000)]).serve });
    await expect(pullGrantInto({ ip: LOOP, port: g.port, secret, maxBytes: 1000, sink: async (b) => { await collect(b); } })).rejects.toThrow("over 1000 bytes");
  });

  test("the grant's own idle deadline closes a transfer that stops", async () => {
    const { secret, hash } = newGrantSecret();
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: hash, serve: producer([Buffer.from("a")], { stall: true }).serve, idleTimeoutMs: 80 });
    await expect(pullGrantInto({ ip: LOOP, port: g.port, secret, maxBytes: 1e6, sink: async (b) => { await collect(b); } })).rejects.toThrow();
    expect((await g.done).reason).toBe("idle_timeout");
  });

  test("nothing listening: the pull rejects", async () => {
    const g = await openGrant({ bindIp: LOOP, allowFrom: LOOP, tokenHash: newGrantSecret().hash, serve: producer([]).serve });
    g.close();
    await g.done;
    await expect(pullGrantInto({ ip: LOOP, port: g.port, secret: "x", maxBytes: 1, sink: async () => {} })).rejects.toThrow();
  });
});
