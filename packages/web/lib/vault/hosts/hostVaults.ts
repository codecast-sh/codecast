// The rules that tie a cloud host's vaults to this machine's: which vaults a
// path may resolve against, and where the same repository sits on the other
// machine (the header's switch). The picker draws a host vault's machine from
// its id (VaultHostTag); the vault keeps the name its daemon gave it.

import type { VaultInfo } from "@codecast/shared/contracts";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../store/inboxStore";
import { resolveVaultTarget, sameNamedCheckoutPaths } from "../vaultHref";
import { hostOfVault } from "./routes";

/** The host's name for a device, from the roster; the short id when the
 *  roster has not loaded. For one-off text (an error line); a component reads
 *  the roster row itself (useRosterDevice). */
export function hostLabel(deviceId: string): string {
  const roster = (useInboxStore.getState().machineRoster ?? []) as Array<{ device_id: string; label?: string; platform?: string; is_remote?: boolean }>;
  const d = roster.find((r) => r.device_id === deviceId);
  return d ? deviceDisplayName({ label: d.label ?? "", platform: d.platform ?? "", is_remote: d.is_remote }) : deviceId.slice(0, 8);
}

/** The vaults on one machine: a host's by device id, this machine's with null.
 *  A path from a host session resolves only against that host's vaults. */
export function vaultsOn<V extends { id: string }>(vaults: ReadonlyArray<V>, deviceId: string | null): V[] {
  return vaults.filter((v) => hostOfVault(v.id) === deviceId);
}

/** `rel` under a vault root; the root itself for no `rel`. */
export function joinVaultPath(root: string, rel: string | null | undefined): string {
  return rel ? `${root.replace(/\/+$/, "")}/${rel}` : root;
}

/**
 * The host path for `rel` in a local checkout that stood in for a host link
 * naming `hostAbs`: the host's folder is `hostAbs` with the part the remap
 * carried over (sameNamedCheckoutPaths) taken off, and `rel` goes under it.
 * `hostAbs` itself when the checkout is not where the remap put it.
 */
export function hostPathFor(hostAbs: string, localRoot: string, rel: string | null): string {
  const root = localRoot.replace(/\/+$/, "");
  const mapped = hostAbs === root || hostAbs.startsWith(`${root}/`) ? hostAbs : sameNamedCheckoutPaths(hostAbs, [root])[0];
  if (!mapped) return hostAbs;
  const rest = mapped.slice(root.length);
  return joinVaultPath(rest ? hostAbs.slice(0, hostAbs.length - rest.length) : hostAbs, rel);
}

/**
 * Where `abs` (a path inside a vault on one machine) sits on the other side:
 * a host path maps into this machine's same-named checkout, a local path into
 * the same-named checkout on a host whose vault this window holds. Only roots
 * already known count (this machine lists every project it has), so this asks
 * no daemon. Null when the other side has no such checkout.
 */
export function counterpartPath(
  abs: string,
  fromDevice: string | null,
  vaults: ReadonlyArray<VaultInfo>,
): { deviceId: string | null; abs: string } | null {
  const others = fromDevice ? vaultsOn(vaults, null) : vaults.filter((v) => hostOfVault(v.id));
  // The same folder on both machines (a cloud Mac with this laptop's layout)
  // is its own counterpart; otherwise the checkout with the same name.
  const mapped = resolveVaultTarget(abs, others) ? abs : sameNamedCheckoutPaths(abs, others.map((v) => v.root))[0];
  const holder = mapped ? resolveVaultTarget(mapped, others) : null;
  return holder ? { deviceId: hostOfVault(holder.vaultId), abs: mapped! } : null;
}
