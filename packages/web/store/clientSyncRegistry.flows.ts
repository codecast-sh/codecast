// The flows view's synced collections, registered in CLIENT_SYNC_REGISTRY by
// spread (store/clientSyncRegistry.ts), kept here to hold that file under its size.
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const FLOW_SYNC_COLLECTIONS = {
  // A team's live flows (convex liveFlows.forTeam, flows doc of Oct 23): the
  // library flow switched on, its sources, its switch and caps, and its queue
  // as task ids in start order (each problem's facts are its task row's).
  // localFirst: the switch flips the row in the draft (setLiveFlowOn) and
  // holds until the server echoes it.
  liveFlows: {
    persistence: { kind: "collection", key: "liveFlows" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    indexes: "_id, team_id",
    sync: { isDelta: true, deepFields: ["queue", "running", "sources", "caps", "load", "flow", "watcher"] },
    feeds: ["liveFlows.forTeam"],
  },
  // The flows a team's sessions ran or defined (convex flowLibrary.sessionFlows):
  // each distinct graph once, with the runs, sessions and people that used it
  // and where it was saved in the library.
  // localFirst: Save marks the row saved in the draft (saveSessionFlow).
  sessionFlows: {
    persistence: { kind: "collection", key: "sessionFlows" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    indexes: "_id, graph_hash",
    // A complete snapshot of the workspace's session flows each push.
    sync: { deepFields: ["nodes", "edges", "runs", "sessions", "by", "saved"] },
    feeds: ["flowLibrary.sessionFlows"],
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
