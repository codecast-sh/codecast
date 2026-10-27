// The team's shared account pool (convex/accountPool.ts), registered in
// CLIENT_SYNC_REGISTRY by spread (store/clientSyncRegistry.ts).
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const POOL_SYNC_COLLECTIONS = {
  // Every account in the pools of the viewer's teams (accountPool.listPool):
  // one row per account per team, with its contributor, the holder's meter
  // and who spent it this week. Snapshot: the answer is the whole visible
  // set, so a share taken back is gone on the next push. localFirst: the
  // share pill (setAccountShares) adds a stub row or drops rows on the draft;
  // the stub carries the row's natural key (share_key: account and team), so
  // the server row supersedes it. The meter and the split are nested and
  // change with no scalar beside them, so they compare by content.
  accountPool: {
    persistence: { kind: "collection", key: "accountPool" },
    hydration: { phase: "deferred" },
    localFirst: true,
    sync: { rowKey: "share_key", deepFields: ["usage", "split"] },
    feeds: ["accountPool.listPool"],
    writtenBy: ["accountPool"],
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
