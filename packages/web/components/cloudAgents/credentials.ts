import type { Device } from "../DeviceBadge";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";

/** A machine is connected to a key-based provider when it manages that provider's key. */
export function hasCloudAgentKey(keyProvider: string): (device: Device) => boolean {
  return (device) => deviceManagedKeys(device).managedIds.includes(keyProvider);
}
