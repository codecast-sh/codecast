import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { buildStatus, elementRef, failureKind, messageKind, narrationLine, systemNote, touchedFile, versionKind, versionRef } from "./validators";

export default defineSchema({
  /** Anonymous people. The secret lives in their browser; only its hash here.
   *  Character fields follow @codecast/shared sessionCharacter: unset means the
   *  hash default for the id. */
  visitors: defineTable({
    secret_hash: v.string(),
    character_avatar: v.optional(v.string()),
    character_name: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_secret_hash", ["secret_hash"]),

  apps: defineTable({
    slug: v.string(),
    name: v.string(),
    /** The version everyone sees. Only ever moves forward, to a new version. */
    live_version: v.number(),
    version_count: v.number(),
    /** Distinct visitors who authored a version. */
    contributor_count: v.number(),
    created_by: v.id("visitors"),
    forked_from: v.optional(versionRef),
    created_at: v.number(),
    last_activity_at: v.number(),
    /** Changes Clay suggests next, written with each version it builds; the
     *  empty room offers them. A fork starts with its source's. */
    ideas: v.optional(v.array(v.string())),
    /** Kept out of the home gallery and feed (a test harness's app, or one
     *  taken down); its link still works. A fork inherits it. */
    unlisted: v.optional(v.literal(true)),
  })
    .index("by_slug", ["slug"])
    .index("by_listed_activity", ["unlisted", "last_activity_at"])
    .index("by_forked_from", ["forked_from.app_id", "forked_from.version"]),

  /** Immutable. File contents live in version_files -> blobs, so reading a
   *  timeline never reads file bytes. */
  versions: defineTable({
    app_id: v.id("apps"),
    number: v.number(),
    parent_number: v.optional(v.number()),
    kind: versionKind,
    summary: v.string(),
    author_id: v.id("visitors"),
    request_message_id: v.optional(v.id("messages")),
    /** restore: the version whose files this copies; fork: the source. */
    source: v.optional(versionRef),
    /** restore: the live version it undid, when it brought back exactly what
     *  that version was built on. */
    undid: v.optional(v.number()),
    /** build: where to look when it lands, the element its change is about (a
     *  CSS selector), and for a change people find by doing, what to try. */
    spotlight: v.optional(v.string()),
    try_it: v.optional(v.string()),
    /** The gallery's picture of it, taken by the first screen that showed
     *  it (stills.ts). Set once; the only field added after the insert. */
    still: v.optional(v.id("_storage")),
    file_count: v.number(),
    bytes: v.number(),
    files_hash: v.string(),
    created_at: v.number(),
  })
    .index("by_app_number", ["app_id", "number"])
    .index("by_app_author", ["app_id", "author_id"]),

  /** One row per path of a version. `served_hash` is the transpiled module
   *  when the source is JSX/TS; otherwise the source is served as is. */
  version_files: defineTable({
    version_id: v.id("versions"),
    path: v.string(),
    hash: v.string(),
    served_hash: v.optional(v.string()),
  }).index("by_version_path", ["version_id", "path"]),

  /** Content addressed file bodies, shared by every version and fork that
   *  holds the same bytes. Text inline; storage is the seam for binary assets. */
  blobs: defineTable({
    hash: v.string(),
    size: v.number(),
    text: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")),
  }).index("by_hash", ["hash"]),

  /** The room's stream, ordered by _creationTime. A build card's state lives
   *  on its builds row and its live narration on build_progress; the card
   *  message only points at them. */
  messages: defineTable({
    app_id: v.id("apps"),
    kind: messageKind,
    visitor_id: v.optional(v.id("visitors")),
    body: v.string(),
    element: v.optional(elementRef),
    /** Set on an Auto message until triage decides chat or request. */
    triage: v.optional(v.literal("pending")),
    build_id: v.optional(v.id("builds")),
    note: v.optional(systemNote),
  }).index("by_app", ["app_id"]),

  builds: defineTable({
    app_id: v.id("apps"),
    request_message_id: v.id("messages"),
    card_message_id: v.optional(v.id("messages")),
    requested_by: v.id("visitors"),
    status: buildStatus,
    base_version: v.optional(v.number()),
    result_version: v.optional(v.number()),
    /** Set once the build was started again because the app's live version
     *  moved while it ran (queue.finish); a second move fails it. */
    restarted: v.optional(v.boolean()),
    cost_usd: v.optional(v.number()),
    /** Why it failed, in one line for people; `error_detail` is the raw cause. */
    error: v.optional(v.string()),
    error_detail: v.optional(v.string()),
    failure: v.optional(failureKind),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
  })
    .index("by_app_status", ["app_id", "status"])
    /** Builds running anywhere, which hold their cost ceiling against the
     *  global budget until they finish (queue.advance). */
    .index("by_status", ["status"]),

  /** What a build card narrates while Clay works, rewritten several times a
   *  second. Kept off the builds row so those writes wake only the card that
   *  shows them, never the room's whole stream (messages.list). */
  build_progress: defineTable({
    build_id: v.id("builds"),
    narration: v.array(narrationLine),
    files_touched: v.array(touchedFile),
  }).index("by_build", ["build_id"]),

  presence: defineTable({
    app_id: v.id("apps"),
    visitor_id: v.id("visitors"),
    joined_at: v.number(),
    last_seen: v.number(),
    viewing_version: v.union(v.number(), v.null()),
    /** The app's own per-person state (usePresence().setMyState). */
    state: v.optional(v.any()),
  })
    .index("by_app_visitor", ["app_id", "visitor_id"])
    .index("by_app_seen", ["app_id", "last_seen"])
    .index("by_seen", ["last_seen"]),

  /** How many people are in each app with anyone in it, and the first few
   *  to arrive (presence.ts keeps it on every arrival and departure), so the
   *  gallery reads one row per busy app and never wakes for a heartbeat. */
  crowds: defineTable({
    app_id: v.id("apps"),
    count: v.number(),
    faces: v.array(v.id("visitors")),
  })
    .index("by_app", ["app_id"])
    .index("by_count", ["count"]),

  /** Who is typing in which app, until when; apart from presence so a typing
   *  ping wakes only the room's typing readers. */
  typing: defineTable({
    app_id: v.id("apps"),
    visitor_id: v.id("visitors"),
    until: v.number(),
  }).index("by_app_visitor", ["app_id", "visitor_id"]),

  /** The runtime data layer (appData.ts): per-app documents grouped in
   *  collections. A useShared value is a doc in the "~shared" collection
   *  under its key; `rev` counts its writes so an updater can retry on a
   *  conflict instead of losing a concurrent write. */
  app_data: defineTable({
    app_id: v.id("apps"),
    collection: v.string(),
    key: v.optional(v.string()),
    value: v.any(),
    size: v.number(),
    rev: v.number(),
    created_by: v.id("visitors"),
    updated_by: v.id("visitors"),
    updated_at: v.number(),
  }).index("by_app_collection_key", ["app_id", "collection", "key"]),

  /** One row per app with data: what its app_data holds, against the caps. */
  app_data_usage: defineTable({
    app_id: v.id("apps"),
    docs: v.number(),
    bytes: v.number(),
  }).index("by_app", ["app_id"]),

  /** One row per version whose app reported a runtime error: the room hears
   *  about each version's first error once, whoever's browser saw it. */
  app_errors: defineTable({
    app_id: v.id("apps"),
    version: v.number(),
    message_id: v.id("messages"),
  }).index("by_app_version", ["app_id", "version"]),

  /** Daily totals, one row per key per UTC day (tallies.ts): build spend in
   *  dollars overall, per app and per visitor, and bytes of data copied into
   *  forks overall and per visitor. */
  tallies: defineTable({ key: v.string(), day: v.string(), value: v.number() }).index("by_key_day", ["key", "day"])
    .index("by_day", ["day"]),

  /** Fixed-window counters (lib/rateLimit), keyed "<rule>:<subject>". */
  limits: defineTable({
    key: v.string(),
    window_start: v.number(),
    count: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_window_start", ["window_start"]),

  /** "Report this app": one row per visitor per app, kept for a person to
   *  read later (there is no moderation UI in v1). */
  reports: defineTable({
    app_id: v.id("apps"),
    visitor_id: v.id("visitors"),
    /** The version on screen when they reported it. */
    version: v.number(),
    reason: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_app_visitor", ["app_id", "visitor_id"])
    .index("by_created", ["created_at"]),
});
