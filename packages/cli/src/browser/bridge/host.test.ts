/**
 * Host tests: a fake extension on one side, real CDP clients (our own
 * CdpConnection, plus raw sockets) on the other. No Chrome involved — the
 * contract under test is authentication, the CDP emulation, event routing,
 * and honest failure when a side disappears.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { WebSocket, WebSocketServer } from "ws";
import { CdpConnection, CdpError, listTargets } from "../cdp.js";
import { freePort } from "../instance.js";
import { probeHost, startBridgeHost, type RunningHost } from "./host.js";
import { dial, FakeExtension, TEST_TOKEN as TOKEN } from "./host.testutil.js";
import { BRIDGE_PROTOCOL, bridgeProof, CLOSE_BAD_TOKEN, randomNonce, secretMatches, targetIdOfTab } from "./protocol.js";

let host: RunningHost | null = null;

async function freshHost(): Promise<RunningHost> {
  host = await startBridgeHost({ port: await freePort(), token: TOKEN });
  return host;
}

afterEach(async () => {
  await host?.close();
  host = null;
});

function closeCode(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("did not close within timeout")), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const cdpEndpoint = (port: number) => ({ port, token: TOKEN });

describe("bridge host auth", () => {
  test("rejects a missing or wrong token on every CDP socket path", async () => {
    const h = await freshHost();
    for (const path of ["/devtools/browser", `/devtools/browser/${"x".repeat(64)}`, `/devtools/browser?token=${"x".repeat(64)}`]) {
      const ws = new WebSocket(`ws://127.0.0.1:${h.port}${path}`);
      expect(await closeCode(ws)).toBe(CLOSE_BAD_TOKEN);
    }
  });

  test("an extension with the wrong token is closed with CLOSE_BAD_TOKEN, and never becomes the extension", async () => {
    const h = await freshHost();
    await expect(new FakeExtension([], "x".repeat(64)).connect(h.port)).rejects.toThrow(`closed ${CLOSE_BAD_TOKEN}`);
    expect(h.extensionConnected()).toBe(false);
    // The old protocol (token in the URL, a hello with no proof) is refused the same way.
    const old = await dial(h.port, `/ext?token=${TOKEN}`);
    old.send(JSON.stringify({ op: "hello", version: "0.0.1", protocol: 3 }));
    expect(await closeCode(old)).toBe(CLOSE_BAD_TOKEN);
    // So is a socket that opens and says something other than hello, or nothing that parses.
    const mute = await dial(h.port, "/ext");
    mute.send("not json");
    expect(await closeCode(mute)).toBe(CLOSE_BAD_TOKEN);
    expect(h.extensionConnected()).toBe(false);
  });

  test("a host that cannot prove the token is rejected by the extension before any op runs", async () => {
    // A squatter on the port: accepts /ext, answers the hello with a wrong
    // proof, then asks for a tab list. The extension must never answer it.
    const port = await freePort();
    const wss = new WebSocketServer({ port, host: "127.0.0.1" });
    const answered: string[] = [];
    wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.op === "hello") {
          ws.send(JSON.stringify({ op: "welcome", proof: "0".repeat(64) }));
          ws.send(JSON.stringify({ id: 1, op: "tabs.list" }));
        } else answered.push(String(raw));
      });
    });
    try {
      const ext = new FakeExtension([FakeExtension.tab(7)]);
      await expect(ext.connect(port)).rejects.toThrow(/could not prove/);
      await new Promise((r) => setTimeout(r, 100));
      expect(answered).toEqual([]);
      expect(ext.ws.readyState).not.toBe(WebSocket.OPEN);
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });

  test("/healthz proves the token to a nonce, and probeHost tells a host from a squatter", async () => {
    const h = await freshHost();
    const nonce = randomNonce();
    const body = await fetch(`http://127.0.0.1:${h.port}/healthz?nonce=${nonce}`).then((r) => r.text());
    expect(body).toBe(`cast-bridge protocol=${BRIDGE_PROTOCOL} proof=${bridgeProof(TOKEN, "healthz", nonce)}`);
    // A malformed nonce earns no proof at all; a proof is never minted over attacker-shaped input.
    expect(await fetch(`http://127.0.0.1:${h.port}/healthz?nonce=ext:abc`).then((r) => r.text())).toBe(`cast-bridge protocol=${BRIDGE_PROTOCOL}`);
    expect(await probeHost({ port: h.port, token: TOKEN })).toBe("alive");
    expect(await probeHost({ port: h.port, token: "x".repeat(64) })).toBe("impostor");
    expect(await probeHost({ port: await freePort(), token: TOKEN })).toBe("down");
  });

  test("rejects a correct token when the upgrade carries a web-page Origin", async () => {
    const h = await freshHost();
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/devtools/browser/${TOKEN}`, {
      headers: { origin: "https://evil.example" },
    });
    expect(await closeCode(ws)).toBe(CLOSE_BAD_TOKEN);
  });

  test("HTTP faces need the token AND a loopback Host (DNS rebinding)", async () => {
    const h = await freshHost();
    const noToken = await fetch(`http://127.0.0.1:${h.port}/json/version`);
    expect(noToken.status).toBe(403);
    const rebound = await fetch(`http://127.0.0.1:${h.port}/json/version?token=${TOKEN}`, {
      headers: { host: `evil.example:${h.port}` },
    });
    expect(rebound.status).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${h.port}/json/version?token=${TOKEN}`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.webSocketDebuggerUrl).toBe(`ws://127.0.0.1:${h.port}/devtools/browser/${TOKEN}`);
    // healthz stays open and says only our name.
    const hz = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(await hz.text()).toMatch(/^cast-bridge/);
  });
});

describe("bridge host as a CDP endpoint", () => {
  test("/json/list and Target.getTargets expose tabs as page targets with minted ids", async () => {
    const h = await freshHost();
    await new FakeExtension([FakeExtension.tab(7), FakeExtension.tab(8)]).connect(h.port);
    const listed = await listTargets(cdpEndpoint(h.port));
    expect(listed.map((t) => t.targetId)).toEqual([targetIdOfTab(7), targetIdOfTab(8)]);
    expect(listed[0].url).toBe("https://example.com/7");

    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const { targetInfos } = await conn.send("Target.getTargets");
    expect(targetInfos.map((t: any) => t.targetId)).toEqual([targetIdOfTab(7), targetIdOfTab(8)]);
    const ver = await conn.send("Browser.getVersion");
    expect(ver.userAgent).toBe("FakeChrome/1");
    conn.close();
  });

  test("attach → session-scoped commands reach chrome.debugger for that tab; replies route back", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7)]).connect(h.port);
    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));

    const attachedEv = conn.waitFor((ev) => ev.method === "Target.attachedToTarget", 3000);
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
    expect(sessionId).toMatch(/^[0-9A-F]{32}$/);
    expect((await attachedEv).params.sessionId).toBe(sessionId);
    expect(ext.attached.has(7)).toBe(true);

    const r = await conn.send("DOM.getDocument", { depth: 1 }, sessionId);
    expect(r.echo).toEqual({ tabId: 7, method: "DOM.getDocument", params: { depth: 1 } });

    // Local no-ops the engines send during setup.
    expect(await conn.send<object>("Target.setAutoAttach", { autoAttach: true, flatten: true }, sessionId)).toEqual({});
    expect(await conn.send<object>("Runtime.runIfWaitingForDebugger", {}, sessionId)).toEqual({});

    // Extension-side failures come back as CDP errors, not hangs.
    await expect(conn.send("Boom.now", {}, sessionId)).rejects.toBeInstanceOf(CdpError);
    // Unknown browser-scope methods get Chrome's not-found code.
    await expect(conn.send("Nope.nothing")).rejects.toThrow(/wasn't found/);
    // A made-up session is refused.
    await expect(conn.send("Runtime.evaluate", { expression: "1" }, "F".repeat(32))).rejects.toThrow(/Session with given id/);
    conn.close();
  });

  test("events reach only sessions bound to that tab, stamped with each client's own sessionId", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7), FakeExtension.tab(8)]).connect(h.port);
    const a = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const b = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const sa = (await a.send("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true })).sessionId;
    const sb = (await b.send("Target.attachToTarget", { targetId: targetIdOfTab(8), flatten: true })).sessionId;

    const gotA = a.waitFor((ev) => ev.method === "Network.loadingFinished", 2000);
    let bGotIt = false;
    const offB = b.on((ev) => {
      if (ev.method === "Network.loadingFinished") bGotIt = true;
    });
    ext.event(7, "Network.loadingFinished", { requestId: "r1" });
    const ev = await gotA;
    expect(ev.sessionId).toBe(sa);
    expect(sb).not.toBe(sa);
    await new Promise((r) => setTimeout(r, 100));
    expect(bGotIt).toBe(false);
    offB();
    a.close();
    b.close();
  });

  test("a tab is released to the human only when its last session lets go", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7)]).connect(h.port);
    const a = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const b = await CdpConnection.fromPort(cdpEndpoint(h.port));
    await a.send("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
    await b.send("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
    expect(ext.seen.filter((m) => m.op === "attach").length).toBe(2);

    a.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(ext.seen.some((m) => m.op === "detach")).toBe(false);
    expect(ext.attached.has(7)).toBe(true);

    b.close();
    await ext.waitFor("detach");
    expect(ext.attached.has(7)).toBe(false);
  });

  test("createTarget / closeTarget go through the extension and mint/retire ids", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([]).connect(h.port);
    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const { targetId } = await conn.send("Target.createTarget", { url: "https://new.example/" });
    expect(targetId).toBe(targetIdOfTab(100));
    expect(ext.tabs[0].url).toBe("https://new.example/");
    await conn.send("Target.closeTarget", { targetId });
    expect(ext.tabs.length).toBe(0);
    conn.close();
  });

  test("createTarget forwards background and castGroup, and strips castGroup from what the client sees", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([]).connect(h.port);
    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const group = { title: "cast smoke", color: "blue" };
    const created = await conn.send("Target.createTarget", { url: "https://a.example/", background: true, castGroup: group });
    expect(Object.keys(created)).toEqual(["targetId"]);
    const sent = ext.seen.find((m) => m.op === "tabs.create");
    expect(sent).toEqual({ id: sent.id, op: "tabs.create", url: "https://a.example/", background: true, group });
    expect("castGroup" in sent).toBe(false);

    // Neither the target list nor the HTTP face mention a group.
    const { targetInfos } = await conn.send("Target.getTargets");
    expect(targetInfos.length).toBe(1);
    expect("group" in targetInfos[0]).toBe(false);
    expect("castGroup" in targetInfos[0]).toBe(false);
    const listed = await listTargets(cdpEndpoint(h.port));
    expect("group" in (listed[0] as any)).toBe(false);

    // A plain create is foreground, ungrouped from the extension's point of view of a new socket.
    const other = await CdpConnection.fromPort(cdpEndpoint(h.port));
    await other.send("Target.createTarget", { url: "https://b.example/" });
    const plain = ext.seen.filter((m) => m.op === "tabs.create")[1];
    expect(plain.background).toBe(false);
    expect("group" in plain).toBe(false);
    // A malformed castGroup is ignored rather than forwarded.
    await other.send("Target.createTarget", { url: "https://c.example/", castGroup: { title: "", color: "red" } });
    expect("group" in ext.seen.filter((m) => m.op === "tabs.create")[2]).toBe(false);
    conn.close();
    other.close();
  });

  test("a socket that created a grouped tab, or attached to one, puts its later creates in that group", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7)]).connect(h.port);
    const a = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const b = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const group = { title: "session one", color: "green" };
    const creates = () => ext.seen.filter((m) => m.op === "tabs.create");

    // A remembers the group across creates on the same socket.
    const first = await a.send("Target.createTarget", { url: "https://a1.example/", castGroup: group });
    await a.send("Target.createTarget", { url: "https://a2.example/" });
    expect(creates().map((m) => m.group)).toEqual([group, group]);

    // B is a different socket: nothing remembered for it.
    await b.send("Target.createTarget", { url: "https://b1.example/" });
    expect("group" in creates()[2]).toBe(false);

    // B attaches to one of A's grouped tabs and adopts the group.
    await b.send("Target.attachToTarget", { targetId: first.targetId, flatten: true });
    await b.send("Target.createTarget", { url: "https://b2.example/" });
    expect(creates()[3].group).toEqual(group);

    // Attaching to an ungrouped tab afterwards does not forget the group.
    await b.send("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
    await b.send("Target.createTarget", { url: "https://b3.example/" });
    expect(creates()[4].group).toEqual(group);

    // An explicit castGroup on a later create switches the socket to that group.
    const second = { title: "session two", color: "red" };
    await a.send("Target.createTarget", { url: "https://a3.example/", castGroup: second });
    await a.send("Target.createTarget", { url: "https://a4.example/" });
    expect(creates().slice(5).map((m) => m.group)).toEqual([second, second]);

    // The group is per socket, so a fresh connection starts clean.
    a.close();
    const a2 = await CdpConnection.fromPort(cdpEndpoint(h.port));
    await a2.send("Target.createTarget", { url: "https://a5.example/" });
    expect("group" in creates()[7]).toBe(false);
    a2.close();
    b.close();
  });

  test("setDiscoverTargets replays existing targets and streams tab changes", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7)]).connect(h.port);
    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const created: string[] = [];
    conn.on((ev) => {
      if (ev.method === "Target.targetCreated") created.push((ev.params as any).targetInfo.targetId);
    });
    await conn.send("Target.setDiscoverTargets", { discover: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toEqual([targetIdOfTab(7)]);

    const destroyed = conn.waitFor((ev) => ev.method === "Target.targetDestroyed", 2000);
    ext.tabEvent("created", FakeExtension.tab(9));
    ext.tabEvent("removed", FakeExtension.tab(9));
    expect(((await destroyed).params as any).targetId).toBe(targetIdOfTab(9));
    expect(created).toEqual([targetIdOfTab(7), targetIdOfTab(9)]);
    conn.close();
  });

  test("the extension vanishing fails in-flight calls and detaches every session", async () => {
    const h = await freshHost();
    const ext = await new FakeExtension([FakeExtension.tab(7)]).connect(h.port);
    const conn = await CdpConnection.fromPort(cdpEndpoint(h.port));
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
    const detached = conn.waitFor((ev) => ev.method === "Target.detachedFromTarget", 3000);
    // Extension goes away before answering.
    ext.ws.removeAllListeners("message");
    const inflight = conn.send("Runtime.evaluate", { expression: "1" }, sessionId, 3000);
    await new Promise((r) => setTimeout(r, 30));
    ext.ws.close();
    await expect(inflight).rejects.toThrow(/disconnected/);
    expect((await detached).params.sessionId).toBe(sessionId);
    // And with no extension, new calls fail fast with the setup hint.
    await expect(conn.send("Target.getTargets")).rejects.toThrow(/extension is not connected/);
    conn.close();
  });

  test("a newer PROVEN extension connection replaces the old one; an unproven one cannot", async () => {
    const h = await freshHost();
    const ext1 = await new FakeExtension([]).connect(h.port);
    const replaced = closeCode(ext1.ws);
    // A socket that never proves itself does not displace the real extension.
    const squatter = await dial(h.port, "/ext");
    await new Promise((r) => setTimeout(r, 50));
    expect(h.extensionConnected()).toBe(true);
    expect(ext1.ws.readyState).toBe(WebSocket.OPEN);
    squatter.close();
    const ext2 = await new FakeExtension([]).connect(h.port);
    expect(await replaced).toBe(1000);
    expect(h.extensionConnected()).toBe(true);
    ext2.ws.close();
  });
});
