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
    // altKey: a flow started on the web paints as a row keyed by its client key, which the server row carries.
    sync: { isDelta: true, altKey: "client_key", deepFields: ["queue", "running", "sources", "caps", "load", "flow", "watcher"] },
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
  // A workspace's flow map (convex flowMap.forTeam, shared/contracts/flowMap.ts):
  // every source of its problems with its pace and where its problems go, the
  // live flow's lanes with the runs at each step, and the pipeline header's
  // counts. One row per workspace, keyed by the workspace.
  flowMaps: {
    persistence: { kind: "collection", key: "flowMaps" },
    hydration: { phase: "deferred" },
    workspaceScoped: true,
    indexes: "_id",
    sync: { isDelta: true, deepFields: ["liveFlow", "lanes", "off", "sources", "header"] },
    feeds: ["flowMap.forTeam"],
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
