// Which daemon a vault's requests go to.
//
// A host vault's id in this window names its machine: `<daemon id>@<device>`.
// A daemon derives a vault id from the folder's path, so a host laid out like
// this laptop (a cloud Mac, the same user) would otherwise hand back the id of
// a local vault, and the two would share one routing entry, one cache and one
// set of open buffers. The suffix never reaches a daemon: requests carry the
// daemon's own id (`wireVaultId`, `wirePath`), and ids coming back from a host
// are tagged on arrival (`tagHostVault`).
//
// The Files surface holds vaults from more than one daemon: this machine's,
// and a cloud host's reached through the SSH forward this machine's daemon
// opens (lib/terminal/endpoint.ts getTerminalEndpoint, packages/cli/src/cloud/
// hostForward.ts). Every request names a vault (`?vault=`, a WS hello), so the
// routing lives here, under the request helpers, and no caller has to know
// which machine a buffer, a search or a language server belongs to:
//
//   - a host's vault goes to that host's current forward, whatever
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
/** Every host a forward was ever opened to in this window, so an endpoint
 *  held across a lost forward is still known as that host's. */
const knownHosts = new Set<string>();
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
  if (ep) knownHosts.add(deviceId);
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

const HOST_SEP = "@";

/** This window's id for a vault a host's daemon calls `daemonId`. */
export function hostVaultId(daemonId: string, deviceId: string): string {
  return `${wireVaultId(daemonId)}${HOST_SEP}${deviceId}`;
}

/** The id the vault's own daemon knows it by. */
export function wireVaultId(vaultId: string): string {
  const at = vaultId.indexOf(HOST_SEP);
  return at < 0 ? vaultId : vaultId.slice(0, at);
}

/** The cloud host a vault lives on, or null for this machine's vaults. */
export function hostOfVault(vaultId: string | null | undefined): string | null {
  const at = vaultId ? vaultId.indexOf(HOST_SEP) : -1;
  return at < 0 ? null : vaultId!.slice(at + 1) || null;
}

/** A vault as a host's daemon described it, under this window's id for it. */
export function tagHostVault<V extends { id: string }>(vault: V, deviceId: string | null): V {
  return deviceId && hostOfVault(vault.id) !== deviceId ? { ...vault, id: hostVaultId(vault.id, deviceId) } : vault;
}

/** The host an endpoint reaches, or null for this machine's daemon. */
export function hostOfEndpoint(ep: Endpoint | null | undefined): string | null {
  if (!ep || (localEndpoint && ep.port === localEndpoint.port && ep.token === localEndpoint.token)) return null;
  return knownHosts.has(ep.deviceId) ? ep.deviceId : null;
}

/** The endpoint a request for `vaultId` must use, starting from the one the
 *  caller holds. The vault id alone decides the machine: a host's vault goes
 *  to that host's forward, this machine's vault to this machine's daemon,
 *  whichever endpoint the caller had in hand (the active vault's may be a
 *  host's while a local buffer saves). Null when the vault's daemon has no
 *  endpoint: a host's vault with no forward open, or a local vault while only
 *  a host endpoint is known. Neither machine stands in for the other, since
 *  both may hold a vault at the same path.
 *
 *  A request that names no vault (`/vault/roots`, `/vault/locate`) goes to
 *  the caller's endpoint, upgraded to its host's current forward. With no
 *  host in play (everyone without a cloud host) that is the caller's
 *  endpoint, unchanged. */
export function routeEndpoint(ep: Endpoint, vaultId?: string | null): Endpoint | null {
  const host = hostOfVault(vaultId);
  if (host) return hostEndpoints.get(host) ?? null;
  if (vaultId) return localEndpoint ?? (hostOfEndpoint(ep) ? null : ep);
  if (!hostEndpoints.size) return ep;
  return hostEndpoints.get(ep.deviceId) ?? ep;
}

/** `routeEndpoint`, opening the host's forward first when none is open. Null
 *  when the host cannot be reached. */
export async function routeEndpointOpening(ep: Endpoint, vaultId?: string | null): Promise<Endpoint | null> {
  const routed = routeEndpoint(ep, vaultId);
  const host = hostOfVault(vaultId);
  return routed || !host ? routed : reestablishHost(host);
}

/** The vault a loopback path names (`?vault=`), for routing a request built
 *  by code that only passes an endpoint and a path. */
export function vaultOfPath(path: string): string | null {
  const q = path.indexOf("?");
  return q < 0 ? null : new URLSearchParams(path.slice(q + 1)).get("vault");
}

/** A loopback path as the vault's daemon reads it: `?vault=` carries the
 *  daemon's own id. Any other path comes back as it was. */
export function wirePath(path: string): string {
  const vault = vaultOfPath(path);
  if (!vault || !hostOfVault(vault)) return path;
  const q = path.indexOf("?");
  const params = new URLSearchParams(path.slice(q + 1));
  params.set("vault", wireVaultId(vault));
  return `${path.slice(0, q)}?${params.toString()}`;
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
  knownHosts.clear();
  reestablishing.clear();
  listeners.clear();
  establisher = null;
  localEndpoint = null;
}
