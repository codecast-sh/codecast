// Live artifacts (boards, sheets, dashboards): structured doc content synced
// as elements. See liveArtifacts.ts and @codecast/shared/artifacts.

import { defineTable } from "convex/server";
import { v } from "convex/values";

const vLayer = v.union(v.literal("main"), v.literal("draft"), v.literal("comments"));
const vPosition = v.object({
  point: v.optional(v.object({ x: v.number(), y: v.number() })),
  cell: v.optional(v.string()),
  range: v.optional(v.string()),
  block: v.optional(v.string()),
  key: v.optional(v.string()),
});

export const liveArtifactValidators = { vLayer, vPosition };

export const liveArtifactTables = {
  // One row per (doc, layer, element key): the element's current state.
  // `rev` is the doc revision of its last write, unique per doc, so the live
  // tail is "rows with rev > what I hold". A deleted element stays as a
  // tombstone (`deleted`) so clients learn of the delete; `dead` marks a
  // draft row a save or discard retired.
  live_elements: defineTable({
    doc_id: v.id("docs"),
    layer: vLayer,
    key: v.string(),
    kind: v.string(),
    fields: v.any(),
    rev: v.number(),
    by: v.string(),
    at: v.number(),
    deleted: v.optional(v.boolean()),
    dead: v.optional(v.boolean()),
  })
    .index("by_doc_layer_key", ["doc_id", "layer", "key"])
    .index("by_doc_rev", ["doc_id", "rev"]),

  // Per doc: the revision counter, the one pending draft, checkpoint timing.
  live_heads: defineTable({
    doc_id: v.id("docs"),
    rev: v.number(),
    last_write_at: v.number(),
    // Element rows the doc holds that are not dead (tombstones count): what a
    // client compares its cache against before trusting it as a base for the
    // tail. Absent on heads that predate it until countLiveRows fills it in.
    rows: v.optional(v.number()),
    // Who may change the artifact (not who may see it: that is the doc's
    // workspace). "team" (the default): everyone who can open it. "owners":
    // its owner and the people in `editors`; everyone else views and comments.
    edit: v.optional(v.union(v.literal("team"), v.literal("owners"))),
    editors: v.optional(v.array(v.id("users"))),
    // A search reindex is scheduled (liveSearch.ts): later writes ride it.
    search_due: v.optional(v.number()),
    // When the newest version was taken: steady editing autosaves from it.
    last_version_at: v.optional(v.number()),
    draft: v.optional(v.object({ by: v.string(), by_name: v.string(), at: v.number(), label: v.optional(v.string()) })),
    // Elements the open draft holds (capped so it can always close in one transaction).
    draft_count: v.optional(v.number()),
    draft_bytes: v.optional(v.number()),
    // A restore too big for one transaction, while its chunks are landing:
    // set by the first chunk, cleared by the last. Left behind only if the
    // restore stopped partway; the page offers to finish (restore to `to`)
    // or undo it (restore to `from`).
    restoring: v.optional(v.object({ to: v.number(), from: v.number(), by: v.string(), by_name: v.string(), at: v.number() })),
  }).index("by_doc", ["doc_id"]),

  // The op log: every written batch, in order. History folds it.
  live_batches: defineTable({
    doc_id: v.id("docs"),
    layer: vLayer,
    rev_from: v.number(),
    rev_to: v.number(),
    ops: v.any(),
    actor: v.string(),
    actor_name: v.string(),
    client_id: v.optional(v.string()),
    at: v.number(),
  }).index("by_doc_rev", ["doc_id", "rev_to"]),

  // Checkpoints of the main layer. `snapshot` is the folded state at `rev`,
  // stored as a JSON blob once the snapshot job writes it.
  live_versions: defineTable({
    doc_id: v.id("docs"),
    rev: v.number(),
    label: v.string(),
    reason: v.union(v.literal("auto"), v.literal("manual"), v.literal("draft_saved"), v.literal("restore")),
    by: v.string(),
    by_name: v.string(),
    at: v.number(),
    elements: v.optional(v.number()),
    snapshot: v.optional(v.id("_storage")),
  }).index("by_doc_rev", ["doc_id", "rev"]),

  // The words in an artifact (shared/artifacts/search.ts), one row per doc,
  // under the doc's workspace key so a search reads only the viewer's
  // workspaces. Rewritten a little after writes settle (liveSearch.ts).
  live_search: defineTable({
    doc_id: v.id("docs"),
    workspace: v.string(),
    text: v.string(),
    at: v.number(),
  })
    .index("by_doc", ["doc_id"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["workspace"] }),

  // Who is in an artifact now: a person's tab or an agent session.
  live_presence: defineTable({
    doc_id: v.id("docs"),
    actor: v.string(),
    kind: v.union(v.literal("person"), v.literal("agent")),
    user_id: v.id("users"),
    name: v.string(),
    color: v.string(),
    image: v.optional(v.string()),
    session_id: v.optional(v.string()),
    session_short_id: v.optional(v.string()),
    position: v.optional(vPosition),
    selection: v.optional(v.array(v.string())),
    status: v.optional(v.string()),
    updated_at: v.number(),
  })
    .index("by_doc_updated", ["doc_id", "updated_at"])
    .index("by_doc_actor", ["doc_id", "actor"]),
};
