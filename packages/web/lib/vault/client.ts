// Loopback client for the daemon's vault bridge. The vault routes live on the
// same per-boot-token HTTP server as the integrated terminal, so endpoint
// discovery is shared with lib/terminal/endpoint.ts — whichever daemon answers
// the probe is the machine the browser is physically on, and that machine's
// filesystem is the vault's canonical store.

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
  termHttpBase,
  type TerminalEndpoint,
} from "../terminal/endpoint";

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

async function vaultFetch(ep: VaultEndpoint, path: string, init?: RequestInit): Promise<Response> {
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
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function listVaults(ep: VaultEndpoint): Promise<VaultInfo[]> {
  const res = await vaultFetch(ep, "/vault/roots");
  if (!res.ok) throw new VaultRequestError(`vault roots: ${res.status}`, res.status);
  const body = (await res.json()) as { vaults: VaultInfo[] };
  return body.vaults ?? [];
}

/** The vault holding a local path, registered by the daemon when none did
 *  (GET /vault/locate). Null when the path does not exist on that machine;
 *  throws VaultRequestError(404) for a daemon that predates the route. */
export async function locateVault(ep: VaultEndpoint, localPath: string): Promise<VaultLocateResponse | null> {
  const res = await vaultFetch(ep, `/vault/locate?path=${encodeURIComponent(localPath)}`);
  if (res.ok) return (await res.json()) as VaultLocateResponse;
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
    vaultFetch(ep, `/vault/scan?${query}`, {
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
export async function ensureVaultCapability(ep: VaultEndpoint, vaultId: string): Promise<void> {
  const key = capabilityKey(ep, vaultId);
  if (legacyCapabilityDaemons.has(key)) return;
  const held = capabilities.get(key);
  if (held && held.expires_at - Date.now() > CAPABILITY_REFRESH_MS) return;
  const inFlight = capabilityMints.get(key);
  if (inFlight) return inFlight;

  const mint = (async () => {
    try {
      const res = await vaultFetch(ep, `/vault/cap?vault=${encodeURIComponent(vaultId)}`);
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
}

export async function readVaultFile(
  ep: VaultEndpoint,
  vaultId: string,
  path: string,
): Promise<VaultFileContent | null> {
  const res = await vaultFetch(
    ep,
    `/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`vault file ${path}: ${res.status}`);
  return {
    content: await res.text(),
    mtime: parseInt(res.headers.get("X-Vault-Mtime") ?? "0", 10),
    size: parseInt(res.headers.get("X-Vault-Size") ?? "0", 10),
    etag: res.headers.get("ETag") ?? "",
  };
}

/** URL for an asset (image etc.) — usable directly as an <img> src.
 *  Null while no capability is held yet: scanVault mints one before any note
 *  renders, so this is the cold path only, and it starts a mint of its own. */
export function vaultAssetUrl(ep: VaultEndpoint, vaultId: string, path: string): string | null {
  const base = `${termHttpBase(ep)}/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`;
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
): Promise<VaultWriteResponse> {
  const res = await vaultFetch(
    ep,
    `/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}`,
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
  if (!res.ok) throw new Error(`vault write ${path}: ${res.status}`);
  return (await res.json()) as VaultWriteResponse;
}

export async function vaultOp(ep: VaultEndpoint, vaultId: string, op: VaultOpRequest): Promise<VaultOpResponse> {
  const res = await vaultFetch(ep, `/vault/op?vault=${encodeURIComponent(vaultId)}`, {
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

  const connect = () => {
    if (disposed) return;
    ws = new WebSocket(`ws://127.0.0.1:${ep.port}/vault/ws`);
    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "hello", token: ep.token, vault: vaultId }));
      retryMs = 1000;
      failures = 0;
      staleNotified = false;
      handlers.onUp?.();
    };
    ws.onmessage = (msg) => {
      try {
        handlers.onEvent(JSON.parse(String(msg.data)) as VaultWsEvent);
      } catch {}
    };
    ws.onclose = () => {
      if (disposed) return;
      failures += 1;
      handlers.onDown?.();
      if (failures >= 3 && !staleNotified) {
        staleNotified = true;
        handlers.onStale?.();
      }
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 15_000);
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    disposed = true;
    ws?.close();
  };
}
