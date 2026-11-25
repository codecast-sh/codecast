// One LSPClient per (vault, language server), shared by every editor of the
// languages that server answers for. Created on first ask, reconnected on each
// "ready" from the transport (after a crash restart or a reattach), and
// disposed once no editor has had a file open in it for a while; closing the
// socket leaves the daemon's process warm for its grace period.
//
// No React and no store import at module level: this loads inside the editor
// chunk, and only once a language server is asked for.

import { LSPClient, type LSPClientConfig } from "@codemirror/lsp-client";
import type { LspServerInfo, LspServersResponse } from "@codecast/shared/contracts";
import { loopbackFetch, type VaultEndpoint } from "../../vault/client";
import { LspWebSocketTransport, type LspConnectionState, type LspEndpointResolver, type LspTransportOptions } from "./transport";
import { CodecastWorkspace, type WorkspaceHost } from "./workspace";
import { baseServerHandlers, routeServerRequests, type RoutedTransport, type ServerRequestHandler } from "./router";
import { applyProgress, type ProgressTasks } from "./progress";

export type LspPoolStatus = LspConnectionState["status"] | "idle";

export interface LspPoolState extends Omit<LspConnectionState, "status"> {
  /** "ready" once the server answered initialize; "idle" while no client
   *  exists for this language yet. */
  status: LspPoolStatus;
  serverId?: string;
  /** The server's open work-done tasks ($/progress), by token. */
  tasks?: ProgressTasks;
}

export interface LspPoolConfig {
  endpoint?: LspEndpointResolver;
  /** Extra LSPClient options per server (extensions, sanitizeHTML, ...). */
  clientConfig?: (server: LspServerInfo) => LSPClientConfig;
  /** What the workspace needs from the editor (buffers, opening files). */
  workspaceHost?: (vaultId: string) => WorkspaceHost;
  /** Server-to-client requests answered for a client, beyond the base set. */
  serverRequests?: (client: LSPClient, vaultId: string) => Record<string, ServerRequestHandler>;
  /** Editors should ask for their client again: one they hold was disposed,
   *  or a server they found none for may answer now (installed, retried).
   *  Coalesced per task. */
  reattach?: () => void;
  /** A client's server process went (crash, restart, dispose): whatever it
   *  published no longer stands. */
  onClientDown?: (client: LSPClient) => void;
  /** How long a client with no open files lives on. */
  idleMs?: number;
  serversTtlMs?: number;
  transport?: Pick<LspTransportOptions, "WebSocket" | "retryInitialMs" | "retryMaxMs">;
}

interface Entry {
  key: string;
  vaultId: string;
  server: LspServerInfo;
  transport: LspWebSocketTransport;
  routed: RoutedTransport;
  client: LSPClient | null;
  /** The client is connected to the transport's current server. */
  linked: boolean;
  /** Settles on the first ready (the client) or on a final failure (null). */
  firstClient: Promise<LSPClient | null>;
  state: LspPoolState;
  idleSince: number | null;
  stopState: () => void;
}

const defaultEndpoint: LspEndpointResolver = async () => {
  const { useVaultStore } = await import("../../../store/vaultStore");
  return useVaultStore.getState().endpoint;
};

let config: LspPoolConfig = {};
const entries = new Map<string, Entry>();
const listeners = new Map<string, Set<(state: LspPoolState) => void>>();
const serverLists = new Map<string, { at: number; servers: Promise<LspServerInfo[]> }>();
let idleTimer: ReturnType<typeof setInterval> | null = null;
/** The servers each vault's last list had installed, to notice a new one. */
const knownAvailable = new Map<string, Set<string>>();
const poolListeners = new Set<() => void>();

let reattachQueued = false;
function scheduleReattach(): void {
  if (reattachQueued || !config.reattach) return;
  reattachQueued = true;
  queueMicrotask(() => {
    reattachQueued = false;
    config.reattach?.();
  });
}

/** Any client or state change in the pool (a status item that depends on
 *  whether any server runs for a folder). */
export function onLspPoolChange(fn: () => void): () => void {
  poolListeners.add(fn);
  return () => poolListeners.delete(fn);
}
const poolChanged = () => poolListeners.forEach((fn) => fn());

const IDLE_MS = 3 * 60_000;
const SERVERS_TTL_MS = 60_000;
const entryKey = (vaultId: string, serverId: string) => `${vaultId}\0${serverId}`;
/** Failed before it ever had a client: its first-client promise settled null,
 *  so the entry holds nothing worth keeping. */
const failedEmpty = (entry: Entry) => !entry.client && (entry.state.status === "unavailable" || entry.state.status === "crashed");

export function configureLspPool(next: LspPoolConfig): void {
  config = next;
}

const endpoint = (): Promise<VaultEndpoint | null> => Promise.resolve((config.endpoint ?? defaultEndpoint)());

/** Every server the daemon knows for this vault, installed or not (cached). */
export function lspServers(vaultId: string, opts: { fresh?: boolean } = {}): Promise<LspServerInfo[]> {
  const hit = serverLists.get(vaultId);
  if (hit && !opts.fresh && Date.now() - hit.at < (config.serversTtlMs ?? SERVERS_TTL_MS)) return hit.servers;
  const servers = (async () => {
    const ep = await endpoint();
    if (!ep) return [];
    const res = await loopbackFetch(ep, `/lsp/servers?vault=${encodeURIComponent(vaultId)}`);
    if (!res.ok) return [];
    return ((await res.json()) as LspServersResponse).servers ?? [];
  })().catch(() => []);
  serverLists.set(vaultId, { at: Date.now(), servers });
  void servers.then((list) => {
    // A failed lookup is not worth remembering for a minute.
    if (list.length === 0 && serverLists.get(vaultId)?.servers === servers) serverLists.delete(vaultId);
    const available = new Set(list.filter((s) => s.available).map((s) => s.id));
    const before = knownAvailable.get(vaultId);
    knownAvailable.set(vaultId, available);
    // A file shown while its server was missing (or the daemon unreachable)
    // has no server attached; one is here now.
    if (before && [...available].some((id) => !before.has(id))) scheduleReattach();
  });
  return servers;
}

/** The installed server for a language, else the first that would answer it
 *  (whose install hint is the useful thing to show). */
async function serverFor(vaultId: string, languageId: string): Promise<{ server: LspServerInfo | null; missing?: LspServerInfo }> {
  const candidates = (await lspServers(vaultId)).filter((s) => s.languages.includes(languageId));
  return { server: candidates.find((s) => s.available) ?? null, missing: candidates[0] };
}

/** The shared client for this language in this vault, or null when no server
 *  for it is installed or it could not start. */
export async function getLspClient(vaultId: string, languageId: string): Promise<LSPClient | null> {
  const { server } = await serverFor(vaultId, languageId);
  if (!server) return null;
  const key = entryKey(vaultId, server.id);
  let entry = entries.get(key);
  // Ask the daemon again rather than repeat a failure for the life of the tab:
  // the server may be installed now, or its crash window may have passed.
  if (entry && failedEmpty(entry)) {
    disposeEntry(entry);
    entry = undefined;
  }
  entry ??= createEntry(key, vaultId, server);
  entry.idleSince = null;
  return entry.firstClient;
}

function createEntry(key: string, vaultId: string, server: LspServerInfo): Entry {
  let settle!: (client: LSPClient | null) => void;
  const firstClient = new Promise<LSPClient | null>((resolve) => (settle = resolve));
  const transport = new LspWebSocketTransport({ vaultId, server: server.id, endpoint, ...config.transport });
  const entry: Entry = {
    key,
    vaultId,
    server,
    transport,
    routed: routeServerRequests(transport),
    client: null,
    linked: false,
    firstClient,
    state: { status: "starting", serverId: server.id },
    idleSince: null,
    stopState: () => {},
  };
  entries.set(key, entry);
  ensureIdleSweep();

  entry.stopState = transport.onState((t) => {
    // Still the same connection, only answering or not: nothing to reconnect.
    if (t.status === "ready" && entry.linked && entry.client) {
      publish(entry, { ...entry.state, unresponsive: t.unresponsive });
      return;
    }
    if (t.status === "ready") {
      const client = entry.client ?? createClient(entry, t.rootUri);
      entry.client = client;
      // A fresh process starts with no work in progress.
      entry.state = { ...entry.state, tasks: undefined };
      // Every ready is a server waiting for initialize (see transport.ts).
      client.connect(entry.routed);
      entry.linked = true;
      settle(client);
      publish(entry, { ...t, status: "starting" });
      const initializing = client.initializing;
      initializing.then(
        () => {
          if (entry.client === client && client.initializing === initializing && transport.state.status === "ready") publish(entry, { ...transport.state, status: "ready" });
        },
        () => {},
      );
      return;
    }
    // Requests made while it is down wait for the next initialize instead of
    // reaching a server that has not had one.
    if (entry.client && entry.linked) {
      entry.client.disconnect();
      entry.linked = false;
      config.onClientDown?.(entry.client);
    }
    if (t.status === "unavailable" || t.status === "crashed") {
      settle(null);
      serverLists.delete(vaultId);
    }
    publish(entry, t);
  });
  return entry;
}

function createClient(entry: Entry, rootUri: string | undefined): LSPClient {
  const extra = config.clientConfig?.(entry.server) ?? {};
  const host = config.workspaceHost?.(entry.vaultId);
  const client = new LSPClient({
    timeout: 10_000,
    ...extra,
    rootUri,
    ...(host && rootUri ? { workspace: (c: LSPClient) => new CodecastWorkspace(c, host, rootUri) } : {}),
    notificationHandlers: {
      ...extra.notificationHandlers,
      "$/progress": (_c, params) => {
        const before = entry.state.tasks ?? new Map();
        const tasks = applyProgress(before, params);
        if (tasks !== before) publish(entry, { ...entry.state, tasks });
        return true;
      },
    },
  });
  entry.routed.handle({ ...baseServerHandlers(() => rootUri), ...config.serverRequests?.(client, entry.vaultId) });
  return client;
}

function publish(entry: Entry, state: LspConnectionState | LspPoolState): void {
  // Tasks belong to the process: kept while it starts and runs, dropped when it goes.
  const live = state.status === "ready" || state.status === "starting";
  const tasks = live ? ("tasks" in state ? state.tasks : entry.state.tasks) : undefined;
  entry.state = { ...state, tasks, serverId: entry.server.id };
  for (const listener of [...(listeners.get(entry.key) ?? [])]) listener(entry.state);
  poolChanged();
}

/** Watch the language server state for a language, for a status chip. Does
 *  not start a server; getLspClient does. */
export function subscribeLspState(vaultId: string, languageId: string, listener: (state: LspPoolState) => void): () => void {
  let unsubscribed = false;
  let key: string | null = null;
  void serverFor(vaultId, languageId).then(({ server, missing }) => {
    if (unsubscribed) return;
    if (!server) {
      listener(
        missing
          ? { status: "unavailable", serverId: missing.id, reason: `${missing.name} language server is not installed`, installHint: missing.install_hint }
          : { status: "unavailable", reason: `no language server for ${languageId}` },
      );
      return;
    }
    key = entryKey(vaultId, server.id);
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(listener);
    listener(entries.get(key)?.state ?? { status: "idle", serverId: server.id, server });
  });
  return () => {
    unsubscribed = true;
    if (!key) return;
    const set = listeners.get(key);
    set?.delete(listener);
    if (set?.size === 0) listeners.delete(key);
  };
}

/** Try again after unavailable or crashed (a status chip's retry). */
export function retryLsp(vaultId: string, serverId: string): void {
  serverLists.delete(vaultId);
  const entry = entries.get(entryKey(vaultId, serverId));
  if (!entry) return;
  if (entry.client) {
    // Keep the client, so editors holding it reconnect too.
    entry.transport.retry();
  } else {
    disposeEntry(entry);
    createEntry(entry.key, vaultId, entry.server);
    // Files shown while it was failing hold no client; let them ask again.
    scheduleReattach();
  }
}

/** Stop the server and start a fresh process (the status chip's Restart).
 *  Through the open socket when it is ready; otherwise (a hello the daemon
 *  never answers, a restart that never came back) a new socket with a fresh
 *  hello, so the daemon cannot hand back the process that was stuck. A server
 *  that is unavailable, crashed or offline starts over as a retry does. */
export function restartLsp(vaultId: string, serverId: string): void {
  const entry = entries.get(entryKey(vaultId, serverId));
  const status = entry?.transport.state.status;
  if (!entry || status === "unavailable" || status === "crashed" || status === "offline") return retryLsp(vaultId, serverId);
  if (status === "ready" && entry.transport.restartServer()) return;
  entry.transport.reconnectFresh();
}

/** What a status chip shows about a server beyond its state. */
export function lspServerDetails(vaultId: string, serverId: string): { server: LspServerInfo; rootUri?: string; client: LSPClient | null } | null {
  const entry = entries.get(entryKey(vaultId, serverId));
  return entry ? { server: entry.state.server ?? entry.server, rootUri: entry.state.rootUri ?? (entry.client?.workspace instanceof CodecastWorkspace ? entry.client.workspace.rootUri : undefined), client: entry.client } : null;
}

/** Every live client for a vault (workspace symbols, problems). */
export function lspClientsFor(vaultId: string): LSPClient[] {
  return [...entries.values()].filter((e) => e.vaultId === vaultId && e.client).map((e) => e.client!);
}

function disposeEntry(entry: Entry): void {
  entries.delete(entry.key);
  const ws = entry.client?.workspace;
  if (ws instanceof CodecastWorkspace) ws.dispose();
  entry.stopState();
  entry.client?.disconnect();
  entry.transport.dispose();
  if (entry.client) {
    config.onClientDown?.(entry.client);
    // Buffers off screen still hold this client's plugin in their saved
    // state; they must build against a fresh client when shown again.
    scheduleReattach();
  }
  for (const listener of [...(listeners.get(entry.key) ?? [])]) listener({ status: "idle", serverId: entry.server.id, server: entry.server });
  poolChanged();
  if (entries.size === 0 && idleTimer) {
    clearInterval(idleTimer);
    idleTimer = null;
  }
}

/** Dispose clients no editor has used for idleMs: a file open in any editor
 *  holds its client, and so does a pending first connection. */
export function sweepIdleLspClients(now = Date.now()): void {
  const idleMs = config.idleMs ?? IDLE_MS;
  for (const entry of [...entries.values()]) {
    const ws = entry.client?.workspace;
    const inUse = ws ? (ws instanceof CodecastWorkspace ? ws.liveCount : ws.files.length) > 0 : !failedEmpty(entry);
    if (inUse) entry.idleSince = null;
    else if (entry.idleSince === null) entry.idleSince = now;
    else if (now - entry.idleSince >= idleMs) disposeEntry(entry);
  }
}

function ensureIdleSweep(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => sweepIdleLspClients(), Math.min(30_000, config.idleMs ?? IDLE_MS));
}

/** Drop every client and socket (tests, sign-out). */
export function disposeLspPool(): void {
  for (const entry of [...entries.values()]) disposeEntry(entry);
  serverLists.clear();
  knownAvailable.clear();
}
