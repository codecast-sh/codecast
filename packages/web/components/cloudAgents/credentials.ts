import type { CloudAgentProviderId, CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";

type ConnectedCheck = (device: Device) => boolean;

/** A machine is connected to a key-based provider when it manages that provider's key. */
function hasCloudAgentKey(keyProvider: string): ConnectedCheck {
  return (device) => deviceManagedKeys(device).managedIds.includes(keyProvider);
}

/** Providers whose credential is not a Provider Keys entry (a login) name their own check here. */
const LOGIN_CHECKS: Partial<Record<CloudAgentProviderId, ConnectedCheck>> = {};

const NEVER: ConnectedCheck = () => false;
const checks = new Map<string, ConnectedCheck>();

/** Whether a machine can drive a provider's agents. One stable function per provider. */
export function cloudAgentConnected(spec: CloudAgentProviderSpec): ConnectedCheck {
  let check = checks.get(spec.id);
  if (!check) {
    check = LOGIN_CHECKS[spec.id as CloudAgentProviderId] ?? (spec.keyProvider ? hasCloudAgentKey(spec.keyProvider) : NEVER);
    checks.set(spec.id, check);
  }
  return check;
}
