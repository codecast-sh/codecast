// Loopback client for the daemon's vault bridge. The vault routes live on the
// same per-boot-token HTTP server as the integrated terminal, so endpoint
// discovery is shared with lib/terminal/endpoint.ts — whichever daemon answers
// the probe is the machine the browser is physically on, and that machine's
// filesystem is the vault's canonical store.

import type { ConvexReactClient } from "convex/react";
import type {
  VaultInfo,
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

async function vaultFetch(ep: VaultEndpoint, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${termHttpBase(ep)}${path}`, {
    ...init,
    headers: { ...authHeaders(ep), ...(init?.headers as Record<string, string>) },
    signal: init?.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    // Chrome 142+ Local Network Access: declaring the target address space
    // lets Chrome classify the loopback destination before DNS, which exempts
    // the request from mixed-content blocking on the hosted https origin (the
    // user grants a one-time per-origin permission instead). Not yet in TS DOM
    // types, hence the cast.
    ...({ targetAddressSpace: "loopback" } as Record<string, unknown>),
  });
}

export async function listVaults(ep: VaultEndpoint): Promise<VaultInfo[]> {
  const res = await vaultFetch(ep, "/vault/roots");
  if (!res.ok) throw new Error(`vault roots: ${res.status}`);
  const body = (await res.json()) as { vaults: VaultInfo[] };
  return body.vaults ?? [];
}

export async function scanVault(ep: VaultEndpoint, vaultId: string): Promise<VaultScanResponse> {
  const res = await vaultFetch(ep, `/vault/scan?vault=${encodeURIComponent(vaultId)}`, {
    // A big vault walk can exceed the default budget.
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`vault scan: ${res.status}`);
  return (await res.json()) as VaultScanResponse;
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
 *  The token rides as a query param because img tags can't set headers; the
 *  daemon accepts either form on GET /vault/file. */
export function vaultAssetUrl(ep: VaultEndpoint, vaultId: string, path: string): string {
  return `${termHttpBase(ep)}/vault/file?vault=${encodeURIComponent(vaultId)}&path=${encodeURIComponent(path)}&token=${encodeURIComponent(ep.token)}`;
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
 *  disposed; `onDown` fires when the socket drops so the caller can surface
 *  connection state and trigger a rescan on recovery. */
export function subscribeVaultEvents(
  ep: VaultEndpoint,
  vaultId: string,
  handlers: {
    onEvent: (ev: VaultWsEvent) => void;
    onUp?: () => void;
    onDown?: () => void;
  },
): () => void {
  let ws: WebSocket | null = null;
  let disposed = false;
  let retryMs = 1000;

  const connect = () => {
    if (disposed) return;
    ws = new WebSocket(`ws://127.0.0.1:${ep.port}/vault/ws`);
    ws.onopen = () => {
      ws?.send(JSON.stringify({ type: "hello", token: ep.token, vault: vaultId }));
      retryMs = 1000;
      handlers.onUp?.();
    };
    ws.onmessage = (msg) => {
      try {
        handlers.onEvent(JSON.parse(String(msg.data)) as VaultWsEvent);
      } catch {}
    };
    ws.onclose = () => {
      handlers.onDown?.();
      if (!disposed) {
        setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 15_000);
      }
    };
    ws.onerror = () => ws?.close();
  };

  connect();
  return () => {
    disposed = true;
    ws?.close();
  };
}
