// Which daemon a vault's requests go to.
//
// The Files surface holds vaults from more than one daemon: this machine's,
// and a cloud host's reached through the SSH forward this machine's daemon
// opens (lib/terminal/endpoint.ts getTerminalEndpoint, packages/cli/src/cloud/
// hostForward.ts). Every request names a vault (`?vault=`, a WS hello), so the
// routing lives here, under the request helpers, and no caller has to know
// which machine a buffer, a search or a language server belongs to:
//
//   - a vault bound to a host goes to that host's current forward, whatever
//     endpoint the caller had in hand (a buffer saved after the person moved
//     to another vault, an endpoint captured before a reconnect);
//   - an endpoint that names a host device is upgraded to that host's current
//     forward, so a port that died with an idle forward is never dialed again
//     once a newer one exists.
//
// A forward closes after 10 minutes with no connection. `reestablishHost`
// opens a fresh one (deduped); request helpers call it when a host endpoint
// refuses a connection, and retry only when the port changed, which proves the
// first attempt reached nothing.
//
// Tokens stay in this module's memory, as the terminal path keeps its
// forwards: nothing here is ever written to storage.

import type { TerminalEndpoint } from "../../terminal/endpoint";

type Endpoint = TerminalEndpoint;

/** Opens (or revalidates) the forward to a host and returns its endpoint, or
 *  null when the host cannot be reached from this machine. The store supplies
 *  it (it holds the Convex client the relay needs). */
export type HostEstablisher = (deviceId: string) => Promise<Endpoint | null>;

const hostEndpoints = new Map<string, Endpoint>();
const vaultHosts = new Map<string, string>();
const reestablishing = new Map<string, Promise<Endpoint | null>>();
let establisher: HostEstablisher | null = null;
let localEndpoint: Endpoint | null = null;
const listeners = new Set<(deviceId: string, ep: Endpoint | null) => void>();

export function setHostEstablisher(fn: HostEstablisher | null): void {
  establisher = fn;
}

/** This machine's daemon, for the routes that belong to the person rather
 *  than to a vault (their vimrc). */
export function setLocalEndpoint(ep: Endpoint | null): void {
  localEndpoint = ep;
}

export function localDaemonEndpoint(): Endpoint | null {
  return localEndpoint;
}

export function setHostEndpoint(deviceId: string, ep: Endpoint | null): void {
  const prev = hostEndpoints.get(deviceId) ?? null;
  if (ep) hostEndpoints.set(deviceId, ep);
  else hostEndpoints.delete(deviceId);
  if (prev?.port !== ep?.port || prev?.token !== ep?.token) for (const l of listeners) l(deviceId, ep);
}

export function hostEndpoint(deviceId: string): Endpoint | null {
  return hostEndpoints.get(deviceId) ?? null;
}

/** Called when a host's forward changes (opened, reopened on a new port, lost). */
export function onHostEndpointChange(fn: (deviceId: string, ep: Endpoint | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function bindVaultToHost(vaultId: string, deviceId: string): void {
  vaultHosts.set(vaultId, deviceId);
}

export function unbindVault(vaultId: string): void {
  vaultHosts.delete(vaultId);
}

/** The cloud host a vault lives on, or null for this machine's vaults. */
export function hostOfVault(vaultId: string | null | undefined): string | null {
  return vaultId ? (vaultHosts.get(vaultId) ?? null) : null;
}

/** The host an endpoint reaches, or null for this machine's daemon. */
export function hostOfEndpoint(ep: Endpoint | null | undefined): string | null {
  if (!ep || (localEndpoint && ep.port === localEndpoint.port && ep.token === localEndpoint.token)) return null;
  return hostEndpoints.has(ep.deviceId) ? ep.deviceId : null;
}

/** The endpoint a request for `vaultId` must use, starting from the one the
 *  caller holds. With no bindings (everyone without a cloud host) it is the
 *  caller's endpoint, unchanged. */
export function routeEndpoint(ep: Endpoint, vaultId?: string | null): Endpoint {
  if (!hostEndpoints.size) return ep;
  const host = hostOfVault(vaultId);
  if (host) return hostEndpoints.get(host) ?? ep;
  return hostEndpoints.get(ep.deviceId) ?? ep;
}

/** The vault a loopback path names (`?vault=`), for routing a request built
 *  by code that only passes an endpoint and a path. */
export function vaultOfPath(path: string): string | null {
  const q = path.indexOf("?");
  return q < 0 ? null : new URLSearchParams(path.slice(q + 1)).get("vault");
}

/**
 * Open a fresh forward to a host after its endpoint stopped answering. Deduped
 * per host, so a burst of failed requests (a search, a status, a socket) costs
 * one relay round. Resolves to the endpoint now in use, or null when the host
 * is out of reach (the bound endpoint is then dropped, and the store shows the
 * host as unreachable).
 */
export function reestablishHost(deviceId: string): Promise<Endpoint | null> {
  const inflight = reestablishing.get(deviceId);
  if (inflight) return inflight;
  if (!establisher) return Promise.resolve(hostEndpoints.get(deviceId) ?? null);
  const run = establisher(deviceId)
    .catch(() => null)
    .then((ep) => {
      setHostEndpoint(deviceId, ep);
      return ep;
    })
    .finally(() => reestablishing.delete(deviceId));
  reestablishing.set(deviceId, run);
  return run;
}

/** Tests: forget every binding. */
export function _resetHostRoutesForTests(): void {
  hostEndpoints.clear();
  vaultHosts.clear();
  reestablishing.clear();
  listeners.clear();
  establisher = null;
  localEndpoint = null;
}
