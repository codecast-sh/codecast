// The rules that tie a cloud host's vaults to this machine's: which vaults a
// path may resolve against, how a host vault is named in the picker, and where
// the same repository sits on the other machine (the header's switch).

import type { VaultInfo } from "@codecast/shared/contracts";
import { deviceDisplayName } from "@codecast/shared/contracts";
import { useInboxStore } from "../../../store/inboxStore";
import { sameNamedCheckoutPaths } from "../vaultHref";
import { hostOfVault } from "./routes";

/** The host's name for a device, from the roster; the short id when the
 *  roster has not loaded. */
export function hostLabel(deviceId: string): string {
  const roster = (useInboxStore.getState().machineRoster ?? []) as Array<{ device_id: string; label?: string; platform?: string; is_remote?: boolean }>;
  const d = roster.find((r) => r.device_id === deviceId);
  return d ? deviceDisplayName({ label: d.label ?? "", platform: d.platform ?? "", is_remote: d.is_remote }) : deviceId.slice(0, 8);
}

/** A host vault carries its machine in its name, so the picker never shows
 *  two "app" rows that open different machines' files. */
export function hostVaultName(name: string, deviceId: string): string {
  const suffix = ` · ${hostLabel(deviceId)}`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

/** The vaults on one machine: a host's by device id, this machine's with null.
 *  A path from a host session resolves only against that host's vaults. */
export function vaultsOn<V extends { id: string }>(vaults: ReadonlyArray<V>, deviceId: string | null): V[] {
  return vaults.filter((v) => hostOfVault(v.id) === deviceId);
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
  const inside = (p: string, root: string) => p === root || p.startsWith(`${root.replace(/\/+$/, "")}/`);
  // The same folder on both machines (a cloud Mac with this laptop's layout)
  // is its own counterpart; otherwise the checkout with the same name.
  const mapped = others.some((v) => inside(abs, v.root)) ? abs : sameNamedCheckoutPaths(abs, others.map((v) => v.root))[0];
  if (!mapped) return null;
  const holder = others.filter((v) => inside(mapped, v.root)).sort((a, b) => b.root.length - a.root.length)[0];
  return holder ? { deviceId: hostOfVault(holder.id), abs: mapped } : null;
}
