import type { Patch } from "mutative";
import { CLIENT_SYNC_REGISTRY, type ClientSyncRegistryEntry, REPLICATION_CLASSIFICATION } from "./clientSyncRegistry";

export function followerPersistencePatches(patches: Patch[]): Patch[] {
  return patches.filter((patch) => {
    const key = String(patch.path[0]) as keyof typeof CLIENT_SYNC_REGISTRY;
    const entry: ClientSyncRegistryEntry | undefined = CLIENT_SYNC_REGISTRY[key];
    return REPLICATION_CLASSIFICATION[key] === "local" && entry?.persistence?.perWindow === true;
  });
}
