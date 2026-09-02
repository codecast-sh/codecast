/**
 * Test doubles for the bridge, shared by host.test.ts, engineReap.test.ts and
 * pinnedTab.test.ts.
 *
 * `testBridgeHost` is a PROVEN host: the pinned tab, the reaper and the engine
 * options all refuse a port that cannot answer the token challenge (host.ts
 * probeHost), so a written bridge.json alone is no longer a reachable bridge.
 * It writes the state file the code under test reads.
 *
 * `FakeExtension` is a scripted stand-in for background.js on the other side
 * of that host, so a test can watch what reaches "Chrome" without a Chrome.
 */

import { WebSocket } from "ws";
import { freePort } from "../instance.js";
import { startBridgeHost, writeBridgeState, type RunningHost } from "./host.js";
import { BRIDGE_PROTOCOL, bridgeProof, CLOSE_BAD_TOKEN, randomNonce, secretMatches, type BridgeTab } from "./protocol.js";

export const TEST_TOKEN = "t".repeat(64);

export async function testBridgeHost(token = TEST_TOKEN): Promise<RunningHost & { token: string }> {
  const port = await freePort();
  const host = await startBridgeHost({ port, token });
  writeBridgeState({ port, token });
  return { ...host, token };
}

export function dial(port: number, path: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/**
 * A scripted stand-in for the extension. Performs the mutual handshake the
 * way background.js does (hello with a nonce and its auth, then refuses to
 * do anything for a host whose welcome proof is wrong), answers tabs.list
 * from `tabs`, records attach/detach, keeps the group a tab was created
 * with, and echoes cdp calls as `{echo: {tabId, method, params}}`.
 */
export class FakeExtension {
  ws!: WebSocket;
  tabs: BridgeTab[];
  attached = new Set<number>();
  seen: any[] = [];
  private nextTab = 100;

  constructor(tabs: BridgeTab[], readonly token = TEST_TOKEN) {
    this.tabs = tabs;
  }

  static tab(tabId: number, url = `https://example.com/${tabId}`, title = `Tab ${tabId}`): BridgeTab {
    return { tabId, url, title, active: false, windowId: 1, attached: false };
  }

  /** Dial and handshake. Rejects when the host cannot prove it holds the token. */
  async connect(port: number): Promise<this> {
    this.ws = await dial(port, "/ext", { origin: "chrome-extension://fakeextensionid" });
    const nonce = randomNonce();
    const welcome = new Promise<any>((resolve, reject) => {
      this.ws.once("message", (raw) => resolve(JSON.parse(String(raw))));
      this.ws.once("close", (code) => reject(new Error(`closed ${code} before welcome`)));
    });
    this.ws.send(
      JSON.stringify({
        op: "hello",
        nonce,
        auth: bridgeProof(this.token, "ext", nonce),
        version: "9.9.9",
        protocol: BRIDGE_PROTOCOL,
        userAgent: "FakeChrome/1",
      }),
    );
    const w = await welcome;
    if (w.op !== "welcome" || !secretMatches(bridgeProof(this.token, "host", nonce), w.proof)) {
      this.ws.close(CLOSE_BAD_TOKEN, "host could not prove the token");
      throw new Error("the host could not prove it holds the token");
    }
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.op === "ping") return;
      this.seen.push(m);
      const reply = (extra: any) => this.ws.send(JSON.stringify({ id: m.id, ok: true, ...extra }));
      switch (m.op) {
        case "tabs.list":
          return reply({ tabs: this.tabs.map((t) => ({ ...t, attached: this.attached.has(t.tabId) })) });
        case "tabs.create": {
          const t = { ...FakeExtension.tab(this.nextTab++, m.url, "new"), active: !m.background, ...(m.group ? { group: m.group } : {}) };
          this.tabs.push(t);
          return reply({ tabId: t.tabId });
        }
        case "tabs.close":
          this.tabs = this.tabs.filter((t) => t.tabId !== m.tabId);
          return reply({});
        case "attach":
          this.attached.add(m.tabId);
          return reply({});
        case "detach":
          this.attached.delete(m.tabId);
          return reply({});
        case "cdp":
          if (m.method === "Boom.now") {
            return this.ws.send(JSON.stringify({ id: m.id, ok: false, error: "kaboom from chrome.debugger" }));
          }
          return reply({ result: { echo: { tabId: m.tabId, method: m.method, params: m.params } } });
        default:
          return this.ws.send(JSON.stringify({ id: m.id, ok: false, error: "unknown op " + m.op }));
      }
    });
    return this;
  }

  event(tabId: number, method: string, params: any = {}): void {
    this.ws.send(JSON.stringify({ op: "event", tabId, method, params }));
  }

  tabEvent(kind: "created" | "removed" | "updated", tab: BridgeTab): void {
    this.ws.send(JSON.stringify({ op: "tab", kind, tab }));
  }

  /** Wait until the host has asked for `op` at least `n` times. */
  async waitFor(op: string, n = 1, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.seen.filter((m) => m.op === op).length < n) {
      if (Date.now() > deadline) throw new Error(`extension never saw ${op} x${n}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
}
