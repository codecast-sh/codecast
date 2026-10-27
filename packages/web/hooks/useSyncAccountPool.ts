// The team's shared account pool (convex/accountPool.ts), store-fed. The
// feeder mounts on each surface that shows the pool (Settings > Claude
// Accounts, Settings > Account pool); both read the store through the readers.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

export type PoolSplit = { user_id: string; name: string; tokens: number };
export type PoolAccount = {
  _id: string;
  share_key: string;
  team_id: string;
  user_id: string;
  contributor_name: string;
  mine: boolean;
  email: string;
  holder_device_id: string;
  profile_name: string | null;
  tier: string | null;
  subscription: string | null;
  usage: any;
  machines: number;
  shared_at: number;
  split: PoolSplit[];
};

/** Feeder: the complete pool of every team the viewer is on (snapshot). */
export function useSyncAccountPool() {
  return useSyncCollection("accountPool", api.accountPool.listPool, {});
}

/** The fields the pool surfaces draw; a re-sent meter or split wakes them, nothing else does. */
const poolSig = (r: PoolAccount) =>
  `${r.team_id}|${r.email}|${r.machines}|${r.usage?.fetched_at ?? 0}|${r.split.map((s) => `${s.user_id}:${s.tokens}`).join(",")}|${r.profile_name ?? ""}`;

/** Reader: the pool rows, optionally narrowed to one team. */
export function useAccountPool(teamId?: string | null): PoolAccount[] {
  return useCollectionRows<PoolAccount>("accountPool", {
    where: teamId ? (r) => String(r.team_id) === teamId : undefined,
    sig: poolSig,
  });
}
