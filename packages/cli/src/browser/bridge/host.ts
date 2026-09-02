/**
 * The bridge host: a loopback server that presents the user's REAL Chrome as
 * an ordinary Chrome DevTools endpoint, with the cast extension doing the
 * actual driving through chrome.debugger.
 *
 * Why this process exists at all: the extension must connect OUT (an extension
 * cannot listen), and each `cast browser` invocation is a fresh process that
 * exits in seconds — so something long-lived has to hold the extension's
 * socket. That is this.
 *
 * Why it speaks CDP to clients instead of a protocol of its own: measured
 * against both our built-in driver and agent-browser (`--cdp`), a CDP client
 * needs five browser-scope methods — Browser.getVersion, Target.getTargets,
 * Target.setDiscoverTargets, Target.attachToTarget, Target.createTarget — and
 * everything else is tab-scoped, which is exactly what chrome.debugger offers.
 * Emulating those five means every engine drives the real Chrome unchanged,
 * and this host never needs to learn a verb.
 *
 * Why WebSocket and not Chrome native messaging: native messaging inverts the
 * lifecycle (Chrome spawns and owns the host), needs an OS-level manifest
 * naming the extension's ID installed per user in a browser-specific
 * directory, and still leaves N short-lived CLI processes needing a local
 * socket to share one connection. A WS server is
 * that socket with one moving part fewer, and an open WebSocket keeps the MV3
 * service worker alive (Chrome 116+).
 *
 * Tab groups are the one thing added on top of CDP. `Target.createTarget`
 * takes two extra params: `background` (open without activating, which the
 * extension maps to `active: false`) and `castGroup` ({title, color}), which
 * puts the tab in a Chrome tab group so a session's tabs sit together and
 * the extension has a title to animate while it works. The group is per
 * client socket: once a client creates a grouped tab, or attaches to one,
 * every later `Target.createTarget` from that socket with no `castGroup`
 * lands in the same group. `castGroup` never reaches a client: replies and
 * target infos carry only what real Chrome would send.
 *
 * Threat model. Loopback is reachable by every local process and by JavaScript
 * on any web page. Against pages: the token lives in a 0600 file a page cannot
 * read, an upgrade carrying an http(s) Origin is refused before the token is
 * even checked (pages always send one; the extension sends chrome-extension://
 * and the CLI none), and the HTTP face rejects any Host other than loopback,
 * which is what defeats DNS rebinding. Against other local users: the token,
 * and the fact that it never crosses the wire in the clear on the extension
 * face. Any local account can bind this port while no host is running (after
 * a reboot, a crash, `extension revoke`), so nothing trusts a server for
 * answering: the extension and the host prove the token to each other with
 * HMACs over fresh nonces (protocol.ts bridgeProof), and the CLI demands the
 * same proof from /healthz before it presents the token anywhere. A group is
 * a grouping hint and nothing more: it grants no access to the tabs already
 * in it, and every tab still needs its own attach.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "../../proc.js";
import { isPidAlive } from "../../workspace/chrome.js";
import { browserHome } from "../profile.js";
import type { CdpEndpoint } from "../cdp.js";
import {
  BRIDGE_DEFAULT_PORT, BRIDGE_PROTOCOL, bridgeProof, CLOSE_BAD_TOKEN, isNonce, randomNonce, secretMatches, tabIdOfTarget,
  targetIdOfTab, type BridgeGroup, type BridgeReply, type BridgeTab,
} from "./protocol.js";

// ---------------------------------------------------------------------------
// Config and lifecycle (used by the CLI)
// ---------------------------------------------------------------------------

export interface BridgeState {
  port: number;
  token: string;
  hostPid?: number;
  startedAt?: number;
}

export function bridgeStatePath(): string {
  return path.join(browserHome(), "bridge.json");
}

export function readBridgeState(): BridgeState | null {
  try {
    return JSON.parse(fs.readFileSync(bridgeStatePath(), "utf-8")) as BridgeState;
  } catch {
    return null;
  }
}

/** Atomic for the same reason as instance.json: concurrent CLI readers. */
export function writeBridgeState(state: BridgeState): void {
  fs.mkdirSync(browserHome(), { recursive: true, mode: 0o700 });
  const tmp = `${bridgeStatePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, bridgeStatePath());
}

function defaultPort(): number {
  const env = parseInt(process.env.CAST_BRIDGE_PORT ?? "", 10);
  return Number.isFinite(env) && env > 0 ? env : BRIDGE_DEFAULT_PORT;
}

/** Create the token+port config on first use; never regenerates an existing token. */
export function ensureBridgeConfig(): BridgeState {
  const existing = readBridgeState();
  if (existing?.token) return existing;
  const state: BridgeState = {
    port: existing?.port ?? defaultPort(),
    token: crypto.randomBytes(32).toString("hex"),
  };
  writeBridgeState({ ...existing, ...state });
  return state;
}

/** Replace the token. Every holder of the old one is locked out on next connect. */
export function rotateBridgeToken(): BridgeState {
  const state = ensureBridgeConfig();
  const next = { ...state, token: crypto.randomBytes(32).toString("hex") };
  writeBridgeState(next);
  return next;
}

/**
 * A bridge config whose host has just proved it holds the token (probeHost).
 * Everything that presents the token to the port takes this type, so the
 * compiler makes "verify before you present" impossible to skip: a squatter
 * on the port never sees the token, only a nonce it cannot answer.
 */
export type ProvenBridge = BridgeState & { readonly proven: true };

/** The CDP HTTP face of the bridge, for listTargets/CdpConnection.fromPort. */
export function bridgeEndpoint(state: ProvenBridge): CdpEndpoint {
  return { port: state.port, token: state.token };
}

/** The browser-level CDP socket, for any client that takes a URL (agent-browser's cdp option). */
export function bridgeWsUrl(state: ProvenBridge): string {
  return `ws://127.0.0.1:${state.port}/devtools/browser/${state.token}`;
}

export type HostProbe = "alive" | "impostor" | "down";

/**
 * What answers on the bridge port: a host that proved it holds our token, a
 * server that answers like one but cannot prove it, or nothing. No token
 * leaves this process: the host is challenged with a nonce and must return
 * HMAC(token, "healthz:" + nonce).
 */
export async function probeHost(state: Pick<BridgeState, "port" | "token">, timeoutMs = 1200): Promise<HostProbe> {
  const nonce = randomNonce();
  let body: string;
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/healthz?nonce=${nonce}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return "down";
    body = await res.text();
  } catch {
    return "down";
  }
  if (!body.startsWith("cast-bridge")) return "down";
  const proof = /\bproof=([0-9a-f]{64})\b/.exec(body)?.[1];
  return secretMatches(bridgeProof(state.token, "healthz", nonce), proof) ? "alive" : "impostor";
}

/** Is OUR bridge host answering on this port? */
export async function isHostAlive(state: Pick<BridgeState, "port" | "token">, timeoutMs = 1200): Promise<boolean> {
  return (await probeHost(state, timeoutMs)) === "alive";
}

/** The config as a proven host, or the reason the port cannot be trusted. */
export async function proveBridgeHost(state: BridgeState, timeoutMs = 1200): Promise<ProvenBridge> {
  const probe = await probeHost(state, timeoutMs);
  if (probe === "alive") return { ...state, proven: true };
  throw new Error(
    probe === "impostor"
      ? `something on 127.0.0.1:${state.port} answers like a bridge host but cannot prove it holds the token — ` +
          `stop it, or set CAST_BRIDGE_PORT to move the bridge`
      : `no bridge host is answering on 127.0.0.1:${state.port}`,
  );
}

/**
 * Make sure a host is running, starting one detached if not. Mirrors the
 * managed browser's auto-start: callers should not have to know the host is a
 * separate process. An impostor on the port is named rather than raced: a
 * host we start could not bind anyway.
 */
export async function ensureBridgeHost(): Promise<ProvenBridge> {
  const state = ensureBridgeConfig();
  const probe = await probeHost(state);
  if (probe === "alive") return { ...state, proven: true };
  if (probe === "impostor") return proveBridgeHost(state);

  // Respawn ourselves. Under bun/node the entry script must be repeated;
  // in the compiled binary process.execPath IS the cast binary.
  const base = path.basename(process.execPath).toLowerCase();
  const viaRuntime = base.includes("bun") || base.includes("node");
  const args = viaRuntime ? [process.argv[1], "browser", "bridge-host"] : ["browser", "bridge-host"];
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await isHostAlive(state, 500)) return { ...(readBridgeState() ?? state), proven: true };
    await sleep(150);
  }
  throw new Error(
    `the bridge host did not come up on 127.0.0.1:${state.port} — ` +
      `is another process on that port? Set CAST_BRIDGE_PORT to move it.`,
  );
}

export function stopBridgeHost(): boolean {
  const state = readBridgeState();
  if (!state?.hostPid || !isPidAlive(state.hostPid)) return false;
  try {
    process.kill(state.hostPid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** Ask a running host whether the extension is connected. */
export async function bridgeStatus(state: ProvenBridge): Promise<{
  extensionConnected: boolean;
  extensionVersion?: string;
  extensionProtocol?: number;
}> {
  const res = await fetch(`http://127.0.0.1:${state.port}/status?token=${encodeURIComponent(state.token)}`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`bridge host answered ${res.status} — token mismatch? re-run \`cast browser extension setup\``);
  return (await res.json()) as any;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface RunningHost {
  port: number;
  close(): Promise<void>;
  extensionConnected(): boolean;
}

/** One CDP client (a `cast` process, an agent-browser daemon…). */
interface Client {
  ws: WebSocket;
  /** sessionId → tabId for the tabs this client has attached. */
  sessions: Map<string, number>;
  discover: boolean;
  /** The group of the last tab this client created with one or attached to; later creates join it. */
  group: BridgeGroup | null;
}

interface PendingExt {
  resolve: (r: BridgeReply) => void;
  reject: (e: Error) => void;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** How long a fresh extension socket may stay silent before its hello is due. */
const HELLO_TIMEOUT_MS = 5_000;

/** `castGroup` as a client may send it; anything else is treated as absent. */
function parseGroup(raw: unknown): BridgeGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const { title, color } = raw as Record<string, unknown>;
  if (typeof title !== "string" || !title.trim() || typeof color !== "string") return null;
  return { title, color: color as BridgeGroup["color"] };
}

/** CDP-shaped error reply. -32601 is what Chrome uses for an unknown method. */
function cdpError(id: number, message: string, code = -32000) {
  return { id, error: { code, message } };
}

/**
 * Start the server in-process. `runBridgeHost` (the CLI entry) wraps this
 * with state-file bookkeeping and signal handling; tests call it directly.
 */
export function startBridgeHost(opts: { port: number; token: string }): Promise<RunningHost> {
  const { port, token } = opts;

  let ext: WebSocket | null = null;
  let extMeta: { version?: string; protocol?: number; userAgent?: string } = {};
  let nextExtId = 1;
  const extPending = new Map<number, PendingExt>();
  const clients = new Set<Client>();

  const sendJson = (ws: WebSocket, msg: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // ------------------------------------------------------------ extension

  const extRequest = (op: string, payload: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<BridgeReply> => {
    if (!ext || ext.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new Error(
          "the cast bridge extension is not connected — open the extension's options in Chrome " +
            "and check the token and port (`cast browser extension setup` prints them)",
        ),
      );
    }
    return new Promise((resolve, reject) => {
      const id = nextExtId++;
      const timer = setTimeout(() => {
        extPending.delete(id);
        reject(new Error(`${op} did not answer within ${timeoutMs}ms (extension busy or its service worker asleep)`));
      }, timeoutMs);
      extPending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      sendJson(ext!, { id, op, ...payload });
    });
  };

  const extCall = async (op: string, payload: Record<string, unknown> = {}, timeoutMs?: number): Promise<BridgeReply> => {
    const r = await extRequest(op, payload, timeoutMs);
    if (!r.ok) throw new Error(String(r.error ?? `${op} failed`));
    return r;
  };

  const listTabs = async (): Promise<BridgeTab[]> => (await extCall("tabs.list", {}, 10_000)).tabs as BridgeTab[];

  // Ids by which a tab is known to CDP clients. Sessions attach by tabId; a
  // tab is released to the human (debugger detached, banner gone) only when
  // the last session anywhere lets go of it.
  const holders = (tabId: number): number => {
    let n = 0;
    for (const c of clients) for (const t of c.sessions.values()) if (t === tabId) n++;
    return n;
  };
  const release = (tabId: number): void => {
    if (holders(tabId) === 0) extRequest("detach", { tabId }, 10_000).catch(() => {});
  };

  const targetInfo = (t: BridgeTab) => ({
    targetId: targetIdOfTab(t.tabId),
    type: "page",
    title: t.title,
    url: t.url,
    attached: t.attached,
    canAccessOpener: false,
    browserContextId: "cast-real-chrome",
  });

  const failAllClients = (reason: string): void => {
    for (const c of clients) {
      for (const [sessionId, tabId] of c.sessions) {
        sendJson(c.ws, { method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOfTab(tabId), reason } });
      }
      c.sessions.clear();
    }
  };

  /** Drop every session bound to a tab (it closed, or the user cancelled). */
  const dropTab = (tabId: number, reason: string): void => {
    for (const c of clients) {
      for (const [sessionId, t] of [...c.sessions]) {
        if (t !== tabId) continue;
        c.sessions.delete(sessionId);
        sendJson(c.ws, { method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOfTab(tabId), reason } });
      }
    }
  };

  const onExtMessage = (raw: string): void => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && extPending.has(msg.id)) {
      const p = extPending.get(msg.id)!;
      extPending.delete(msg.id);
      p.resolve(msg as BridgeReply);
      return;
    }
    switch (msg.op) {
      case "pong":
        return;
      case "event": {
        // Fan out to every session bound to that tab, stamped with ITS id.
        for (const c of clients) {
          for (const [sessionId, tabId] of c.sessions) {
            if (tabId === msg.tabId) sendJson(c.ws, { method: msg.method, params: msg.params ?? {}, sessionId });
          }
        }
        return;
      }
      case "tab": {
        const t = msg.tab as BridgeTab;
        if (msg.kind === "removed") dropTab(t.tabId, "target closed");
        for (const c of clients) {
          if (!c.discover) continue;
          if (msg.kind === "created") sendJson(c.ws, { method: "Target.targetCreated", params: { targetInfo: targetInfo(t) } });
          else if (msg.kind === "removed") sendJson(c.ws, { method: "Target.targetDestroyed", params: { targetId: targetIdOfTab(t.tabId) } });
          else sendJson(c.ws, { method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(t) } });
        }
        return;
      }
      case "detached":
        dropTab(msg.tabId, "the user cancelled the debugging banner in Chrome");
        return;
    }
  };

  // --------------------------------------------------------------- clients

  /** Browser-scope CDP, emulated. Returns the `result` or throws. */
  const browserMethod = async (client: Client, method: string, params: any): Promise<unknown> => {
    switch (method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: `Chrome (cast bridge, extension ${extMeta.version ?? "?"})`,
          revision: "",
          userAgent: extMeta.userAgent ?? "",
          jsVersion: "",
        };
      case "Target.getTargets":
        return { targetInfos: (await listTabs()).map(targetInfo) };
      case "Target.setDiscoverTargets": {
        const on = !!params?.discover;
        if (on && !client.discover) {
          // Chrome replays the existing targets on enable; clients rely on it.
          for (const t of await listTabs()) {
            sendJson(client.ws, { method: "Target.targetCreated", params: { targetInfo: targetInfo(t) } });
          }
        }
        client.discover = on;
        return {};
      }
      case "Target.getTargetInfo": {
        const tabId = tabIdOfTarget(String(params?.targetId ?? ""));
        const t = (await listTabs()).find((x) => x.tabId === tabId);
        if (!t) throw new Error("No target with given id found");
        return { targetInfo: targetInfo(t) };
      }
      case "Target.attachToTarget": {
        const tabId = tabIdOfTarget(String(params?.targetId ?? ""));
        if (tabId === null) throw new Error("No target with given id found");
        await extCall("attach", { tabId }, 20_000);
        const sessionId = crypto.randomBytes(16).toString("hex").toUpperCase();
        client.sessions.set(sessionId, tabId);
        const t = (await listTabs()).find((x) => x.tabId === tabId);
        // Attaching to a grouped tab adopts its group; an ungrouped tab (a
        // human's tab named with --tab) leaves the session's group alone.
        if (t?.group) client.group = t.group;
        sendJson(client.ws, {
          method: "Target.attachedToTarget",
          params: {
            sessionId,
            targetInfo: t ? targetInfo(t) : { targetId: targetIdOfTab(tabId), type: "page", title: "", url: "", attached: true },
            waitingForDebugger: false,
          },
        });
        return { sessionId };
      }
      case "Target.detachFromTarget": {
        const sessionId = String(params?.sessionId ?? "");
        const tabId = client.sessions.get(sessionId);
        if (tabId === undefined) throw new Error("No session with given id");
        client.sessions.delete(sessionId);
        sendJson(client.ws, { method: "Target.detachedFromTarget", params: { sessionId, targetId: targetIdOfTab(tabId) } });
        release(tabId);
        return {};
      }
      case "Target.createTarget": {
        const group = parseGroup(params?.castGroup) ?? client.group;
        const r = await extCall(
          "tabs.create",
          { url: params?.url || "about:blank", background: !!params?.background, ...(group ? { group } : {}) },
          15_000,
        );
        if (group) client.group = group;
        return { targetId: targetIdOfTab(r.tabId as number) };
      }
      case "Target.closeTarget": {
        const tabId = tabIdOfTarget(String(params?.targetId ?? ""));
        if (tabId === null) throw new Error("No target with given id found");
        dropTab(tabId, "target closed");
        await extCall("tabs.close", { tabId }, 10_000);
        return { success: true };
      }
      case "Target.activateTarget": {
        const tabId = tabIdOfTarget(String(params?.targetId ?? ""));
        if (tabId === null) throw new Error("No target with given id found");
        await extCall("tabs.activate", { tabId }, 10_000);
        return {};
      }
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      // Harmless to accept: clients call these during setup and only need a yes.
      case "Target.setAutoAttach":
      case "Browser.setDownloadBehavior":
      case "Security.setIgnoreCertificateErrors":
        return {};
      default:
        throw Object.assign(new Error(`'${method}' wasn't found`), { code: -32601 });
    }
  };

  /** Session-scope CDP: a couple of local no-ops, everything else to the tab. */
  const sessionMethod = async (tabId: number, method: string, params: any): Promise<unknown> => {
    switch (method) {
      // chrome.debugger cannot mint child sessions for a client it does not
      // know about, so pretend and never emit child attaches. Cross-origin
      // frames stay reachable through Accessibility/DOM in the main session.
      case "Target.setAutoAttach":
      case "Runtime.runIfWaitingForDebugger":
        return {};
      default: {
        const r = await extCall("cdp", { tabId, method, params: params ?? {} });
        return r.result ?? {};
      }
    }
  };

  const onClientMessage = async (client: Client, raw: string): Promise<void> => {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id !== "number" || typeof msg.method !== "string") return;
    try {
      let result: unknown;
      if (msg.sessionId) {
        const tabId = client.sessions.get(msg.sessionId);
        if (tabId === undefined) {
          sendJson(client.ws, cdpError(msg.id, "Session with given id not found."));
          return;
        }
        result = await sessionMethod(tabId, msg.method, msg.params);
        sendJson(client.ws, { id: msg.id, sessionId: msg.sessionId, result });
      } else {
        result = await browserMethod(client, msg.method, msg.params);
        sendJson(client.ws, { id: msg.id, result });
      }
    } catch (err) {
      const e = err as Error & { code?: number };
      sendJson(client.ws, { ...cdpError(msg.id, e.message, e.code ?? -32000), ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) });
    }
  };

  // ------------------------------------------------------------------ HTTP

  const isLoopbackHost = (hostHeader: string | undefined): boolean => {
    if (!hostHeader) return false;
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(hostHeader);
    if (!m) return false;
    return LOOPBACK_HOSTS.has(m[1]) && (!m[2] || parseInt(m[2], 10) === port);
  };

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // /healthz is the only unauthenticated route. It says our name, and to a
    // caller that sends a nonce it proves we hold the token (probeHost); the
    // proof grants nothing, it only lets the CLI tell us from a squatter.
    if (url.pathname === "/healthz") {
      const nonce = url.searchParams.get("nonce");
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`cast-bridge protocol=${BRIDGE_PROTOCOL}${isNonce(nonce) ? ` proof=${bridgeProof(token, "healthz", nonce)}` : ""}`);
      return;
    }
    // Reject DNS rebinding: a page at evil.example resolving to 127.0.0.1
    // arrives with Host: evil.example and would otherwise read these bodies.
    if (!isLoopbackHost(req.headers.host) || !secretMatches(token, url.searchParams.get("token"))) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden\n");
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=UTF-8" });
      res.end(JSON.stringify(body, null, 2));
    };
    try {
      switch (url.pathname) {
        case "/json/version":
        case "/json/version/":
          json(200, {
            Browser: `Chrome (cast bridge, extension ${extMeta.version ?? "?"})`,
            "Protocol-Version": "1.3",
            "User-Agent": extMeta.userAgent ?? "",
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/${token}`,
          });
          return;
        case "/json":
        case "/json/list":
        case "/json/list/":
          json(
            200,
            (await listTabs()).map((t) => ({
              id: targetIdOfTab(t.tabId),
              type: "page",
              title: t.title,
              url: t.url,
              description: "",
              attached: t.attached,
            })),
          );
          return;
        case "/status":
          json(200, {
            extensionConnected: !!ext && ext.readyState === WebSocket.OPEN,
            extensionVersion: extMeta.version,
            extensionProtocol: extMeta.protocol,
            protocol: BRIDGE_PROTOCOL,
          });
          return;
        default:
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("not found\n");
      }
    } catch (err) {
      json(503, { error: (err as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024, perMessageDeflate: false });

  /**
   * The extension face. The socket carries no token: the first message must
   * be a hello with a nonce and HMAC(token, "ext:" + nonce), answered with
   * HMAC(token, nonce) so the extension can tell us from a squatter too. Only
   * a proven socket becomes THE extension; until then it can neither replace
   * the current one nor drive anything.
   */
  const adoptExtension = (ws: WebSocket): void => {
    const hello = setTimeout(() => ws.close(CLOSE_BAD_TOKEN, "no hello"), HELLO_TIMEOUT_MS);
    ws.on("error", () => {});
    ws.once("message", (raw) => {
      clearTimeout(hello);
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        msg = null;
      }
      if (msg?.op !== "hello" || !isNonce(msg.nonce) || !secretMatches(bridgeProof(token, "ext", msg.nonce), msg.auth)) {
        ws.close(CLOSE_BAD_TOKEN, "bad token");
        return;
      }
      // One extension at a time; a newer connection wins so a reloaded
      // extension does not have to wait out a dead socket's timeout.
      if (ext && ext !== ws) ext.close(1000, "replaced by a newer extension connection");
      ext = ws;
      extMeta = { version: msg.version, protocol: msg.protocol, userAgent: msg.userAgent };
      ws.on("message", (raw) => onExtMessage(String(raw)));
      ws.on("close", () => {
        if (ext !== ws) return;
        ext = null;
        for (const [, p] of extPending) p.reject(new Error("the extension disconnected mid-command — check the cast bridge extension in Chrome"));
        extPending.clear();
        failAllClients("the extension disconnected");
      });
      sendJson(ws, { op: "welcome", proof: bridgeProof(token, "host", msg.nonce), protocol: BRIDGE_PROTOCOL });
    });
  };

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const origin = req.headers.origin;
    const pathToken = /^\/devtools\/browser\/([^/?]+)$/.exec(url.pathname)?.[1];
    const role: "ext" | "cdp" | null =
      url.pathname === "/ext" ? "ext" : pathToken || url.pathname === "/devtools/browser" ? "cdp" : null;
    const presented = url.searchParams.get("token") ?? pathToken;

    // A web page always sends an http(s) Origin on WebSocket upgrades. Nothing
    // legitimate here does. Refusing before the token check means a probing
    // page learns nothing, not even whether a stolen token would have worked.
    // CDP clients present the token in the URL (they are our own processes,
    // which verified the host first); the extension proves it in its hello.
    const pageOrigin = typeof origin === "string" && /^https?:/i.test(origin);
    const authed = role === "ext" || secretMatches(token, presented);
    if (!role || pageOrigin || !isLoopbackHost(req.headers.host) || !authed) {
      wss.handleUpgrade(req, socket, head, (ws) => ws.close(CLOSE_BAD_TOKEN, "bad token"));
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (role === "ext") {
        adoptExtension(ws);
        return;
      }

      const client: Client = { ws, sessions: new Map(), discover: false, group: null };
      clients.add(client);
      ws.on("message", (raw) => {
        void onClientMessage(client, String(raw));
      });
      ws.on("close", () => {
        clients.delete(client);
        // Whatever this client held is released — after it is gone from the
        // set, so its own sessions do not count as holders.
        for (const tabId of new Set(client.sessions.values())) release(tabId);
        client.sessions.clear();
      });
      ws.on("error", () => {});
    });
  });

  // Application-level keepalive: protocol pings are invisible to the
  // extension's JavaScript, and it is JS-visible traffic that keeps an MV3
  // service worker alive. 20s sits well inside Chrome's 30s idle teardown.
  const pinger = setInterval(() => {
    if (ext && ext.readyState === WebSocket.OPEN) sendJson(ext, { op: "ping" });
  }, 20_000);

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      resolve({
        port,
        extensionConnected: () => !!ext && ext.readyState === WebSocket.OPEN,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pinger);
            for (const ws of wss.clients) ws.terminate();
            wss.close();
            // http.close() waits for every socket to drain, including ones a
            // rejected upgrade left half-open — destroy them or hang forever.
            (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            httpServer.close(() => done());
          }),
      });
    });
  });
}

/** The `cast browser bridge-host` entry: run until told to stop. */
export async function runBridgeHost(): Promise<void> {
  const state = ensureBridgeConfig();
  if (await isHostAlive(state)) {
    console.error(`a bridge host is already answering on 127.0.0.1:${state.port}`);
    process.exit(0);
  }
  const host = await startBridgeHost({ port: state.port, token: state.token });
  writeBridgeState({ ...state, hostPid: process.pid, startedAt: Date.now() });
  const shutdown = async () => {
    await host.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  // Keep the event loop alive forever; the sockets do the actual work.
  await new Promise(() => {});
}
