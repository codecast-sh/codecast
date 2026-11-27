// Loopback client for the daemon's vault bridge. The vault routes live on the
// same per-boot-token HTTP server as the integrated terminal, so endpoint
// discovery is shared with lib/terminal/endpoint.ts — whichever daemon answers
// the probe is the machine the browser is physically on. A vault on a cloud
// host is reached through that machine's SSH forward; every request here is
// routed by its vault (lib/vault/hosts/routes.ts).

import type { ConvexReactClient } from "convex/react";
import type {
  VaultInfo,
  VaultLocateResponse,
  VaultScanResponse,
  VaultOpRequest,
  VaultOpResponse,
  VaultWriteResponse,
  VaultWsEvent,
} from "@codecast/shared/contracts";
import {
  getTerminalEndpoint,
  loopbackWsUrl,
  termHttpBase,
  type TerminalEndpoint,
} from "../terminal/endpoint";
import { openWebSocket } from "../openWebSocket";
import {
  hostOfEndpoint,
  hostOfVault,
  onHostEndpointChange,
  reestablishHost,
  routeEndpoint,
  routeEndpointOpening,
  tagHostVault,
  vaultOfPath,
  wirePath,
  wireVaultId,
} from "./hosts/routes";

const FETCH_TIMEOUT_MS = 10_000;

export type VaultEndpoint = TerminalEndpoint;

export async function getVaultEndpoint(
  convex: ConvexReactClient,
  opts?: { force?: boolean },
): Promise<VaultEndpoint | null> {
  return getTerminalEndpoint(convex, opts);
}

function authHeaders(ep: VaultEndpoint): Record<string, string> {
  return { Authorization: `Bearer ${ep.token}` };
}

// Chrome 142+ Local Network Access lets a request declare where it is going,
// so the browser can classify a loopback destination before DNS and exempt it
// from mixed-content blocking on a hosted https origin.
//
// The value "loopback" only exists from Chrome 142. Older Chromium implements
// the SAME member with the earlier enum ("local"), so passing "loopback" there
// is not ignored — WebIDL rejects it and fetch throws a TypeError before any
// request leaves. The desktop app runs Electron 33 (Chromium 130), so this
// broke every vault request there while the terminal, which never sets the
// option, kept working. Detect once, and never send a value the runtime will
// refuse.
export function pickAddressSpaceInit(
  makeRequest: (init: RequestInit) => unknown,
): Record<string, unknown> {
  for (const value of ["loopback", "local"]) {
    try {
      makeRequest({ targetAddressSpace: value } as RequestInit);
      return { targetAddressSpace: value };
    } catch {
      // This runtime knows the member but not this value — try the older name.
    }
  }
  return {};
}

const ADDRESS_SPACE_INIT: Record<string, unknown> = pickAddressSpaceInit(
  (init) => new Request("http://127.0.0.1/", init),
);

/** A request to the daemon's loopback bridge with its bearer and the browser's
 *  local-network hints. Every page that talks to the bridge goes through this
 *  (vault routes here, memory routes in lib/memory/client.ts). */
export async function loopbackFetch(ep: VaultEndpoint, path: string, init?: RequestInit): Promise<Response> {
  // Each vault's requests go to the daemon that holds it (lib/vault/hosts):
  // this machine's, or a cloud host's through its forward.
  const vault = vaultOfPath(path);
  const routed = await routeEndpointOpening(ep, vault);
  // A host's vault with no forward open, or this machine's vault with no
  // local daemon known: the request goes nowhere, the way a refused
  // connection does. Neither machine stands in for the other.
  if (!routed) {
    const host = hostOfVault(vault);
    throw new TypeError(host ? `${host} is not reachable` : "Files is not connected to this machine");
  }
  const wire = wirePath(path);
  try {
    return await loopbackFetchAt(routed, wire, init);
  } catch (e) {
    // A forward closes after 10 idle minutes and its port then refuses every
    // connection. Open a fresh one and retry once, only when the port moved:
    // a refused connection to a closed listener reached nothing, so no
    // request (a PUT included) can land twice.
    const host = hostOfEndpoint(routed);
    if (!host || !(e instanceof TypeError)) throw e;
    const fresh = await reestablishHost(host);
    if (!fresh || fresh.port === routed.port) throw e;
    return loopbackFetchAt(fresh, wire, init);
  }
}

async function loopbackFetchAt(ep: VaultEndpoint, path: string, init?: RequestInit): Promise<Response> {
  const request = {
    ...init,
    headers: { ...authHeaders(ep), ...(init?.headers as Record<string, string>) },
    signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  try {
    return await fetch(`${termHttpBase(ep)}${path}`, { ...request, ...ADDRESS_SPACE_INIT });
  } catch (e) {
    // A rejected address-space value throws before the request is sent. Retry
    // plainly rather than reporting a working daemon as unreachable.
    if (e instanceof TypeError && Object.keys(ADDRESS_SPACE_INIT).length) {
      return await fetch(`${termHttpBase(ep)}${path}`, request);
    }
    throw e;
  }
}

/** Carries the HTTP status so a caller can distinguish a daemon that has no
 *  vault routes (404) from one that refused the request (403) or failed. */
export class VaultRequestError extends Error {
  /** `reason`: the daemon's own word for a refusal ("read-only", "binary"). */
  constructor(message: string, public status: number, public reason?: string) {
    super(message);
  }
}

/** The request never got an answer: no daemon known, a refused connection, a
 *  timeout. Unlike a refusal, sending it again later can succeed. */
export function isVaultUnreachable(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"));
}

/** Why a file read came back with nothing, in a word or two a status line
 *  can show: the HTTP status the daemon answered, or that it never did. */
export function readFailureLabel(e: unknown): string {
  if (e instanceof VaultRequestError) {
    if (e.status === 403) return "No permission";
    if (e.status === 404) return "Not found";
    if (e.status === 413) return "Too large";
    return `Daemon error ${e.status}`;
  }
  if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) return "Timed out";
  return "Daemon unreachable";
}

export async function listVaults(ep: VaultEndpoint): Promise<VaultInfo[]> {
  const res = await loopbackFetch(ep, "/vault/roots");
  if (!res.ok) throw new VaultRequestError(`vault roots: ${res.status}`, res.status);
  const body = (await res.json()) as { vaults: VaultInfo[] };
  const host = hostOfEndpoint(routeEndpoint(ep));
  return (body.vaults ?? []).map((v) => tagHostVault(v, host));
}

/** The vault holding a local path, registered by the daemon when none did
 *  (GET /vault/locate). Null when the path does not exist on that machine;
 *  throws VaultRequestError(404) for a daemon that predates the route. */
export async function locateVault(ep: VaultEndpoint, localPath: string): Promise<VaultLocateResponse | null> {
  const res = await loopbackFetch(ep, `/vault/locate?path=${encodeURIComponent(localPath)}`);
  if (res.ok) {
    const located = (await res.json()) as VaultLocateResponse;
    return { ...located, vault: tagHostVault(located.vault, hostOfEndpoint(routeEndpoint(ep))) };
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 404 && body.error === "no such path") return null;
  throw new VaultRequestError(`vault locate: ${res.status}`, res.status);
}

export async function scanVault(
  ep: VaultEndpoint,
  vaultId: string,
  opts: { ignored?: boolean } = {},
): Promise<VaultScanResponse> {
  const query = `vault=${encodeURIComponent(vaultId)}${opts.ignored ? "&ignored=1" : ""}`;
  // The capability rides along with the scan rather than waiting for the first
  // image: a scan always precedes rendering a note, so by the time an <img> is
  // built the capability is cached and vaultAssetUrl answers synchronously.
  const [res] = await Promise.all([
    loopbackFetch(ep, `/vault/scan?${query}`, {
      // A big vault walk can exceed the default budget.
      signal: AbortSignal.timeout(60_000),
    }),
    ensureVaultCapability(ep, vaultId).catch(() => {}),
  ]);
  if (!res.ok) throw new Error(`vault scan: ${res.status}`);
  return (await res.json()) as VaultScanResponse;
}

// --- Attachment capabilities -------------------------------------------------
//
// An <img> can set no headers, so an attachment URL carries its own proof. It
// used to carry the daemon's loopback bearer — the secret that also spawns
// shells — and a URL is readable by whatever renders it: an SVG from the vault,
// opened as a document, runs at the daemon's origin and reads its own location.
// So the URL carries a vault-read capability instead: one vault, reads only,
// expiring. The daemon mints it on /vault/cap behind the full header envelope.

interface CachedCapability {
  value: string;
  expires_at: number;
}

/** Keyed by daemon and vault. The token is part of the key so a rotated daemon
 *  token never reuses a capability minted under the old one. */
const capabilities = new Map<string, CachedCapability>();
const capabilityMints = new Map<string, Promise<void>>();
/** Daemons with no /vault/cap route — a CLI from before the capability. Their
 *  attachment URLs keep the legacy token form until the user updates. */
const legacyCapabilityDaemons = new Set<string>();
/** Re-mint this far before expiry, so a tab open across the boundary never
 *  renders a URL that is about to stop working. */
const CAPABILITY_REFRESH_MS = 60 * 60 * 1000;

function capabilityKey(ep: VaultEndpoint, vaultId: string): string {
  return `${termHttpBase(ep)}|${ep.token}|${vaultId}`;
}

/** Fetch and cache a read capability for this vault, unless a fresh one is
 *  already held. Resolves quietly for a daemon that has no such route. */
export async function ensureVaultCapability(endpoint: VaultEndpoint, vaultId: string): Promise<void> {
  const ep = routeEndpoint(endpoint, vaultId);
  if (!ep) return;
  const key = capabilityKey(ep, vaultId);
  if (legacyCapabilityDaemons.has(key)) return;
  const held = capabilities.get(key);
  if (held && held.expires_at - Date.now() > CAPABILITY_REFRESH_MS) return;
  const inFlight = capabilityMints.get(key);
  if (inFlight) return inFlight;

  const mint = (async () => {
    try {
      const res = await loopbackFetch(ep, `/vault/cap?vault=${encodeURIComponent(vaultId)}`);
      if (res.status === 404) {
        legacyCapabilityDaemons.add(key);
        return;
      }
      if (!res.ok) return;
      const body = (await res.json()) as CachedCapability;
      if (body?.value && typeof body.expires_at === "number") capabilities.set(key, body);
    } finally {
      capabilityMints.delete(key);
    }
  })();
  capabilityMints.set(key, mint);
  return mint;
}

export interface VaultFileContent {
  content: string;
  mtime: number;
  size: number;
  etag: string;
  /** The file's permission bits ("0444") when the daemon says it cannot be
   *  written as it stands; absent for a writable file or an older daemon. */
  lockedMode?: string;
}

/** X-Vault-Writable: 0 with the mode beside it (vaultServer handleGetFile). */
function lockedModeOf(res: Response): string | undefined {
  return res.headers.get("X-Vault-Writable") === "0" ? (res.headers.get("X-Vault-Mode") ?? "read-only") : undefined;
}

export async function readVaultFile(
  ep: VaultEndpoint,
  vaultId: string,
  path: string,
): Promise<VaultFileContent | null> {
  const res = await loopbackFetch(
    ep,
    `/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new VaultRequestError(`vault file ${path}: ${res.status}`, res.status);
  const lockedMode = lockedModeOf(res);
  return {
    content: await res.text(),
    mtime: parseInt(res.headers.get("X-Vault-Mtime") ?? "0", 10),
    size: parseInt(res.headers.get("X-Vault-Size") ?? "0", 10),
    etag: res.headers.get("ETag") ?? "",
    ...(lockedMode ? { lockedMode } : {}),
  };
}

/** URL for an asset (image etc.) — usable directly as an <img> src.
 *  Null while no capability is held yet: scanVault mints one before any note
 *  renders, so this is the cold path only, and it starts a mint of its own. */
export function vaultAssetUrl(endpoint: VaultEndpoint, vaultId: string, path: string): string | null {
  const ep = routeEndpoint(endpoint, vaultId);
  if (!ep) {
    const host = hostOfVault(vaultId);
    if (host) void reestablishHost(host).catch(() => {});
    return null;
  }
  const base = `${termHttpBase(ep)}/vault/file?vault=${encodeURIComponent(wireVaultId(vaultId))}&path=${encodeURIComponent(path)}`;
  const key = capabilityKey(ep, vaultId);
  // A daemon from before the capability accepts nothing else. Keeping the old
  // form for it is what lets the web build ship ahead of the CLI release.
  if (legacyCapabilityDaemons.has(key)) return `${base}&token=${encodeURIComponent(ep.token)}`;
  const held = capabilities.get(key);
  if (!held || held.expires_at <= Date.now()) {
    void ensureVaultCapability(ep, vaultId).catch(() => {});
    return null;
  }
  if (held.expires_at - Date.now() <= CAPABILITY_REFRESH_MS) void ensureVaultCapability(ep, vaultId).catch(() => {});
  return `${base}&cap=${encodeURIComponent(held.value)}`;
}

export class VaultWriteConflict extends Error {
  constructor(public current: VaultFileContent) {
    super("vault file changed on disk");
  }
}

export async function writeVaultFile(
  ep: VaultEndpoint,
  vaultId: string,
  path: string,
  content: string,
  baseEtag?: string,
  opts: VaultWriteOptions = {},
): Promise<VaultWriteResponse> {
  const res = await loopbackFetch(
    ep,
    `/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}${ignoredParam(opts)}${opts.force ? "&force=1" : ""}`,
    {
      method: "PUT",
      body: content,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        ...(baseEtag ? { "If-Match": baseEtag } : {}),
      },
    },
  );
  if (res.status === 409) {
    throw new VaultWriteConflict({
      content: await res.text(),
      mtime: parseInt(res.headers.get("X-Vault-Mtime") ?? "0", 10),
      size: parseInt(res.headers.get("X-Vault-Size") ?? "0", 10),
      etag: res.headers.get("ETag") ?? "",
    });
  }
  if (!res.ok) {
    // The daemon names why ("read-only", "binary", "bad path"); say it.
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new VaultRequestError(`vault write ${path}: ${res.status}${body.error ? ` ${body.error}` : ""}`, res.status, body.error);
  }
  return (await res.json()) as VaultWriteResponse;
}

export interface VaultWriteOptions {
  /** The path is one the scan flags ignored (a gitignored file opened from
   *  the tree or a link): the daemon writes those only when asked to. */
  ignored?: boolean;
  /** Write a file whose mode refuses writes (0444), keeping that mode: the
   *  person confirmed the overwrite. Still compare-and-swap on If-Match. */
  force?: boolean;
}

const ignoredParam = (opts: VaultWriteOptions) => (opts.ignored ? "&ignored=1" : "");

export async function vaultOp(ep: VaultEndpoint, vaultId: string, op: VaultOpRequest, opts: VaultWriteOptions = {}): Promise<VaultOpResponse> {
  const res = await loopbackFetch(ep, `/vault/op?vault=${encodeURIComponent(vaultId)}${ignoredParam(opts)}`, {
    method: "POST",
    body: JSON.stringify(op),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`vault op ${op.op} ${op.path}: ${res.status} ${detail}`);
  }
  return (await res.json()) as VaultOpResponse;
}

/** Subscribe to change events for one vault. Reconnects with backoff until
 *  disposed. `onDown` fires on a REAL drop only (never on disposal — an
 *  intentional close must not be mistaken for an outage, which previously put
 *  the store into a permanent rediscover-and-rescan loop). After several
 *  consecutive failures `onStale` fires once: the daemon likely restarted with
 *  a fresh port/token, so the caller should dispose and rediscover. */
export function subscribeVaultEvents(
  ep: VaultEndpoint,
  vaultId: string,
  handlers: {
    onEvent: (ev: VaultWsEvent) => void;
    onUp?: () => void;
    onDown?: () => void;
    onStale?: () => void;
  },
): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let retryMs = 1000;
  let failures = 0;
  let staleNotified = false;

  const host = hostOfVault(vaultId);
  const wire = wireVaultId(vaultId);
  // A host's socket drops when its forward closed or the SSH channel died:
  // reopen the forward before the next attempt (a live forward just answers
  // the probe). This machine's daemon has no such step.
  //
  // A host that could not be reached is not asked again on a timer: each ask
  // costs a relay round and an `ssh` probe on this machine. The socket waits
  // for the host's next forward, which the next use opens (a read, a save,
  // the header's machine chip).
  let parked: (() => void) | null = null;
  const retry = (at: VaultEndpoint | null) => {
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, 15_000);
    const owner = host ?? hostOfEndpoint(at);
    if (!owner) {
      setTimeout(connect, wait);
      return;
    }
    void reestablishHost(owner).then((fresh) => {
      if (disposed) return;
      if (fresh) {
        setTimeout(connect, wait);
        return;
      }
      parked?.();
      parked = onHostEndpointChange((device, ep) => {
        if (device !== owner || !ep) return;
        parked?.();
        parked = null;
        retryMs = 1000;
        connect();
      });
    });
  };
  const down = () => {
    failures += 1;
    handlers.onDown?.();
    if (failures >= 3 && !staleNotified) {
      staleNotified = true;
      handlers.onStale?.();
    }
  };

  const connect = () => {
    if (disposed) return;
    // Routed on every attempt: a host's forward may have reopened on a new
    // port since the last one, or be closed (then it is reopened first).
    const at = routeEndpoint(ep, vaultId);
    if (!at) {
      down();
      return retry(null);
    }
    ws = openWebSocket(loopbackWsUrl(at, "/vault/ws"));
    if (!ws) {
      // No socket can ever open against this endpoint: report it down and
      // stale at once so the caller rediscovers, and stop retrying it.
      handlers.onDown?.();
      if (!staleNotified) {
        staleNotified = true;
        handlers.onStale?.();
      }
      return;
    }
    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "hello", token: at.token, vault: wire }));
      retryMs = 1000;
      failures = 0;
      staleNotified = false;
      handlers.onUp?.();
    };
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(String(msg.data)) as VaultWsEvent;
        // The daemon names the vault by its own id.
        handlers.onEvent(ev.vault === wire ? { ...ev, vault: vaultId } : ev);
      } catch {}
    };
    ws.onclose = () => {
      if (disposed) return;
      down();
      retry(at);
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    disposed = true;
    parked?.();
    ws?.close();
  };
}
