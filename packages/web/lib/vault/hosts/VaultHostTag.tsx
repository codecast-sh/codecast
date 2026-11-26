"use client";

// The machine a host vault lives on, drawn beside its name wherever vaults
// are listed, so two "app" rows that open different machines' files never
// look alike. Read live from the roster: a name that arrives after the vault
// was listed shows as soon as it does. Nothing for this machine's vaults.

import { DeviceIcon, deviceDisplayName, useRosterDevice } from "../../../components/DeviceBadge";
import { hostOfVault } from "./routes";

export function VaultHostTag({ vaultId, className = "" }: { vaultId: string; className?: string }) {
  const host = hostOfVault(vaultId);
  const roster = useRosterDevice(host);
  if (!host) return null;
  return (
    <span className={`inline-flex items-center gap-1 min-w-0 text-meta text-sol-violet ${className}`} data-vault-host={host}>
      <DeviceIcon d={roster ?? { platform: "", is_remote: true }} />
      <span className="truncate">{roster ? deviceDisplayName(roster) : host.slice(0, 8)}</span>
    </span>
  );
}
