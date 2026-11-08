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
 *
 * The state file it writes is a real one, so the helper first points
 * CODECAST_DIR at a temp directory and restores it in `close()`. Without that
 * it overwrites the human's ~/.codecast/browser/bridge.json with the test
 * token, which unpairs their Chrome extension for good (ct-49576).
 */

import { WebSocket } from "ws";
import { isolateCodecastDir } from "../../test-helpers/codecastDir.js";
import { freePort } from "../instance.js";
import { startBridgeHost, writeBridgeState, type RunningHost } from "./host.js";
import { BRIDGE_PROTOCOL, bridgeProof, CLOSE_BAD_TOKEN, randomNonce, secretMatches, type BridgeTab } from "./protocol.js";
import { codeSession, hmacHex, normalizePairingCode, pairingCodeKey, profileKeyHash, xorHex } from "./pairing.js";

/** How a FakeExtension proves itself: the shared token (default), a profile's key, the token plus a key to migrate, or a one-time code. */
export type FakePairing =
  | { mode?: undefined }
  | { mode: "key"; key: string; secret: string }
  | { mode: "legacy"; key: string }
  | { mode: "code"; key: string; code: string };

export const TEST_TOKEN = "t".repeat(64);

export async function testBridgeHost(token = TEST_TOKEN): Promise<RunningHost & { token: string }> {
  const home = isolateCodecastDir("cast-bridge-test-");
  try {
    const port = await freePort();
    const host = await startBridgeHost({ port, token });
    writeBridgeState({ port, token });
    return {
      ...host,
      token,
      close: async () => {
        try {
          await host.close();
        } finally {
          home.restore();
        }
      },
    };
  } catch (e) {
    home.restore();
    throw e;
  }
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

  /** A scripted `cdp` result for a method; anything it leaves undefined is echoed. */
  cdpResult?: (method: string, params: any, tabId: number) => unknown;

  /** Answer the host's pings the way background.js does; off by default, which reads as a worker that stopped listening. */
  answersPings = false;

  constructor(tabs: BridgeTab[], readonly token = TEST_TOKEN) {
    this.tabs = tabs;
  }

  static tab(tabId: number, url = `https://example.com/${tabId}`, title = `Tab ${tabId}`): BridgeTab {
    return { tabId, url, title, active: false, windowId: 1, attached: false };
  }

  /** The key a pairing handed this fake (a code exchange or a migration), and the profile id the host named it. */
  issued?: { secret: string; profile?: string };

  /** Dial and handshake. Rejects when the host cannot prove it holds the token. */
  async connect(port: number, hello: Record<string, unknown> = {}, pairing: FakePairing = {}): Promise<this> {
    this.ws = await dial(port, "/ext", { origin: "chrome-extension://fakeextensionid" });
    const nonce = randomNonce();
    const next = () => new Promise<any>((resolve, reject) => {
      const onClose = (code: number) => reject(new Error(`closed ${code} before welcome`));
      this.ws.once("close", onClose);
      this.ws.once("message", (raw) => {
        this.ws.off("close", onClose);
        resolve(JSON.parse(String(raw)));
      });
    });
    const proofKey = pairing.mode === "key" ? profileKeyHash(pairing.secret) : this.token;
    let welcome = next();
    this.ws.send(
      JSON.stringify({
        op: "hello",
        nonce,
        ...(pairing.mode ? { mode: pairing.mode, key: pairing.key } : {}),
        ...(pairing.mode === "code" ? {} : { auth: bridgeProof(proofKey, "ext", nonce) }),
        version: "9.9.9",
        protocol: BRIDGE_PROTOCOL,
        userAgent: "FakeChrome/1",
        ...hello,
      }),
    );
    let session: string | null = null;
    if (pairing.mode === "code") {
      const challenge = await welcome;
      if (challenge.op !== "challenge") throw new Error(`expected a challenge, got ${challenge.op}`);
      session = codeSession(pairingCodeKey(normalizePairingCode(pairing.code) ?? pairing.code), port, nonce, challenge.nonce);
      welcome = next();
      this.ws.send(JSON.stringify({ op: "pair", proof: hmacHex(session, "ext") }));
    }
    const w = await welcome;
    const proven = w.op === "welcome" && (session ? secretMatches(hmacHex(session, "host"), w.proof) : secretMatches(bridgeProof(proofKey, "host", nonce), w.proof));
    if (!proven) {
      this.ws.close(CLOSE_BAD_TOKEN, "host could not prove the token");
      throw new Error("the host could not prove it holds the token");
    }
    if (typeof w.issue === "string") {
      const pad = session ? hmacHex(session, "wrap") : hmacHex(this.token, `issue:${nonce}`);
      this.issued = { secret: xorHex(w.issue, pad), profile: w.profile };
    }
    this.ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.op === "ping") {
        if (this.answersPings) this.ws.send(JSON.stringify({ op: "pong" }));
        return;
      }
      if (m.op === "pong") {
        this.seen.push(m);
        return;
      }
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
        case "tabs.activate":
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
          return reply({ result: this.cdpResult?.(m.method, m.params, m.tabId) ?? { echo: { tabId: m.tabId, method: m.method, params: m.params } } });
        default:
          return this.ws.send(JSON.stringify({ id: m.id, ok: false, error: "unknown op " + m.op }));
      }
    });
    return this;
  }

  /** A debugger event on a tab; `session` is Chrome's id of the child session (a cross-origin iframe) it came from. */
  event(tabId: number, method: string, params: any = {}, session?: string): void {
    this.ws.send(JSON.stringify({ op: "event", tabId, session, method, params }));
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
