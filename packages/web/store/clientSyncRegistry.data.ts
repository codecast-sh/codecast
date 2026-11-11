// Data dashboards (ct-91886): the synced collections, registered in
// CLIENT_SYNC_REGISTRY by spread. The feeders and readers are in
// components/data/useDashboardData.ts.
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const DATA_SYNC_COLLECTIONS = {
  // Each dashboard's cached query answers, keyed by the data_queries _id,
  // one complete set per doc. Persisted so a reopened dashboard paints its
  // last numbers at once while the live answer arrives.
  dataResults: {
    persistence: { kind: "collection", key: "dataResults" },
    hydration: { phase: "deferred" },
    indexes: "_id, doc_id",
    sync: { isDelta: true },
    feeds: ["dataQueries.results"],
  },
  // What a dashboard's blocks can bind to (readers, metric watches,
  // connectors, sheets), keyed "<doc>:<source>[:<ref>]". Read only while
  // the Data sources panel is open, so it is not persisted.
  dataSources: {
    sync: { isDelta: true },
    feeds: ["dataQueries.sources"],
  },
} satisfies Record<string, ClientSyncRegistryEntry>;
