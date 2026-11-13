// The Ops page's synced collections, registered in CLIENT_SYNC_REGISTRY by
// spread (store/clientSyncRegistry.ts), kept here to hold that file under its size.
import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const OPS_SYNC_COLLECTIONS = {
  // External data on the Ops page (external-data.md X10). Every row carries
  // the workspace key its query read by. Sources, the transition timeline and
  // metric watches are each one complete answer for the active workspace, so
  // snapshots. Groups and replays take a bounded newest window AND every
  // opened row's detail, so delta: neither feeder may prune the other's rows.
  // Their list feeder vouches for its own window instead (hooks/useSyncOps
  // opsWindowPrune), so a row the server deleted inside it still leaves.
  // localFirst: a source's pause and a group's status paint from the draft
  // (store/opsSlice.ts) and hold until the echo. A source's name is unique in
  // its workspace (ingest.createSource), so an add's stub supersedes onto the
  // server row by name.
  opsSources: {
    persistence: { kind: "collection", key: "opsSources" },
    hydration: { phase: "deferred" },
    localFirst: true,
    sync: { altKey: "name" },
    // The replay import's progress is the server's, written by every page;
    // a start paints it optimistically until the first echo replaces it. A
    // grant paints the same way: the server stamps who and when.
    unprotectedFields: ["replay_backfill", "grants"],
    feeds: ["ingest.listSources"],
  },
  opsGroups: {
    persistence: { kind: "collection", key: "opsGroups" },
    hydration: { phase: "deferred" },
    localFirst: true,
    indexes: "_id, source_id",
    sync: { isDelta: true },
    feeds: ["ingest.listGroups", "ingest.getGroup", "ingest.searchGroups"],
  },
  // A group's recent occurrences (stack, url, tags), fanned out of
  // ingest.getGroup for each group a person opens. Read by group_id; each
  // answer vouches for its group's samples (hooks/useSyncOps).
  opsSamples: {
    persistence: { kind: "collection", key: "opsSamples" },
    hydration: { phase: "deferred" },
    indexes: "_id, group_id",
    sync: { isDelta: true },
    // The Timeline's occurrence rows page through the same samples (hooks/useSyncOps useSyncOpsStreamSamples).
    feeds: ["ingest.listSamples"],
  },
  opsEvents: {
    persistence: { kind: "collection", key: "opsEvents" },
    hydration: { phase: "deferred" },
    // Windows of the stream (the newest page, one source's newest, older pages a reader scrolled to) land in one
    // collection, each pruning only the span it vouches for (useSyncOps eventsWindow).
    sync: { isDelta: true },
    feeds: ["ingest.listEvents", "ingest.groupTransitions"],
  },
  opsReplays: {
    persistence: { kind: "collection", key: "opsReplays" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["replays.list", "replays.get", "replays.browse"],
  },
  // What a replay browse (replays.browse) counted beside the page it sent:
  // the total that matches, whether the scan stopped short, and the people
  // the matches fold into. Keyed by the workspace and the filter
  // (hooks/useSyncOps replayBrowseKey); the rows themselves are opsReplays.
  opsReplayTallies: {
    persistence: { kind: "collection", key: "opsReplayTallies" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true, deepFields: ["people"] },
  },
  // One opened replay's text timeline and linked groups, keyed by the replay
  // _id: the part of replays.get the list never carries.
  opsReplayTimelines: {
    persistence: { kind: "collection", key: "opsReplayTimelines" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
  },
  // localFirst: a watch's line, side and pause are edited on its page
  // (opsSlice updateOpsWatch) and hold until the server echoes them. Points,
  // state and the history read are the poll's.
  opsWatches: {
    persistence: { kind: "collection", key: "opsWatches" },
    hydration: { phase: "deferred" },
    localFirst: true,
    unprotectedFields: ["history", "state"],
    sync: {},
    feeds: ["metrics.listWatches"],
  },
  // A watch's values over one window, folded server side to a chart's worth
  // (metrics.series for the watch page, metrics.seriesMany for the overview's
  // cards). Keyed by the watch, the window and the bucket count
  // (components/ops/metricSeries.ts seriesKey); each answer replaces its row.
  opsWatchSeries: {
    persistence: { kind: "collection", key: "opsWatchSeries" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true, deepFields: ["points"] },
    feeds: ["metrics.series", "metrics.seriesMany"],
  },
  // An app source's cached manifest, keyed by the source _id, and its call
  // audit. Both are per source, so delta. The row also carries the grants,
  // watch state and status the source's own row holds; the page reads those
  // from opsSources, and they compare by content here so the copy is at least
  // never older than its last push.
  opsApps: {
    persistence: { kind: "collection", key: "opsApps" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true, deepFields: ["grants", "watch_state", "source"] },
    feeds: ["sources.app.capabilities"],
  },
  // One GitHub Actions run of a CI check issue as GitHub tells it (convex
  // ciRuns.ts): its jobs, failed steps, annotations and log tail, keyed by
  // the row _id and read by repository and run_id. Fed per run the issue page
  // shows; a run once read does not change.
  opsCiRuns: {
    persistence: { kind: "collection", key: "opsCiRuns" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true, deepFields: ["jobs", "annotations"] },
    feeds: ["ciRuns.get"],
  },
  opsAppCalls: {
    persistence: { kind: "collection", key: "opsAppCalls" },
    hydration: { phase: "deferred" },
    indexes: "_id, source_id",
    sync: { isDelta: true },
    feeds: ["sources.app.listCalls"],
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;
