// Vault secrets: feeder + reader.
//
// One snapshot query (registry entry `secrets`) carries every secret the
// viewer can read, metadata only, mounted once by HostFeeders. The page shows
// a team's secrets beside the viewer's personal ones, so the reader spans both
// workspace keys.

import { useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { SecretMeta, SecretPayload } from "@codecast/shared/contracts/secrets";
import { fillRequest } from "../components/secrets/vaultModel";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspacesCollection } from "./useWorkspaceCollection";
import { useInboxStore } from "../store/inboxStore";
import { syncMetaKey } from "./syncMetaKeys";
import { useWatchEffect } from "./useWatchEffect";

/** Stamped when the feeder's first answer lands; syncMeta persists and replicates, so every window reads it. */
const SECRETS_FED = syncMetaKey("secrets", "viewer");

export function useSyncSecrets(enabled = true) {
  const { ready } = useSyncCollection("secrets", api.secrets.list, enabled ? {} : "skip");
  const recordSyncMeta = useInboxStore((s) => s.recordSyncMeta);
  useWatchEffect(() => {
    if (ready) recordSyncMeta(SECRETS_FED, { backfilledAt: Date.now() });
  }, [ready]);
}

/** The server has answered for the Vault on this device, so an empty store means an empty Vault. */
export function useSecretsLoaded(): boolean {
  return useInboxStore((s) => !!s.syncMeta?.[SECRETS_FED]?.backfilledAt);
}

/** Rows re-render on the fields the list and the detail panel show. */
export const secretSig = (s: SecretMeta) =>
  `${s.name}|${s.status}|${s.short_id ?? ""}|${(s.env ?? []).join(",")}|${(s.sites ?? []).join(",")}|${s.note ?? ""}|${s.updated_at}|${s.value_updated_at ?? 0}|${s.last_used_at ?? 0}|${s.use_count ?? 0}|${s.kind}|${s.ask_first ? 1 : 0}|${s.version_count ?? 0}|${s.fingerprint ?? ""}|${s.signin_expires_at ?? 0}|${s.has_otp ?? ""}|${s.updated_by_name ?? ""}`;

/** Where a new secret can go: a team (the active one unless another is named) by key, id and name, and the viewer's own workspace. */
export type VaultScope = { team: { key: string; id: string; name: string } | null; personal: string | null };

export function useVaultScope(teamId?: string | null): VaultScope {
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? null);
  const userId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const id = teamId === undefined ? activeTeamId : teamId;
  const name = useInboxStore((s) => (id ? (s.teams ?? []).find((t: any) => String(t._id) === id)?.name ?? "Team" : null));
  const personal = userId ? `user:${userId}` : null;
  return useMemo(() => ({ team: id && name ? { key: `team:${id}`, id, name } : null, personal }), [id, name, personal]);
}

/** The Vault's rows: the team's in that scope (the active one unless another is named) beside the viewer's own. */
export function useSecrets(teamId?: string | null): SecretMeta[] {
  const { team, personal } = useVaultScope(teamId);
  return useWorkspacesCollection<SecretMeta>("secrets", secretSig, [team?.key ?? null, personal]);
}

/** Fills a requested secret: the row reads ready at once and goes back to requested on a refusal (fillRequest). */
export function useFillRequest() {
  const fulfill = useAction(api.secrets.fulfill);
  const stage = useInboxStore((s) => s.stageSecret);
  return (row: SecretMeta, payload: SecretPayload) => fillRequest(row, payload, { stage, fulfill });
}
