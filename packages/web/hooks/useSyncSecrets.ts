// Vault secrets: feeder + reader.
//
// One snapshot query (registry entry `secrets`) carries every secret the
// viewer can read, metadata only, mounted once by HostFeeders. The page shows
// the active team's secrets beside the viewer's personal ones, so the reader
// spans both workspace keys.

import { api } from "@codecast/convex/convex/_generated/api";
import type { SecretMeta } from "@codecast/shared/contracts/secrets";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspacesCollection } from "./useWorkspaceCollection";
import { useInboxStore } from "../store/inboxStore";

export function useSyncSecrets(enabled = true) {
  useSyncCollection("secrets", api.secrets.list, enabled ? {} : "skip");
}

/** Rows re-render on the fields the list and the detail panel show. */
export const secretSig = (s: SecretMeta) =>
  `${s.name}|${s.status}|${s.short_id ?? ""}|${(s.env ?? []).join(",")}|${(s.sites ?? []).join(",")}|${s.note ?? ""}|${s.updated_at}|${s.last_used_at ?? 0}|${s.use_count ?? 0}|${s.kind}`;

/** The workspaces the Vault lists: the active team's (when one is active) and the viewer's own. */
export function useVaultKeys(): { team: string | null; personal: string | null } {
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? null);
  const userId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  return { team: teamId ? `team:${teamId}` : null, personal: userId ? `user:${userId}` : null };
}

export function useSecrets(): SecretMeta[] {
  const { team, personal } = useVaultKeys();
  return useWorkspacesCollection<SecretMeta>("secrets", secretSig, [team, personal]);
}
