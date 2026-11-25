// GET /lsp/servers and WS /lsp/ws on the daemon's loopback bridge: the
// language servers the web editor talks to. Same envelope as /vault/* and
// /term/* (origin allowlist plus the loopback bearer, sent in a hello frame on
// the socket). One socket drives one server process, started in the vault's
// root; protocol details are in lspInstance.ts and codeProtocol.ts.

import * as fsp from "fs/promises";
import type * as http from "http";
import { pathToFileURL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import type { LspServersResponse, LspWsControl, LspWsHello, VaultInfo } from "@codecast/shared/contracts";
import { authorizeLocalRequest, corsHeaders, onWsUpgrade, originAllowed, tokenMatches } from "../../terminal/terminalServer.js";
import { sendJson, type VaultServerOptions } from "../../vault/vaultServer.js";
import { findVault } from "../../vault/vaultRegistry.js";
import { LSP_MAX_MESSAGE_BYTES } from "./framing.js";
import { LspInstance, type LspInstanceHost } from "./lspInstance.js";
import { LSP_SERVERS, describeLspServers, lspServerInfo, resolveLspServer, type LspLaunch, type LspServerSpec } from "./registry.js";

const LSP_WS_PATH = "/lsp/ws";

export interface LspTuning {
  servers?: LspServerSpec[];
  /** How long a process outlives its socket, waiting for a reload. */
  graceMs?: number;
  helloTimeoutMs?: number;
  /** Restarts allowed per window before a crashing server is given up on. */
  maxRestarts?: number;
  restartWindowMs?: number;
  /** First restart delay; doubles per recent crash. */
  restartBaseMs?: number;
  /** Input queued for a server that stopped reading, past which it is killed. */
  stdinMaxQueued?: number;
}

export type LspServerOptions = VaultServerOptions & { lsp?: LspTuning };

const DEFAULTS = {
  graceMs: 60_000,
  helloTimeoutMs: 10_000,
  maxRestarts: 3,
  restartWindowMs: 5 * 60_000,
  restartBaseMs: 500,
};

class LspHub implements LspInstanceHost {
  private live = new Set<LspInstance>();
  private parkedAt = new Map<LspInstance, ReturnType<typeof setTimeout>>();
  private crashes = new Map<string, number[]>();
  /** Attached instances a fresh hello gave up on: they die when their socket
   *  goes instead of parking. */
  private doomed = new Set<LspInstance>();
  readonly specs: LspServerSpec[];
  private readonly tune: typeof DEFAULTS & Pick<LspTuning, "stdinMaxQueued">;

  constructor(readonly log: (msg: string) => void, tuning: LspTuning = {}) {
    this.specs = tuning.servers ?? LSP_SERVERS;
    this.tune = { ...DEFAULTS, ...Object.fromEntries(Object.entries(tuning).filter(([, v]) => v !== undefined)) };
  }

  get helloTimeoutMs(): number {
    return this.tune.helloTimeoutMs;
  }

  get stdinMaxQueued(): number | undefined {
    return this.tune.stdinMaxQueued;
  }

  private recentCrashes(key: string): number[] {
    const since = Date.now() - this.tune.restartWindowMs;
    const list = (this.crashes.get(key) ?? []).filter((t) => t > since);
    this.crashes.set(key, list);
    return list;
  }

  /** Why a (vault, server) pair may not start right now, if it may not. */
  refusal(key: string): string | null {
    const recent = this.recentCrashes(key);
    if (recent.length <= this.tune.maxRestarts) return null;
    const wait = Math.ceil((recent[0] + this.tune.restartWindowMs - Date.now()) / 1000);
    return `crashed ${recent.length} times in ${Math.round(this.tune.restartWindowMs / 60_000)} minutes; try again in ${wait}s`;
  }

  allowRestart(key: string): boolean {
    const recent = this.recentCrashes(key);
    recent.push(Date.now());
    return recent.length <= this.tune.maxRestarts;
  }

  restartDelayMs(key: string): number {
    return this.tune.restartBaseMs * 2 ** Math.max(0, this.recentCrashes(key).length - 1);
  }

  add(inst: LspInstance): void {
    this.live.add(inst);
  }

  parked(inst: LspInstance): void {
    if (this.doomed.delete(inst)) return inst.dispose();
    this.unpark(inst);
    const timer = setTimeout(() => inst.dispose(), this.tune.graceMs);
    timer.unref?.();
    this.parkedAt.set(inst, timer);
  }

  gone(inst: LspInstance): void {
    this.unpark(inst);
    this.doomed.delete(inst);
    this.live.delete(inst);
  }

  private unpark(inst: LspInstance): void {
    const timer = this.parkedAt.get(inst);
    if (timer) clearTimeout(timer);
    this.parkedAt.delete(inst);
  }

  /** A fresh hello: `client` gave up on its connection (a Restart while the
   *  server or this relay stopped answering). The processes for `key` it held
   *  are killed now if parked, or when their socket goes; another window's
   *  stay. A hello naming no client only clears parked ones. */
  discard(key: string, client: string | undefined): void {
    for (const inst of [...this.live]) {
      if (inst.key !== key) continue;
      if (this.parkedAt.has(inst)) {
        if (!client || inst.client === client) inst.dispose();
      } else if (client && inst.client === client) this.doomed.add(inst);
    }
  }

  /** A warm process for `key` left by a socket that closed, if one is waiting. */
  claim(key: string): LspInstance | null {
    for (const inst of this.parkedAt.keys()) {
      if (inst.key !== key) continue;
      this.unpark(inst);
      if (inst.alive) return inst;
      inst.dispose();
    }
    return null;
  }

  running(vaultId: string, serverId: string): boolean {
    for (const inst of this.live) if (inst.vaultId === vaultId && inst.info.id === serverId && inst.alive) return true;
    return false;
  }

  closeAll(): void {
    for (const inst of [...this.live]) inst.dispose();
  }

  /** Last resort on process exit: no timer will run, so kill outright. */
  killAllNow(): void {
    for (const inst of this.live) inst.signal("SIGKILL");
  }
}

// One hub per process, owned by attachLspServer; the HTTP route reads it for
// `running` and works without it.
let hub: LspHub | null = null;

const instanceKey = (vaultId: string, serverId: string) => `${vaultId}\0${serverId}`;

/** GET /lsp/servers?vault=. Returns true when the request was handled. */
export function handleLspHttp(req: http.IncomingMessage, res: http.ServerResponse, opts: LspServerOptions): boolean {
  const url = req.url ?? "";
  if (!url.startsWith("/lsp/")) return false;
  const headers = corsHeaders(req.headers.origin, opts);
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return true;
  }
  if (!authorizeLocalRequest(req, opts)) {
    sendJson(res, 403, headers, { error: "forbidden" });
    return true;
  }
  const parsed = new URL(url, "http://localhost");
  if (req.method !== "GET" || parsed.pathname !== "/lsp/servers") {
    sendJson(res, 404, headers, { error: "not found" });
    return true;
  }
  const vault = findVault(opts.configDir, parsed.searchParams.get("vault") ?? "");
  if (!vault) {
    sendJson(res, 404, headers, { error: "unknown vault" });
    return true;
  }
  const specs = hub?.specs ?? opts.lsp?.servers ?? LSP_SERVERS;
  describeLspServers(specs, vault.root, (id) => hub?.running(vault.id, id) ?? false).then(
    (servers) => sendJson(res, 200, headers, { servers } satisfies LspServersResponse),
    (err: Error) => {
      opts.log(`[LSP] listing servers failed: ${err.message}`);
      sendJson(res, 500, headers, { error: "server error" });
    },
  );
  return true;
}

/** Wire WS /lsp/ws onto the loopback server. Every server process dies with
 *  the returned handle, and with the daemon if it exits without closing it. */
export function attachLspServer(server: http.Server, opts: LspServerOptions): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: LSP_MAX_MESSAGE_BYTES });
  const own = new LspHub(opts.log, opts.lsp);
  hub = own;
  const onExit = () => own.killAllNow();
  process.once("exit", onExit);

  const detach = onWsUpgrade(server, LSP_WS_PATH, (req, socket, head) => {
    if (!originAllowed(req.headers.origin, opts)) {
      opts.log(`[LSP] Rejected WS from origin ${req.headers.origin ?? "(none)"}`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleLspSocket(ws, opts, own));
  });

  return {
    close() {
      detach();
      process.removeListener("exit", onExit);
      own.closeAll();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      if (hub === own) hub = null;
    },
  };
}

function handleLspSocket(ws: WebSocket, opts: LspServerOptions, hub: LspHub): void {
  const send = (frame: LspWsControl | { type: "error"; message: string }) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  };
  const fail = (message: string) => {
    send({ type: "error", message });
    ws.close(4000, message.slice(0, 100));
  };
  const unavailable = (frame: Omit<Extract<LspWsControl, { type: "unavailable" }>, "type">) => {
    send({ type: "unavailable", ...frame });
    ws.close(1000, "unavailable");
  };

  const helloTimeout = setTimeout(() => fail("hello timeout"), hub.helloTimeoutMs);
  helloTimeout.unref?.();

  ws.once("message", (raw, isBinary) => {
    clearTimeout(helloTimeout);
    if (isBinary) return fail("expected hello");
    let hello: LspWsHello;
    try {
      hello = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail("bad hello");
    }
    if (hello?.type !== "hello") return fail("bad hello");
    if (!tokenMatches(hello.token, opts)) return fail("forbidden");
    const vault = findVault(opts.configDir, hello.vault ?? "");
    if (!vault) return fail("unknown vault");

    void connect(vault, hello).catch((err: Error) => {
      opts.log(`[LSP] start failed: ${err.message}`);
      unavailable({ server: hello.server, reason: err.message });
    });
  });

  async function connect(vault: VaultInfo, hello: LspWsHello): Promise<void> {
    // Servers report canonical paths (clangd and rust-analyzer resolve
    // symlinks: /tmp is /private/tmp on macOS), so they start in the real
    // root and every URI the editor builds from root_uri matches theirs.
    const root = await fsp.realpath(vault.root).catch(() => vault.root);
    const picked = await pickServer(hub.specs, root, hello);
    if ("reason" in picked) return unavailable(picked);
    const { spec } = picked;
    const key = instanceKey(vault.id, spec.id);
    const refused = hub.refusal(key);
    if (refused) return unavailable({ server: spec.id, reason: refused });

    if (hello.fresh) {
      hub.discard(key, hello.client);
      opts.log(`[LSP] fresh start of ${spec.id} in ${root} asked for`);
    }
    let inst = hello.fresh ? null : hub.claim(key);
    if (!inst) {
      const launch = { ...picked.launch, initializationOptions: await spec.initializationOptions?.(root) };
      inst = new LspInstance(key, vault.id, root, pathToFileURL(root).href, lspServerInfo(spec, launch.command), launch, hub);
      // Live before it starts, so closing the routes mid-start reaches it.
      hub.add(inst);
      try {
        await inst.start();
      } catch (err) {
        inst.dispose();
        throw err;
      }
      opts.log(`[LSP] started ${spec.id} in ${root}`);
    }
    // The browser may have gone while the server started: keep it warm for the
    // reload that is probably coming.
    if (ws.readyState !== WebSocket.OPEN) return hub.parked(inst);
    inst.attach(ws, { acks: hello.acks, client: hello.client });
  }
}

type Picked = { spec: LspServerSpec; launch: LspLaunch } | { server?: string; reason: string; install_hint?: string };

/** The server a hello names, or the first installed one for its language. */
async function pickServer(specs: LspServerSpec[], root: string, hello: LspWsHello): Promise<Picked> {
  const candidates = hello.server
    ? specs.filter((s) => s.id === hello.server)
    : specs.filter((s) => !!hello.language && s.languages.includes(hello.language));
  if (candidates.length === 0) {
    return { server: hello.server, reason: hello.server ? `unknown language server "${hello.server}"` : `no language server for ${hello.language ?? "this language"}` };
  }
  let first: Picked | null = null;
  for (const spec of candidates) {
    const resolved = await resolveLspServer(spec, root);
    if (resolved.ok) return { spec, launch: resolved.launch };
    first ??= { server: spec.id, reason: resolved.reason, install_hint: spec.install };
  }
  return first!;
}
