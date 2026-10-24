// Vault secrets: feeder + reader.
//
// One snapshot query (registry entry `secrets`) carries every secret the
// viewer can read, metadata only, mounted once by HostFeeders. The page shows
// a team's secrets beside the viewer's personal ones, so the reader spans both
// workspace keys.

import { useCallback, useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { payloadFingerprint, type SecretMeta, type SecretPayload, type SecretVersionMeta } from "@codecast/shared/contracts/secrets";
import { fillRequest, isStaged, stagedSwap, vaultFailure } from "../components/secrets/vaultModel";
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

/** Every secret the viewer holds, in each of their teams and their own: what a short id in a transcript resolves against. */
export function useHeldSecrets(): SecretMeta[] {
  const teamKeys = useInboxStore((s) => (s.teams ?? []).map((t: any) => `team:${t._id}`).join("\n"));
  const personal = useInboxStore((s) => (s.currentUser?._id ? `user:${s.currentUser._id}` : null));
  const keys = useMemo(() => [...(teamKeys ? teamKeys.split("\n") : []), personal], [teamKeys, personal]);
  return useWorkspacesCollection<SecretMeta>("secrets", secretSig, keys);
}

export type SecretEvent = Extract<FunctionReturnType<typeof api.secrets.events>, unknown[]>[number];
type SecretHistory = { events: SecretEvent; versions: SecretVersionMeta };

/**
 * A secret's activity or previous values for its detail panel: the live query
 * feeds the store (secretHistory) and the panel paints from there, so a secret
 * opened before shows its last answer at once. `rows` is undefined until there
 * is an answer, cached or fresh; `error` is the query's terminal failure.
 */
export function useSecretHistory<L extends keyof SecretHistory>(list: L, id: string, enabled: boolean) {
  const key = `${list}:${id}`;
  const query = list === "events" ? api.secrets.events : api.secrets.versions;
  // A stable select: the feeder applies again whenever it changes, and a fresh
  // one each render would write the last answer back over a staged press.
  const select = useCallback((data: unknown) => (Array.isArray(data) ? [{ _id: key, rows: data }] : []), [key]);
  const { error, retry } = useSyncCollection("secretHistory", query, enabled ? { ref: id } : "skip", { select });
  const rows = useInboxStore((s) => (s as any).secretHistory?.[key]?.rows) as SecretHistory[L][] | undefined;
  return { rows, error, retry };
}

/** Fills a requested secret: the row reads ready at once and goes back to requested on a refusal (fillRequest). */
export function useFillRequest() {
  const fulfill = useAction(api.secrets.fulfill);
  const stage = useInboxStore((s) => s.stageSecret);
  return (row: SecretMeta, payload: SecretPayload) => fillRequest(row, payload, { stage, fulfill });
}

/** The value a swap shows, held over the list's pushes until the server's row carries it (a refusal holds the old one, which the next push retires). */
const SWAP_HOLD = ["fingerprint"] as const;

const historyOf = (key: string) => (useInboxStore.getState() as any).secretHistory?.[key]?.rows as object[] | undefined;

/**
 * Replaces a secret's value (rotate) or puts a kept one back (restore),
 * local-first: the row, its Activity and its Previous show the swap at once
 * (stagedSwap), its new lines pending until the server answers them, and a
 * refusal puts all three back. The value goes only to the action. Answers the
 * refusal's words, or null.
 */
export function useSwapValue() {
  const rotate = useAction(api.secrets.rotate);
  const restore = useAction(api.secrets.restore);
  const stage = useInboxStore((s) => s.stageSecret);
  const stageHistory = useInboxStore((s) => s.stageSecretHistory);
  return async (row: SecretMeta, swap: { kind: "rotated"; payload: SecretPayload } | { kind: "restored"; version: SecretVersionMeta }): Promise<string | null> => {
    const keys = { events: `events:${row._id}`, versions: `versions:${row._id}` };
    const before = { events: historyOf(keys.events), versions: historyOf(keys.versions) as SecretVersionMeta[] | undefined };
    const me = useInboxStore.getState().currentUser?.name ?? "You";
    const staged = stagedSwap(row, swap.kind === "rotated" ? { kind: "rotated", fingerprint: payloadFingerprint(row.kind, swap.payload) } : swap, { me, now: Date.now(), ...before });
    stage(staged.row, SWAP_HOLD);
    stageHistory(keys.events, staged.events);
    if (staged.versions) stageHistory(keys.versions, staged.versions);
    const res: any = await (swap.kind === "rotated" ? rotate({ ref: row._id, payload: swap.payload }) : restore({ ref: row._id, version: swap.version._id })).catch(vaultFailure);
    if (!res?.error) return null;
    stage(row, SWAP_HOLD);
    stageHistory(keys.events, before.events);
    if (staged.versions) stageHistory(keys.versions, before.versions);
    return String(res.error);
  };
}

/** A value swap pressed here that the server has not answered in Activity yet. */
export function useSwapPending(id: string): boolean {
  return useInboxStore((s) => !!((s as any).secretHistory?.[`events:${id}`]?.rows as object[] | undefined)?.some(isStaged));
}

/** Ask first's field lock while the server has not echoed a press: its value is the one pressed. */
export function useAskFirstLock(id: string): { value?: unknown; ts: number } | undefined {
  return useInboxStore((s) => s.pending[`secrets:${id}:ask_first`] as { value?: unknown; ts: number } | undefined);
}
