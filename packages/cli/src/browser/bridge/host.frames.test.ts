/**
 * Child sessions through the host (frameSessions.ts): cross-origin iframes
 * reached as their own CDP sessions, with a fake extension standing in for
 * Chrome's auto-attach.
 */

import { afterEach, expect, test } from "bun:test";
import { CdpConnection, type CdpEvent } from "../cdp.js";
import { FakeExtension, testBridgeHost } from "./host.testutil.js";
import { targetIdOfTab } from "./protocol.js";

let host: Awaited<ReturnType<typeof testBridgeHost>> | null = null;
afterEach(async () => {
  await host?.close();
  host = null;
});

const frameInfo = (url: string) => ({ targetId: "FRAME1", type: "iframe", url, title: "", attached: true, browserContextId: "REAL-CONTEXT" });
const settle = () => new Promise((r) => setTimeout(r, 80));

async function rig() {
  host = await testBridgeHost();
  const ext = await new FakeExtension([FakeExtension.tab(7, "https://shop.test/")]).connect(host.port);
  const conn = await CdpConnection.fromPort({ port: host.port, token: host.token });
  const events: CdpEvent[] = [];
  conn.on((ev) => void events.push(ev));
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true });
  return { ext, conn, events, root: sessionId };
}

test("a child Chrome reported is announced under the parent once auto-attach is on, with an id of the host's", async () => {
  const { ext, conn, events, root } = await rig();
  // Chrome reports the frame before the client asks: held, then replayed.
  ext.event(7, "Target.attachedToTarget", { sessionId: "CHROME-CHILD", targetInfo: frameInfo("https://pay.test/card"), waitingForDebugger: false });
  await settle();
  expect(events.some((e) => e.method === "Target.attachedToTarget" && e.sessionId === root)).toBe(false);

  expect(await conn.send<object>("Target.setAutoAttach", { autoAttach: true, flatten: true, waitForDebuggerOnStart: true }, root)).toEqual({});
  const att = events.find((e) => e.method === "Target.attachedToTarget" && e.sessionId === root)!;
  expect(att).toBeDefined();
  const child = String(att.params.sessionId);
  expect(child).not.toBe("CHROME-CHILD");
  expect(att.params).toMatchObject({ waitingForDebugger: false, targetInfo: { targetId: "FRAME1", url: "https://pay.test/card", browserContextId: "cast-real-chrome" } });

  // A command on the child goes to the extension with Chrome's id; the reply comes back on the client's.
  const r = await conn.send<any>("DOM.getDocument", { depth: 1 }, child);
  expect(r.echo).toEqual({ tabId: 7, method: "DOM.getDocument", params: { depth: 1 } });
  expect(ext.seen.find((m) => m.op === "cdp" && m.method === "DOM.getDocument")?.sessionId).toBe("CHROME-CHILD");
  expect(await conn.send<object>("Runtime.runIfWaitingForDebugger", {}, child)).toEqual({});

  // The child's events reach it under the client's id, and never the tab's session.
  ext.event(7, "Runtime.consoleAPICalled", { type: "log" }, "CHROME-CHILD");
  const ev = await conn.waitFor((e) => e.method === "Runtime.consoleAPICalled", 2000);
  expect(ev.sessionId).toBe(child);

  // Chrome's detach becomes the client's, on the parent's session; the id is dead after.
  ext.event(7, "Target.detachedFromTarget", { sessionId: "CHROME-CHILD", targetId: "FRAME1" });
  const det = await conn.waitFor((e) => e.method === "Target.detachedFromTarget", 2000);
  expect(det).toMatchObject({ sessionId: root, params: { sessionId: child, targetId: "FRAME1" } });
  await expect(conn.send("DOM.getDocument", {}, child)).rejects.toThrow(/Session with given id not found/);
  // Chrome's own ids never reached the client.
  expect(JSON.stringify(events)).not.toContain("CHROME-CHILD");
  conn.close();
});

test("a second client sees the frame under its own id, and only after it asks", async () => {
  const { ext, conn, root } = await rig();
  await conn.send("Target.setAutoAttach", { autoAttach: true, flatten: true }, root);
  const other = await CdpConnection.fromPort({ port: host!.port, token: host!.token });
  const otherEvents: CdpEvent[] = [];
  other.on((ev) => void otherEvents.push(ev));
  const otherRoot = (await other.send<{ sessionId: string }>("Target.attachToTarget", { targetId: targetIdOfTab(7), flatten: true })).sessionId;

  const mine = conn.waitFor((e) => e.method === "Target.attachedToTarget" && e.sessionId === root, 2000);
  ext.event(7, "Target.attachedToTarget", { sessionId: "CHROME-CHILD", targetInfo: frameInfo("https://pay.test/"), waitingForDebugger: false });
  const a = String((await mine).params.sessionId);
  await settle();
  expect(otherEvents.some((e) => e.method === "Target.attachedToTarget" && e.sessionId === otherRoot)).toBe(false);
  // The first client's child id means nothing on the second socket.
  await expect(other.send("DOM.getDocument", {}, a)).rejects.toThrow(/Session with given id not found/);

  await other.send("Target.setAutoAttach", { autoAttach: true, flatten: true }, otherRoot);
  const b = String(otherEvents.find((e) => e.method === "Target.attachedToTarget" && e.sessionId === otherRoot)!.params.sessionId);
  expect(b).not.toBe(a);
  conn.close();
  other.close();
});

test("a frame attached before its URL commits is admitted, host refusals bind its session, and a client lets go of it alone", async () => {
  const { ext, conn, root } = await rig();
  await conn.send("Target.setAutoAttach", { autoAttach: true, flatten: true }, root);
  // Attached before its URL committed: admitted, checked against where it lands.
  const att = conn.waitFor((e) => e.method === "Target.attachedToTarget" && e.sessionId === root, 2000);
  ext.event(7, "Target.attachedToTarget", { sessionId: "CHROME-CHILD", targetInfo: frameInfo(""), waitingForDebugger: false });
  const child = String((await att).params.sessionId);
  ext.event(7, "Page.frameNavigated", { frame: { id: "FRAME1", url: "file:///etc/passwd" } }, "CHROME-CHILD");
  await settle();
  // The method refusals every session gets bind a child's too.
  const nav = await conn.send<any>("Page.navigate", { url: "file:///etc/hosts" }, child).catch((e: Error) => e);
  expect(String(nav)).toMatch(/refuses Page.navigate/);

  await conn.send("Target.detachFromTarget", { sessionId: child });
  await expect(conn.send("DOM.getDocument", {}, child)).rejects.toThrow(/Session with given id not found/);
  // The tab's own session is untouched.
  expect((await conn.send<any>("DOM.getDocument", {}, root)).echo.tabId).toBe(7);
  conn.close();
});
