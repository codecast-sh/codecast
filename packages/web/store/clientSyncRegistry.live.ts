// Live artifacts (boards, sheets, dashboards): the synced collections,
// registered in CLIENT_SYNC_REGISTRY by spread. Writes are in
// store/liveArtifactsSlice.ts; the feeder and every reader are in
// components/live/useLiveArtifact.ts.
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const LIVE_SYNC_COLLECTIONS = {
  // One row per (doc, layer, element key), keyed "<doc>|<layer>|<key>", with
  // the element's fields flat on the row. localFirst: an edit paints from the
  // action draft and its field locks hold until the server echo carries the
  // same values. The feed is a revision tail (rows with rev > what the store
  // holds), so every answer is a delta.
  liveElements: {
    persistence: { kind: "collection", key: "liveElements" },
    hydration: { phase: "deferred" },
    localFirst: true,
    indexes: "_id, doc_id",
    sync: { isDelta: true },
    // The server stamps these on every write; a local edit never knows them.
    unprotectedFields: ["rev", "by", "at"],
    feeds: ["liveArtifacts.elementsSince"],
    writtenBy: ["liveArtifacts"],
  },
  // Per doc: the head revision and the pending draft. Fanned out of the
  // elementsSince answer.
  liveHeads: {
    persistence: { kind: "collection", key: "liveHeads" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true, deepFields: ["draft", "restoring"] },
  },
  // Who is in an artifact now, keyed "<doc>|<actor>". Not persisted: a cached
  // cursor is a lie the moment the page reloads. No `feeds` entry: its one
  // feeder is hooks/useSyncLiveArtifact.ts, and a feed would mark the
  // livePresence module a synced writer whose cursor stream (a dozen sends a
  // second) must ride store actions. Cursors are not edits: nothing to paint
  // optimistically, undo or replay.
  livePresence: {
    sync: { isDelta: true, deepFields: ["position", "selection"] },
  },
  // An artifact's checkpoints, keyed by the version _id.
  liveVersions: {
    persistence: { kind: "collection", key: "liveVersions" },
    hydration: { phase: "deferred" },
    indexes: "_id, doc_id",
    sync: { isDelta: true },
    feeds: ["liveArtifacts.versions"],
  },
} satisfies Record<string, ClientSyncRegistryEntry>;
