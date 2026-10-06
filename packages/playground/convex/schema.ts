import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { buildStatus, elementRef, messageKind, systemNote, versionKind, versionRef } from "./validators";

export default defineSchema({
  /** Anonymous people. The secret lives in their browser; only its hash here.
   *  Character fields follow @codecast/shared sessionCharacter: unset means the
   *  hash default for the id. */
  visitors: defineTable({
    secret_hash: v.string(),
    character_avatar: v.optional(v.string()),
    character_name: v.optional(v.string()),
    created_at: v.number(),
    seen_at: v.number(),
  }),

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
    budget: v.optional(v.object({ day: v.string(), spent_usd: v.number() })),
  })
    .index("by_slug", ["slug"])
    .index("by_last_activity", ["last_activity_at"]),

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
   *  on its builds row; the card message only points at it. */
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
    narration: v.array(v.object({ at: v.number(), text: v.string() })),
    files_touched: v.array(v.string()),
    cost_usd: v.optional(v.number()),
    error: v.optional(v.string()),
    started_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
  }).index("by_app_status", ["app_id", "status"]),

  presence: defineTable({
    app_id: v.id("apps"),
    visitor_id: v.id("visitors"),
    joined_at: v.number(),
    last_seen: v.number(),
    typing_until: v.number(),
    viewing_version: v.union(v.number(), v.null()),
    /** The app's own per-person state (usePresence().setMyState). */
    state: v.optional(v.any()),
  })
    .index("by_app_visitor", ["app_id", "visitor_id"])
    .index("by_app_seen", ["app_id", "last_seen"])
    .index("by_seen", ["last_seen"]),

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

  /** Fixed-window counters (lib/rateLimit), keyed "<rule>:<subject>". */
  limits: defineTable({
    key: v.string(),
    window_start: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),
});
