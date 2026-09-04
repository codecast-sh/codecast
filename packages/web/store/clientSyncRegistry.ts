export type PersistenceKind = "collection" | "meta";
export type DispatchTableKind = "collection" | "singleton";
export type HydrationPhase = "critical" | "deferred";
export type HydrationMerge = "shape" | "fill";

// The data-only subset of inboxStore's SyncOpts. Registered here so ONE entry
// is the whole registration of a synced collection: how it syncs, how it
// persists, how it hydrates, how it's indexed on disk. Store-internal opts
// (transforms, merge functions, normalize) stay in inboxStore's SYNC_REGISTRY,
// which spreads these defaults first and overrides per key.
export type RegistrySyncOpts = {
  kind?: "collection" | "singleton" | "list" | "scalar";
  // Delta overlay: absence in a payload means "unchanged", never "deleted".
  // Right for every windowed/paged list channel; wrong for a query that
  // returns the COMPLETE visible set (there, absence means removed).
  isDelta?: boolean;
  // Optimistic stubs carry this field with their own stub id; the server row
  // that arrives with the same value supersedes the stub.
  altKey?: string;
  keepSelected?: string;
  ignoreFields?: string[];
  // Server-joined object fields (recomputed without a scalar change on the
  // row) the identity reuse compares by content — see the engine's SyncOpts.
  deepFields?: string[];
  preserveFields?: string[];
};

export type ClientSyncRegistryEntry = {
  persistence?: {
    kind: PersistenceKind;
    key: string;
    perWindow?: boolean;
  };
  // How the collection syncs (see RegistrySyncOpts). Omit for meta keys.
  sync?: RegistrySyncOpts;
  // Dexie index spec for a persisted collection. Default "_id". Secondary
  // indexes ("_id, channel_id") let a slice be read off disk without a scan.
  // The on-disk schema is DERIVED from these — adding a collection or an index
  // here is the whole schema change (then bump CACHE_SCHEMA_VERSION).
  indexes?: string;
  // Rows carry a `workspace` access key and enumerate only through the
  // useWorkspaceCollection chokepoint (a strict-boundary table).
  workspaceScoped?: boolean;
  // The Convex queries that FEED this key ("agentTasks.webList"). Registering
  // one is a promise that components render from the store, not from the
  // query: a source-level test fails any component/app file that subscribes
  // to a registered feed directly. Only the sync hook may.
  feeds?: readonly string[];
  // Boot hydration is automatic for every persisted key — registering a
  // persistence entry IS the permission to load AND save. This field only
  // tunes it, never gates it:
  //   phase "critical" (default) — applied in the first hydrate pass, before
  //     first paint; "deferred" — applied a tick later (heavy list-view data).
  //   merge "shape" (default) — objects union (cache as floor, live wins
  //     per key), arrays fill only an empty slot, scalars replace; "fill" —
  //     only lands while the store slot is still null (live-synced singletons
  //     a stale cache must never clobber).
  //   "manual" — the hydration block consumes the cached value with bespoke
  //     logic (excluded from the derived apply lists).
  hydration?: { phase?: HydrationPhase; merge?: HydrationMerge } | "manual";
  localFirst?: boolean;
  dispatchTable?: {
    table: string;
    kind: DispatchTableKind;
    // When set, ONLY these fields dispatch — for a store key that is a
    // client-side projection of another table (sessions → conversations),
    // where most fields are server-derived enrichment that must never be
    // patched back, but a few user-gesture fields are real server state.
    fields?: readonly string[];
  };
  dispatchFieldTable?: string;
  // Per-row validity for a persisted collection. Rows failing this are dropped
  // (and removed from disk) at cache hydration and refused by detail-record
  // writes. Guards against foreign documents persisted under the wrong
  // collection — e.g. a conversation once stored as a task by a table-blind
  // webGetTaskDetail lingers in the never-pruned cache forever as a phantom
  // task that 404s when opened.
  validRow?: (row: any) => boolean;
  // Fields on a localFirst collection that auto pending protection must skip
  // (see RegistryEntry.unprotectedFields in @platform/engine). For an
  // append-stream field the optimistic local value contains stub content the
  // server echo can never match, so a field lock would freeze it forever;
  // the optimistic write renders until the server's authoritative set
  // reconciles it. Stale locks on these fields are dropped at hydration.
  unprotectedFields?: readonly string[];
  // Trim a persisted row as it is hydrated into memory. The list channels for a
  // collection may have shipped fields an older client version cached forever
  // (docs once carried full `content` — 115MB in memory / 125MB on disk for
  // 14k docs), and this is the one place every cached row passes through. The
  // trimmed row replaces the cached one on the next natural persist.
  hydrateRow?: (row: any, ctx: { pending: Record<string, any> }) => any;
};

export const CLIENT_SYNC_REGISTRY = {
  repoBrowse: {
    persistence: { kind: "collection", key: "repoBrowse", perWindow: true },
    indexes: "_id, scope, repository",
    sync: { isDelta: true, deepFields: ["value"] },
    feeds: ["repos.listRepositories", "repos.getBranches", "repos.getBranchDetails", "repos.getMeta", "repos.getTags", "repos.getReadme", "repos.getTree", "repos.getBlob", "repos.getBlame", "repos.getLastCommits", "repos.getCompare", "repos.getSearch", "repos.getLog", "repos.getPulls"],
  },
  repoBrowseAccess: {
    persistence: { kind: "collection", key: "repoBrowseAccess", perWindow: true },
    indexes: "_id, scope, repository",
    sync: { isDelta: true },
    feeds: ["repos.canBrowse"],
  },
  settingsData: {
    persistence: { kind: "collection", key: "settingsData" },
    sync: { isDelta: true, deepFields: ["value"] },
    feeds: ["users.getRecentProjectsWithGitInfo", "githubApp.listInstallations", "devices.listAgentBoxes"],
  },
  sessions: {
    persistence: { kind: "collection", key: "sessions" },
    localFirst: true,
    // Inbox triage gestures (dismiss/stash/pin) write the session row itself,
    // but the server-side row is the conversation. Without this mapping the
    // gesture only reached the server through the parallel write to
    // `conversations[id]` — a meta row that exists ONLY once the session has
    // been OPENED on this client. Triaging an unopened session was therefore a
    // silent local-only write; after the 5-min pending settle the dismiss
    // reconcile's CLEAR pass read the server's silence as "restored elsewhere"
    // and un-hid it ("I keep dismissing these and they keep coming back").
    // The whitelist keeps every other sessions field (server-derived
    // enrichment: agent_status, is_idle, author_name, …) undispatchable. It
    // carries exactly the real conversations fields that list-row gestures
    // write on the session row (dismiss/stash/pin/defer/rename/favorite);
    // enriched twins (is_pinned, is_deferred, display_title) stay local.
    dispatchTable: {
      table: "conversations",
      kind: "collection",
      fields: [
        "inbox_dismissed_at",
        "inbox_stashed_at",
        "inbox_stash_hidden",
        "inbox_pinned_at",
        "inbox_deferred_at",
        "inbox_dormant_at",
        "title",
        "is_favorite",
      ],
    },
  },
  conversations: {
    persistence: { kind: "meta", key: "conversations" },
    localFirst: true,
    dispatchTable: { table: "conversations", kind: "collection" },
  },
  tasks: {
    persistence: { kind: "collection", key: "tasks" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    // The comment stream is append-only and reconciled wholesale by the
    // detail query: addTaskComment renders its optimistic row instantly, and
    // the server's full set (which includes the real comment) replaces it. A
    // field lock here could never retire — the temp-id stub never matches the
    // server echo — and would freeze the stream at its optimistic snapshot.
    unprotectedFields: ["comments"],
    // Real tasks always carry a ct- short_id (required by schema, asserted by
    // webGetTaskDetail's lookup guard). Conversations masquerading as tasks
    // carry a session short id (jx…) or none. A non-array `comments` is a row
    // poisoned by a pre-fix pending lock (a lone comment object re-asserted as
    // the whole field — crashed the Threads page); dropping it at hydration
    // lets the live sync re-fill the row clean.
    validRow: (row: any) =>
      typeof row?.short_id === "string" && row.short_id.startsWith("ct-") &&
      (row.comments === undefined || Array.isArray(row.comments)),
  },
  capabilityBindings: {
    persistence: { kind: "collection", key: "capabilityBindings" },
    hydration: { phase: "deferred" },
    localFirst: true,
    validRow: (row: any) =>
      typeof row?.capability_slug === "string" && typeof row?.scope_kind === "string",
    // An optimistic stub keyed by client_key is superseded by the server row
    // carrying the same client_key — the tasks convention.
    sync: { altKey: "client_key" },
  },
  capabilityState: {
    persistence: { kind: "collection", key: "capabilityState" },
    hydration: { phase: "deferred" },
    // NOT localFirst, and that is the design: the mirror is server truth about
    // machines' disks — there is no optimistic write to protect, and pending
    // machinery would only delay the honest answer. See store/capabilities.ts's
    // header for the full argument.
    localFirst: false,
    validRow: (row: any) =>
      typeof row?.device_id === "string" && typeof row?.client === "string",
    // A COLLECTION keyed by server _id: rows are (device, client, scope)
    // tuples; a singleton would make every device's report clobber the fleet.
    sync: {},
  },
  docs: {
    persistence: { kind: "collection", key: "docs" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    sync: { isDelta: true },
    // `docs` is the THIN list: bodies live in docDetails (the doc page) and in
    // live webGet queries (embeds, pills). Drop a body a past channel cached —
    // unless it is an unsynced local edit still under a pending field lock.
    hydrateRow: (row: any, { pending }: { pending: Record<string, any> }) => {
      if (row?.content === undefined && row?.entries === undefined && row?.embedding === undefined) return row;
      if (pending[`docs:${row._id}:content`]) return row;
      const { content: _c, entries: _e, embedding: _m, ...rest } = row;
      return rest;
    },
  },
  // Doc bodies + detail joins, keyed by doc id — the local-first half of the
  // thin-list split above: `docs` rows shed their bodies, so this cache is
  // what lets a doc PAGE paint synchronously after a reload instead of
  // spinning on webGetDocDetail. Fed by the detail query on open and by the
  // recent-page body prefetch (useSyncDocs); bounded at hydration by
  // partitionDocDetailRetention (last-open LRU), so it holds what the user
  // reads, never the corpus. NOT localFirst: writes to real doc fields ride
  // the `docs` collection (updateDoc), which owns the pending locks — this is
  // a paint cache the live detail query reconciles.
  docDetails: {
    persistence: { kind: "collection", key: "docDetails" },
    hydration: { phase: "deferred" },
    localFirst: false,
    feeds: ["taskMining.webGetDocDetail"],
    // The detail query spreads the whole doc row, which includes the vector
    // embedding — dead weight for rendering; shed it on the way in like the
    // docs list does.
    hydrateRow: (row: any) => {
      if (row?.embedding === undefined) return row;
      const { embedding: _m, ...rest } = row;
      return rest;
    },
  },
  // The decision queue (cast decide). Answering is local-first: the action
  // flips status on the draft and the resolution fields ride the generic
  // patch rail to the session_decisions table. Everything structural
  // (question, options, context) is server-owned and stays undispatchable.
  sessionDecisions: {
    persistence: { kind: "collection", key: "sessionDecisions" },
    hydration: { phase: "deferred" },
    localFirst: true,
    dispatchTable: {
      table: "session_decisions",
      kind: "collection",
      fields: ["status", "answer_index", "answer_text", "resolved_at"],
    },
  },
  // Saved views: the sidebar rail and its pinned rows. A pin lives in client
  // UI state and renders offline, but its click resolves the view row from
  // this collection — unpersisted, that lookup found nothing after an offline
  // boot and the click silently did nothing. Snapshot, not delta: webList is
  // the complete visible set (SYNC_REGISTRY keeps it out of delta mode).
  savedViews: {
    persistence: { kind: "collection", key: "savedViews" },
    feeds: ["savedViews.webList"],
  },
  plans: {
    persistence: { kind: "collection", key: "plans" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    sync: { isDelta: true },
    feeds: ["plans.webList"],
  },
  projects: {
    persistence: { kind: "collection", key: "projects" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    // Liberal delta cache like the others; a snapshot here was the one
    // remaining collection that pruned by absence. The member counts are joined
    // from tasks/plans/docs and move without any scalar on the row changing,
    // so they must be content-compared or a refetch lands as a no-op.
    sync: { isDelta: true, deepFields: ["task_counts"] },
  },
  buckets: {
    persistence: { kind: "collection", key: "buckets" },
    localFirst: true,
    // Field edits (rename / archive / color / sort) dispatch as generic patches.
    dispatchTable: { table: "inbox_buckets", kind: "collection" },
  },
  // Server writes flow through the assignSessionToBucket side effect (upsert by
  // user+conversation), not patches — so no dispatchTable here. localFirst keeps
  // optimistic assignments protected until the server row syncs back.
  bucketAssignments: {
    persistence: { kind: "collection", key: "bucketAssignments" },
    localFirst: true,
  },
  // Teammate comments. Every write flows through a named, receipt-backed
  // dispatch side effect. In particular edits must not also ride generic
  // patches: that path can silently no-op after deletion/access revocation.
  comments: {
    persistence: { kind: "collection", key: "comments" },
    hydration: { phase: "deferred" },
    localFirst: true,
  },
  // Team chat. Persisted so a channel opens with its last page already on screen
  // and an unsent message survives a reload, and deferred because a chat page is
  // never the first paint.
  //
  // Deliberately NOT localFirst. Auto-pending protects a field until the server
  // echoes the identical value, and chat's interesting fields are server clock
  // stamps (created_at / edited_at / deleted_at) the client cannot predict — a
  // pending entry over one of those can never retire, so it would mask the real
  // row forever. Chat reconciles by delta overlay + a client_id supersede
  // instead, and plants its two real deletion tombstones by hand
  // (store/chatSlice.ts explains both).
  chatChannels: {
    persistence: { kind: "collection", key: "chatChannels" },
    hydration: { phase: "deferred" },
  },
  chatMessages: {
    persistence: { kind: "collection", key: "chatMessages" },
    hydration: { phase: "deferred" },
    // A channel (or a thread) reads off disk without scanning every message
    // the client ever cached.
    indexes: "_id, channel_id, thread_root_id",
    // A row must know which channel it belongs to; anything else is a foreign
    // document that would render as a message with no home.
    validRow: (row: any) => typeof row?.channel_id === "string" && typeof row?.content === "string",
  },
  chatReactions: {
    persistence: { kind: "collection", key: "chatReactions" },
    hydration: { phase: "deferred" },
    indexes: "_id, message_id",
  },
  chatReads: {
    persistence: { kind: "collection", key: "chatReads" },
    hydration: { phase: "deferred" },
    indexes: "_id, channel_id",
  },
  // The server's own per-channel unread numbers (chat.listChannels' rail). A
  // small array, so a meta blob: it is the only honest count for a channel whose
  // messages this client has never loaded, and having it at boot means the rail
  // paints its badges before any query answers.
  chatRail: {
    persistence: { kind: "meta", key: "chatRail" },
    hydration: { phase: "deferred" },
  },
  // The Threads inbox (threads.listMine): one derived row per thread the
  // viewer is in, every kind (chat, comment, task), keyed `${kind}:${root_key}`.
  // Persisted so the page opens on its cached threads; a delta overlay so a
  // page of entries never prunes the rest.
  threadInbox: {
    persistence: { kind: "collection", key: "threadInbox" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    indexes: "_id, kind, team_id, channel_id, conversation_id, task_id",
    feeds: ["threads.listMine"],
  },
  // The Threads badge (threads.unreadCount): a scalar, live-synced app-wide
  // next to the chat rail; a stale cached count must not clobber a fresh one.
  threadUnread: {
    persistence: { kind: "meta", key: "threadUnread" },
    hydration: { phase: "deferred", merge: "fill" },
    sync: { kind: "scalar" },
    feeds: ["threads.unreadCount"],
  },
  // A published page's Threads slice (threads.listMine payload.pages): title,
  // slug and the newest comments of each page discussion, keyed by artifact
  // id (the page kind's root_key). A delta overlay so one page of entries
  // never prunes the rest. Not localFirst: the optimistic reply is a stub row
  // appended in the action and superseded by client_id when the server's
  // entity syncs back (see addPageComment).
  pageThreads: {
    persistence: { kind: "collection", key: "pageThreads" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["threads.listMine"],
  },

  // ── Tier-2 collections: surfaces that used to render from a live query ──
  // Each is ONE entry. The Dexie table, the sync defaults, the {} at boot, the
  // typed store slot and the feed-leakage guard all derive from it.

  // Triggers (agent_tasks). webList returns the COMPLETE set for the user, so
  // this is a snapshot sync (absence = deleted), not a delta. localFirst: the
  // pause/resume/run-now/cancel gestures flip status on the draft and ride
  // named dispatch side effects to the real mutations.
  agentTasks: {
    persistence: { kind: "collection", key: "agentTasks" },
    hydration: { phase: "deferred" },
    localFirst: true,
    sync: {},
    feeds: ["agentTasks.webList"],
  },
  // Issue sync sources (issue_sync_sources, docs/architecture/issue-sync.md
  // S1.3): the Linear teams/projects and GitHub repos a workspace imports,
  // one row per codecast project. listSources returns the COMPLETE visible
  // set, so snapshot — absence means the source was removed.
  //
  // localFirst: pause/resume, the delegation settings and remove all flip the
  // draft and ride named dispatch side effects (addIssueSyncSource /
  // updateIssueSyncSource / removeIssueSyncSource) to the real mutations.
  // `addSource` takes no client key, so an add's optimistic stub has no altKey
  // to supersede onto; the next snapshot carries the real row and drops the
  // stub, which is the same convergence by a slower door.
  issueSyncSources: {
    persistence: { kind: "collection", key: "issueSyncSources" },
    hydration: { phase: "deferred" },
    localFirst: true,
    workspaceScoped: true,
    indexes: "_id, project_id",
    sync: {},
    feeds: ["issueSync.listSources"],
  },
  // A trigger's run history: one window per task (webListRuns is capped at
  // 100 rows), so a delta overlay keeps every opened trigger's runs. Rows are
  // keyed by run_key (the server's `_id` is the conversation and repeats for
  // inject-mode runs) — the feeder stamps _id = run_key and task_id.
  agentTaskRuns: {
    persistence: { kind: "collection", key: "agentTaskRuns" },
    hydration: { phase: "deferred" },
    indexes: "_id, task_id",
    sync: { isDelta: true },
    feeds: ["agentTasks.webListRuns"],
  },
  // Workflow definitions. webList is a 50-newest window, so delta.
  workflows: {
    persistence: { kind: "collection", key: "workflows" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["workflows.webList", "workflows.webGet"],
  },
  // Workflow runs, fed by three windows (listDynamicRuns, listForWorkflow,
  // get) that overlay into one collection. The per-node `session` enrichment
  // rides only the enriched channels and may be absent on a row from
  // listForWorkflow; readers treat it as optional.
  workflowRuns: {
    persistence: { kind: "collection", key: "workflowRuns" },
    hydration: { phase: "deferred" },
    indexes: "_id, workflow_id",
    sync: { isDelta: true },
    feeds: ["workflow_runs.listDynamicRuns", "workflow_runs.listForWorkflow", "workflow_runs.get"],
  },
  // Published pages (artifacts). listForWeb returns the complete visible set
  // — own plus shareable teammates' — so snapshot. Rows have no server _id;
  // the feeder keys them by slug.
  artifacts: {
    persistence: { kind: "collection", key: "artifacts" },
    hydration: { phase: "deferred" },
    sync: {},
    feeds: ["artifacts.listForWeb"],
  },
  // The anchor space, one row per scope key ("user" | "team:<id>"), keyed by
  // it. Delta so the scopes coexist; each push replaces its own row.
  anchorSpaces: {
    persistence: { kind: "collection", key: "anchorSpaces" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["anchors.getAnchorSpace"],
  },
  // Every anchor the viewer can see (their personal one + one per team), with
  // bot identity, scope name and coarse session state. listAnchors returns the
  // complete visible set, so snapshot. Feeds the global anchor chip/drawer, the
  // inbox's anchor marking and the /anchor page's scope switcher.
  anchors: {
    persistence: { kind: "collection", key: "anchors" },
    hydration: { phase: "deferred" },
    sync: {},
    feeds: ["anchors.listAnchors"],
  },
  // Cross-session message graph (crosstalk): one server-derived snapshot.
  // Singleton; the store's SYNC_REGISTRY strips the per-push generatedAt so an
  // unchanged graph doesn't wake subscribers.
  sessionThreads: {
    persistence: { kind: "meta", key: "sessionThreads" },
    hydration: { phase: "deferred", merge: "fill" },
    sync: { kind: "singleton" },
    feeds: ["sessionThreads.listSessionThreads"],
  },
  // Timeline lanes. Both queries are windows (commits: 2×limit newest,
  // PRs: 50 by updated_at), so delta overlays accumulate history.
  commits: {
    persistence: { kind: "collection", key: "commits" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["commits.getCommitsForTimeline", "commits.getCommitBySha"],
  },
  // The PR page feeds one row into the same collection, so opening a PR paints
  // from whatever the timeline already cached and the single row refreshes it.
  pullRequests: {
    persistence: { kind: "collection", key: "pullRequests" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    feeds: ["pull_requests.getPRsForTimeline", "pull_requests.getPRByNumber"],
  },
  // Code comments (review_comments): a comment on a file and line in a repo,
  // with or without a PR. Each feed is a window onto the table (one PR's set,
  // one commit's, one file's), so the overlay is a delta: absence in a payload
  // means "outside this window", never "deleted".
  codeComments: {
    persistence: { kind: "collection", key: "codeComments" },
    hydration: { phase: "deferred" },
    // A comment posted here renders from its optimistic stub, keyed by the
    // client_id it was created with; the server row carrying the same
    // client_id supersedes the stub when listForPR echoes it back.
    sync: { isDelta: true, altKey: "client_id" },
    indexes: "_id, pull_request_id, repository, file_path, created_at",
    feeds: ["codeComments.listForPR", "codeComments.listForRef", "codeComments.listForFile"],
  },
  // Git activity as first class events (git_events): one row per commit,
  // push, PR change, review, check result or code comment. Every feed is a
  // window (a team page, one conversation, one PR), so the overlay is a
  // delta: absence in a payload means "outside this window", never "deleted".
  // Not workspace scoped — access is decided server side by team membership
  // or by the linked conversation, and a row carries no `workspace` key.
  externalEvents: {
    persistence: { kind: "collection", key: "externalEvents" },
    hydration: { phase: "deferred" },
    sync: { isDelta: true },
    indexes: "_id, team_id, conversation_id, pr_id, task_id, repository, created_at",
    feeds: [
      "externalEvents.listForTeam",
      "externalEvents.listForConversation",
      "externalEvents.listForPR",
      "externalEvents.listForTask",
      "externalEvents.listForPlan",
      "externalEvents.listForProject",
      "externalEvents.listForRepository",
    ],
  },
  // The daemon-side fleet (managed_sessions). listActiveSessions is the
  // COMPLETE live set (24h heartbeat window) — snapshot, so a session that
  // stops heartbeating leaves. Readers additionally hide rows whose
  // last_heartbeat is stale, so a persisted row can't outlive its window.
  sessionCommands: {
    persistence: { kind: "collection", key: "sessionCommands", perWindow: true },
    sync: { isDelta: true },
    feeds: ["sessionCommands.results"],
  },
  managedSessions: {
    persistence: { kind: "collection", key: "managedSessions" },
    hydration: { phase: "deferred" },
    sync: {},
    feeds: ["managedSessions.listActiveSessions"],
  },
  // Aggregate CPU/memory over the last 2h — a recomputed list, not rows.
  sessionMetricsAggregate: {
    persistence: { kind: "meta", key: "sessionMetricsAggregate" },
    hydration: { phase: "deferred", merge: "fill" },
    sync: { kind: "list" },
    feeds: ["managedSessions.getAggregateMetrics"],
  },
  // Pending tool-permission requests, per conversation. Each conversation's
  // push is the complete pending set for THAT conversation, so the feeder
  // syncs with pruneAbsentScope for it (a resolved permission leaves the
  // pending query and must leave the store). Persisted so the decision queue
  // paints permission cards at boot; readers hide rows past the 2h window.
  pendingPermissions: {
    persistence: { kind: "collection", key: "pendingPermissions" },
    hydration: { phase: "deferred" },
    indexes: "_id, conversation_id",
    sync: { isDelta: true },
    feeds: ["permissions.getPendingPermissions"],
  },
  // Delivery status of the viewer's in-flight message per conversation
  // (getConversationPendingMessage). One row keyed by conversation id;
  // transient — never persisted (a reload re-derives it).
  pendingMessageStatus: {
    sync: { isDelta: true },
    feeds: ["pendingMessages.getConversationPendingMessage"],
  },
  // The message feed (getMessageFeed): the viewer's and teammates' user
  // messages, keyed by message id. The newest page rides a live subscription
  // and older pages arrive as one-shot fetches; every page overlays (delta),
  // like feedConversations. Paging cursors live in feedCursors/feedHasMore
  // under "msg:<filter>". A "my" view is the rows with is_own.
  messageFeed: {
    persistence: { kind: "collection", key: "messageFeed" },
    hydration: { phase: "deferred" },
    indexes: "_id, timestamp",
    sync: { isDelta: true },
    feeds: ["conversations.getMessageFeed"],
  },
  // The viewer's device roster (listDevices), keyed by device_id. Persisted so
  // /capabilities, device chips and the terminal picker paint at boot. The
  // path-seeding gate (pathOnMyMachines) reads it only once a LIVE push has
  // landed (machineRosterLive) — a stale roster must not veto a freshly cloned
  // path — so persistence helps display and never the gate.
  machineRoster: {
    persistence: { kind: "meta", key: "machineRoster" },
    feeds: ["devices.listDevices"],
  },
  notifications: {
    localFirst: true,
  },
  clientState: {
    persistence: { kind: "meta", key: "clientState" },
    dispatchTable: { table: "client_state", kind: "singleton" },
  },
  // This client's own last-focused conversation — the boot-restore source.
  // Local-only on purpose (no dispatchTable): the per-user synced pointer
  // (clientState.current_conversation_id) is writable by every client and kept
  // poisoning the desktop's restore; this key never leaves the device.
  // Hydrated manually: the restore block also reseeds currentSessionId from it.
  lastFocusedConversationId: {
    persistence: { kind: "meta", key: "lastFocusedConversationId" },
    hydration: "manual",
  },
  // Persisted twin of the in-memory liveInboxIds Set — the server-authoritative
  // active-inbox id set. A plain string array (the native store JSON-serializes
  // meta blobs; Sets don't survive, and the generic object-union hydration merge
  // would wreck one anyway). Hydrated manually: the boot block seeds
  // liveInboxIds from it so the FIRST painted frame filters the never-prune
  // cache down to the last-known authoritative set instead of flashing cruft.
  liveInboxIdList: {
    persistence: { kind: "meta", key: "liveInboxIdList" },
    hydration: "manual",
  },
  // Team-mode twin of liveInboxIdList, keyed by team id (see inboxStore's
  // teamInboxIdSnapshot doc). Manual for the same reason: the boot block seeds
  // the in-memory teamInboxIds Set from it, guarded by scope + active team.
  teamInboxIdSnapshot: {
    persistence: { kind: "meta", key: "teamInboxIdSnapshot" },
    hydration: "manual",
  },
  _lastViewedAt: {
    persistence: { kind: "meta", key: "_lastViewedAt" },
  },
  // Recently-visited rail (sessions, chip views, pages) — device-local on
  // purpose: what you opened on this machine is this machine's history.
  recentVisits: {
    persistence: { kind: "meta", key: "recentVisits" },
  },
  _seenUpToAt: {
    persistence: { kind: "meta", key: "_seenUpToAt" },
  },
  _seenMessageCount: {
    persistence: { kind: "meta", key: "_seenMessageCount" },
  },
  pendingMessages: {
    persistence: { kind: "meta", key: "pendingMessages" },
  },
  // Blocked-banner revive stamps (session id → requested-at). Persisted so a
  // reload mid-revive doesn't flash the fleet back to "blocked" while the
  // daemon is still restarting it; entries expire by TTL, never synced.
  blockedReviveRequestedAt: {
    persistence: { kind: "meta", key: "blockedReviveRequestedAt" },
  },
  pending: {
    persistence: { kind: "meta", key: "pending" },
  },
  drafts: {
    persistence: { kind: "meta", key: "drafts" },
  },
  queuedMessages: {
    persistence: { kind: "meta", key: "queuedMessages" },
  },
  recentProjects: {
    persistence: { kind: "meta", key: "recentProjects" },
    hydration: { phase: "deferred" },
  },
  recentProjectsByDevice: {
    persistence: { kind: "meta", key: "recentProjectsByDevice" },
    hydration: { phase: "deferred" },
  },
  // Collapse/expand state is CRITICAL, not deferred: these are tiny boolean
  // maps, and hydrating them after first paint meant every boot painted all
  // sections expanded (hundreds of stashed rows) for a frame, then snapped
  // them collapsed. The deferred phase is for heavy list-view data only.
  collapsedSections: {
    persistence: { kind: "meta", key: "collapsedSections" },
  },
  sidebarNavExpanded: {
    persistence: { kind: "meta", key: "sidebarNavExpanded" },
  },
  teams: {
    persistence: { kind: "meta", key: "teams" },
  },
  teamMembers: {
    persistence: { kind: "meta", key: "teamMembers" },
  },
  teamUnreadCount: {
    persistence: { kind: "meta", key: "teamUnreadCount" },
    // Live-synced; a stale cached count must not clobber a fresh one.
    hydration: { merge: "fill" },
  },
  feedConversations: {
    persistence: { kind: "meta", key: "feedConversations" },
  },
  feedHasMore: {
    persistence: { kind: "meta", key: "feedHasMore" },
  },
  feedCursors: {
    persistence: { kind: "meta", key: "feedCursors" },
  },
  syncMeta: {
    persistence: { kind: "meta", key: "syncMeta" },
  },
  docProjectPaths: {
    persistence: { kind: "meta", key: "docProjectPaths" },
    hydration: { phase: "deferred" },
  },
  favorites: {
    persistence: { kind: "meta", key: "favorites" },
    hydration: { phase: "deferred" },
  },
  bookmarks: {
    persistence: { kind: "meta", key: "bookmarks" },
    hydration: { phase: "deferred" },
  },
  tabs: {
    persistence: { kind: "meta", key: "tabs" },
    dispatchFieldTable: "client_state",
  },
  activeTabId: {
    persistence: { kind: "meta", key: "activeTabId" },
    dispatchFieldTable: "client_state",
  },
  sidePanelSessionId: {
    persistence: { kind: "meta", key: "sidePanelSessionId" },
  },
  // The signed-in user record. Persisted so the separate palette window — which
  // hydrates from IDB and runs no live query of its own — can read
  // currentUser.available_skills and show project/personal skills in the compose
  // popup's slash menu (otherwise it would have only built-in commands).
  currentUser: {
    persistence: { kind: "meta", key: "currentUser" },
    // Singleton record, not a collection: never union stale cached fields into
    // a freshly-synced user — only fill a still-empty slot (palette/cold start).
    hydration: { merge: "fill" },
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;

export type ClientSyncStoreKey = keyof typeof CLIENT_SYNC_REGISTRY;
export type ClientSyncCollectionStoreKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly persistence: { readonly kind: "collection" } } ? K : never
}[ClientSyncStoreKey];
export type ClientSyncMetaStoreKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly persistence: { readonly kind: "meta" } } ? K : never
}[ClientSyncStoreKey];

const registryEntries = Object.entries(CLIENT_SYNC_REGISTRY) as Array<
  [ClientSyncStoreKey, ClientSyncRegistryEntry]
>;

export const COLLECTION_STORE_KEYS = registryEntries
  .filter(([, entry]) => entry.persistence?.kind === "collection")
  .map(([key]) => key) as ClientSyncCollectionStoreKey[];

export const META_STORE_KEYS = registryEntries
  .filter(([, entry]) => entry.persistence?.kind === "meta")
  .map(([key]) => key) as ClientSyncMetaStoreKey[];

export const PROTECTED_COLLECTION_KEYS = registryEntries
  .filter(([, entry]) => entry.localFirst)
  .map(([key]) => key);

// Boot-hydration apply lists, derived so a persisted key can never silently
// skip hydration (the bug class of ct-34920 and the buckets label pop-in):
// every persisted key lands in exactly one of critical / deferred / manual.
const hydratedEntries = registryEntries.filter(
  ([, entry]) => entry.persistence && entry.hydration !== "manual"
);

export const HYDRATION_CRITICAL_KEYS = hydratedEntries
  .filter(([, entry]) => (entry.hydration as { phase?: HydrationPhase } | undefined)?.phase !== "deferred")
  .map(([key]) => key);

export const HYDRATION_DEFERRED_KEYS = hydratedEntries
  .filter(([, entry]) => (entry.hydration as { phase?: HydrationPhase } | undefined)?.phase === "deferred")
  .map(([key]) => key);

export const HYDRATION_MANUAL_KEYS = registryEntries
  .filter(([, entry]) => entry.persistence && entry.hydration === "manual")
  .map(([key]) => key);

export const HYDRATION_CRITICAL_READ_KEYS = [
  ...HYDRATION_CRITICAL_KEYS,
  ...HYDRATION_MANUAL_KEYS,
];

export function hydrationMergeStrategy(key: string): HydrationMerge {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  const hydration = entry?.hydration;
  if (hydration && hydration !== "manual" && hydration.merge) return hydration.merge;
  return "shape";
}

// ── Derived from the registry: the things a new collection used to need a
// hand-written line for in some other file. Register once; these follow.

/** Sync-time defaults per key (inboxStore spreads these under SYNC_REGISTRY). */
export const REGISTRY_SYNC_OPTS: Record<string, RegistrySyncOpts> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) => (entry.sync ? [[key, entry.sync]] : [])),
);

/** Dexie `stores()` spec for every persisted collection: `{ key: indexes }`. */
export const COLLECTION_INDEXES: Record<string, string> = Object.fromEntries(
  COLLECTION_STORE_KEYS.map((key) => [
    key,
    (CLIENT_SYNC_REGISTRY[key] as ClientSyncRegistryEntry).indexes ?? "_id",
  ]),
);

/** Tables whose rows enumerate only through useWorkspaceCollection. */
export const WORKSPACE_SCOPED_KEYS = registryEntries
  .filter(([, entry]) => entry.workspaceScoped)
  .map(([key]) => key);
export type WorkspaceScopedStoreKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly workspaceScoped: true } ? K : never
}[ClientSyncStoreKey];

/** Every registered feed query → the store key it feeds. */
export const REGISTERED_FEEDS: Record<string, string> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) => (entry.feeds ?? []).map((f) => [f, key])),
);

/** Every key that is a collection in memory: persisted as a collection table,
 *  OR synced as one (`sync` with the default "collection" kind) without
 *  persistence — a transient collection still needs its `{}` at boot. */
export type RegisteredCollectionKey = {
  [K in ClientSyncStoreKey]: (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly persistence: { readonly kind: "collection" } }
    ? K
    : (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly sync: { readonly kind: "singleton" | "list" | "scalar" } }
      ? never
      : (typeof CLIENT_SYNC_REGISTRY)[K] extends { readonly sync: object }
        ? K
        : never
}[ClientSyncStoreKey];

export const REGISTERED_COLLECTION_KEYS = registryEntries
  .filter(([, entry]) =>
    entry.persistence?.kind === "collection" ||
    (entry.sync && (entry.sync.kind ?? "collection") === "collection" && !entry.persistence))
  .map(([key]) => key) as RegisteredCollectionKey[];

/**
 * The in-memory floor for every registered collection: an empty Record. Spread
 * at the base of the store config so a registered collection can never be
 * `undefined` at boot (Object.values(undefined) was the crash class).
 */
export function collectionInitialState(): Record<RegisteredCollectionKey, Record<string, any>> {
  return Object.fromEntries(REGISTERED_COLLECTION_KEYS.map((key) => [key, {}])) as any;
}

/** Typed slots for every registered collection, mixed into InboxStoreState so
 *  a registration alone gives `s.<key>` a type. Narrow it further on the
 *  interface when a collection has a real row type. */
export type RegisteredCollectionSlots = {
  [K in RegisteredCollectionKey]: Record<string, any>;
};

export const DISPATCH_TABLE_MAP: Record<string, { table: string; kind: DispatchTableKind; fields?: readonly string[] }> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) =>
    entry.dispatchTable ? [[key, entry.dispatchTable]] : []
  )
);

export const DISPATCH_FIELD_TABLE_MAP: Record<string, { table: string }> = Object.fromEntries(
  registryEntries.flatMap(([key, entry]) =>
    entry.dispatchFieldTable ? [[key, { table: entry.dispatchFieldTable }]] : []
  )
);

export function isPersistedClientStoreKey(key: string): boolean {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return !!entry?.persistence;
}

export function isProtectedSyncCollection(key: string): boolean {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return !!entry?.localFirst;
}

export function collectionRowValidator(key: string): ((row: any) => boolean) | undefined {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return entry?.validRow;
}

export function collectionRowHydrator(key: string): ClientSyncRegistryEntry["hydrateRow"] {
  const entry = CLIENT_SYNC_REGISTRY[key as ClientSyncStoreKey] as ClientSyncRegistryEntry | undefined;
  return entry?.hydrateRow;
}

// ── Cross-window replication classification (docs/architecture/sync-host.md).
//
// "shared" keys are the slice the sync host broadcasts to follower windows and
// followers offer their optimistic writes back from. "local" keys never cross
// the wire: per-window optimism bookkeeping (`pending` above all), per-window
// paging state, and UI arrangement whose live cross-window sync would CHANGE
// semantics (tabs, activeTabId, sidePanelSessionId keep today's behavior:
// shared on disk at boot, live-synced only through the server echo).
//
// Every registry key MUST be classified — the Record type makes an
// unclassified new key a compile error, so the choice is always conscious.
export const REPLICATION_CLASSIFICATION: Record<ClientSyncStoreKey, "shared" | "local"> = {
  repoBrowse: "local",
  repoBrowseAccess: "local",
  settingsData: "shared",
  sessions: "shared",
  conversations: "shared",
  tasks: "shared",
  capabilityBindings: "shared",
  capabilityState: "shared",
  docs: "shared",
  docDetails: "shared",
  sessionDecisions: "shared",
  savedViews: "shared",
  plans: "shared",
  projects: "shared",
  buckets: "shared",
  bucketAssignments: "shared",
  comments: "shared",
  chatChannels: "shared",
  chatMessages: "shared",
  chatReactions: "shared",
  chatReads: "shared",
  chatRail: "shared",
  threadInbox: "shared",
  threadUnread: "shared",
  pageThreads: "shared",
  agentTasks: "shared",
  agentTaskRuns: "shared",
  issueSyncSources: "shared",
  workflows: "shared",
  workflowRuns: "shared",
  artifacts: "shared",
  anchorSpaces: "shared",
  anchors: "shared",
  sessionThreads: "shared",
  commits: "shared",
  pullRequests: "shared",
  codeComments: "shared",
  externalEvents: "shared",
  managedSessions: "shared",
  sessionCommands: "local",
  sessionMetricsAggregate: "shared",
  pendingPermissions: "shared",
  pendingMessageStatus: "shared",
  messageFeed: "shared",
  machineRoster: "shared",
  notifications: "shared",
  clientState: "shared",
  liveInboxIdList: "shared",
  teamInboxIdSnapshot: "shared",
  _lastViewedAt: "shared",
  _seenUpToAt: "shared",
  _seenMessageCount: "shared",
  teams: "shared",
  teamMembers: "shared",
  teamUnreadCount: "shared",
  syncMeta: "shared",
  docProjectPaths: "shared",
  favorites: "shared",
  bookmarks: "shared",
  currentUser: "shared",
  // Local: this window's own story, never another window's business.
  pending: "local",
  drafts: "local",
  queuedMessages: "local",
  pendingMessages: "local",
  blockedReviveRequestedAt: "local",
  lastFocusedConversationId: "local",
  recentVisits: "local",
  recentProjects: "local",
  recentProjectsByDevice: "local",
  collapsedSections: "local",
  sidebarNavExpanded: "local",
  feedConversations: "local",
  feedHasMore: "local",
  feedCursors: "local",
  tabs: "local",
  activeTabId: "local",
  sidePanelSessionId: "local",
};

// Ephemeral store slots — never persisted, so never registry keys — that must
// still agree across windows. The liveness payload's projection slot: its
// stamps, epoch and receipt clock gate every window's placement (the
// overlay-coverage rule, sync-convergence), and only the host subscribes to
// the overlay. A follower without the slot buckets every row by the
// client-only sweep and disagrees with its host on the rows the payload
// vouches for (found by the multi-window simulation, 2026-09-02).
export const REPLICATED_EPHEMERAL_KEYS = ["sessionsProjection"] as const;

/** The slice the sync host replicates to follower windows. */
export const REPLICATED_STORE_KEYS: readonly string[] = [
  ...(Object.keys(REPLICATION_CLASSIFICATION) as ClientSyncStoreKey[])
    .filter((key) => REPLICATION_CLASSIFICATION[key] === "shared"),
  ...REPLICATED_EPHEMERAL_KEYS,
];

const REPLICATED_COLLECTION_SET = new Set<string>(
  REGISTERED_COLLECTION_KEYS.filter((key) => REPLICATION_CLASSIFICATION[key] === "shared"),
);

/** Whether a replicated key holds an id-keyed row map (vs a whole value). */
export function isReplicatedCollectionKey(key: string): boolean {
  return REPLICATED_COLLECTION_SET.has(key);
}
