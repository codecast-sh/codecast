import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { isolateCodecastDir } from "../test-helpers/codecastDir.js";
import { freePort } from "../browser/instance.js";
import { startBridgeHost } from "../browser/bridge/host.js";
import { newHostClient, type HostClients } from "../browser/bridge/hostClients.js";
import { CLOSE_BAD_TOKEN } from "../browser/bridge/protocol.js";
import { TEST_TOKEN } from "../browser/bridge/host.testutil.js";
import type { CloudHost } from "../browser/cloudHost.js";
import { newGrant } from "./remoteGrant.js";
import { CLOSE_NOT_GRANTED, serveComputerSocket, type RemoteSocket } from "./remoteServe.js";
import { RemoteComputerClient } from "./remoteClient.js";
import { ComputerError } from "./errors.js";
import type { ComputerClientLike } from "./run.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");

/** The helper writes its capture to a file and replies with the path, as both real helpers do. */
function helperShot(): Record<string, unknown> {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-remote-helper-")), "s-screenshot.png");
  fs.writeFileSync(file, PNG, { mode: 0o600 });
  return { path: file, format: "png", width: 1, height: 1, scale: 1 };
}

function fakeHelper(calls: string[], shot: () => Record<string, unknown> | null = helperShot): ComputerClientLike {
  const snap = (app: string) => ({ snapshot: { id: `s${calls.length}`, app: { name: app }, window: { title: "Untitled" }, treeText: "0 window Untitled" }, screenshot: shot(), screenshotStatus: { state: "captured" } });
  return {
    capabilities: async () => { calls.push("capabilities"); return { platform: "darwin" } as never; },
    listApps: async () => { calls.push("listApps"); return { apps: [{ name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 1 }] } as never; },
    listWindows: async () => { calls.push("listWindows"); return { windows: [] } as never; },
    getAppState: async (p) => { calls.push("getAppState"); return snap(String((p as { app: string }).app)) as never; },
    action: async (m, p) => {
      calls.push(m);
      if ((p as { app?: string }).app === "denied") throw new ComputerError("permission_denied", "Accessibility is not granted to the codecast computer helper");
      return { ...snap("x"), screenshot: null, action: { path: "accessibility" } } as never;
    },
    shutdown: () => { calls.push("shutdown"); },
  };
}

async function rig(opts: { granted?: boolean; browser?: boolean; shot?: () => Record<string, unknown> | null } = {}) {
  const codecast = isolateCodecastDir("cast-computer-remote-");
  cleanups.push(() => codecast.restore());
  const port = await freePort();
  const minted = newHostClient("i-1");
  let clients: HostClients = { "i-1": minted.record };
  const entry: { h: CloudHost } = { h: { id: "i-1", provider: "aws", region: "r", user: "u", keyPath: "/k", ...(opts.granted === false ? {} : { laptopComputer: newGrant({}) }), ...(opts.browser === false ? { laptopBrowser: false } : {}) } as CloudHost };
  const calls: string[] = [];
  const sockets: { sent: (string | Buffer)[] }[] = [];
  const lines: string[] = [];
  const host = await startBridgeHost({
    port, token: TEST_TOKEN, hostClients: () => clients,
    hostAllowsBrowser: (id) => id !== "i-1" || entry.h.laptopBrowser !== false,
    computer: (ws, caller) => {
      const seen = { sent: [] as (string | Buffer)[] };
      sockets.push(seen);
      const spy: RemoteSocket = {
        send: (d, o) => { seen.sent.push(d); ws.send(d, o); },
        close: (c, r) => ws.close(c, r),
        on: ((ev: string, fn: (...a: unknown[]) => void) => ws.on(ev, fn)) as RemoteSocket["on"],
      };
      serveComputerSocket(spy, { host: caller.host, session: caller.session, laptop: "mbp", hostEntry: () => (caller.tokenLive() ? entry.h : undefined), client: async () => fakeHelper(calls, opts.shot), log: (l) => lines.push(l), sweepMs: 50 });
    },
  });
  cleanups.push(() => host.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cast-remote-home-"));
  fs.mkdirSync(path.join(home, "laptop-links"));
  fs.writeFileSync(path.join(home, "laptop-links/dev1.json"), JSON.stringify({ v: 1, port, token: minted.token, hostId: "i-1", laptop: "mbp", linkedAt: Date.now(), device: "dev1" }));
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), "cast-remote-shots-"));
  const client = new RemoteComputerClient({ on: "laptop", session: "jx7aaaa", home, owner: null, screenshotDir: shots, requestTimeoutMs: 5_000 });
  cleanups.push(() => client.shutdown());
  return { port, client, calls, sockets, lines, entry, shots, minted, revokeToken: () => { clients = {}; } };
}

const refusal = async (p: Promise<unknown>) => {
  try { await p; } catch (err) { return err as ComputerError; }
  throw new Error("expected a refusal");
};

describe("cast computer --on laptop through the bridge", () => {
  test("without the grant every verb is refused, names what is missing, and never reaches the helper", async () => {
    const r = await rig({ granted: false });
    const err = await refusal(r.client.getAppState({ app: "com.apple.TextEdit" }));
    expect(err.code).toBe("remote_refused");
    expect(err.message).toContain("mbp has not let this host drive its apps");
    expect(err.message).toContain("cast computer remote grant --host i-1");
    expect(r.calls).toEqual([]);
  });

  test("with the grant it reads and acts over one socket, and the capture crosses as bytes, never base64", async () => {
    const r = await rig();
    const state = await r.client.getAppState({ app: "com.apple.TextEdit" });
    await r.client.action("setValue", { app: "com.apple.TextEdit", elementIndex: 3, value: "hi" });
    await r.client.listApps();
    await r.client.getAppState({ app: "com.apple.TextEdit" });
    expect(r.calls).toEqual(["getAppState", "setValue", "listApps", "getAppState"]);
    expect(r.sockets.length).toBe(1);
    const shot = state.screenshot as unknown as { path: string; bytes: number };
    expect(fs.readFileSync(shot.path).equals(PNG)).toBe(true);
    expect(fs.statSync(shot.path).mode & 0o777).toBe(0o600);
    expect(path.dirname(shot.path)).toBe(r.shots);
    expect(shot.bytes).toBe(PNG.length);
    const b64 = PNG.toString("base64");
    const text = r.sockets[0]!.sent.filter((d): d is string => typeof d === "string");
    expect(text.some((t) => t.includes(b64))).toBe(false);
    expect(r.sockets[0]!.sent.some((d) => Buffer.isBuffer(d))).toBe(true);
    expect(r.lines.some((l) => l.includes("[COMPUTER-REMOTE] i-1 session jx7aaaa setValue com.apple.TextEdit"))).toBe(true);
  });

  test("a helper that wrote its capture to a file has the file streamed and removed on the laptop", async () => {
    const laptopFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cast-remote-helper-")), "s-screenshot.png");
    const r = await rig({ shot: () => { fs.writeFileSync(laptopFile, PNG, { mode: 0o600 }); return { path: laptopFile, format: "png", width: 1, height: 1, scale: 2, bytes: PNG.length }; } });
    const state = await r.client.getAppState({ app: "com.apple.TextEdit" });
    const shot = state.screenshot as unknown as { path: string; scale: number };
    expect(fs.existsSync(laptopFile)).toBe(false);
    expect(shot.path).not.toBe(laptopFile);
    expect(fs.readFileSync(shot.path).equals(PNG)).toBe(true);
    expect(shot.scale).toBe(2);
  });

  test("a revoke binds on the next request and cuts the live socket off", async () => {
    const r = await rig();
    await r.client.listApps();
    delete r.entry.h.laptopComputer;
    const err = await refusal(r.client.listApps());
    expect(err.code).toBe("remote_refused");
    expect(r.calls).toEqual(["listApps"]);
    const again = await refusal(new Promise((_, reject) => setTimeout(() => r.client.listApps().catch(reject), 300)));
    expect(again.code).toBe("remote_refused");
  });

  test("a revoked key closes the socket too", async () => {
    const r = await rig();
    await r.client.listApps();
    r.revokeToken();
    const err = await refusal(r.client.listApps());
    expect(err.code).toBe("remote_refused");
  });

  test("the laptop's machine token and an unknown token are refused on the apps face", async () => {
    const r = await rig();
    for (const token of [TEST_TOKEN, "nope"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${r.port}/computer?token=${token}`);
      const code = await new Promise<number>((resolve) => ws.once("close", resolve));
      expect(code).toBe(CLOSE_BAD_TOKEN);
    }
  });

  test("a missing helper grant on the laptop is said as the laptop's, with the step that puts it on its screen", async () => {
    const r = await rig();
    const err = await refusal(r.client.action("click", { app: "denied" }));
    expect(err.code).toBe("remote_refused");
    expect(err.message).toContain("mbp's computer helper: Accessibility is not granted");
    expect(err.message).toContain("cast devices setup mbp computer --start");
  });

  test("a host whose Chrome was turned off keeps its apps, and its token reaches no Chrome route", async () => {
    const r = await rig({ browser: false });
    await r.client.listApps();
    const res = await fetch(`http://127.0.0.1:${r.port}/json/version?token=${r.minted.token}`);
    expect(res.status).toBe(403);
  });

  test("a closed socket code from the sweep reads as revoked", () => {
    expect(CLOSE_NOT_GRANTED).toBe(4403);
  });
});
