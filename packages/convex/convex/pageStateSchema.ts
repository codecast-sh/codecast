// Page state: the rows a published page reads and writes live (pageState.ts,
// declared under "state" in cast-data.json; @codecast/shared/contracts/pageData).

import { defineTable } from "convex/server";
import { v } from "convex/values";

export const pageStateTables = {
  // A page's declared collections, rewritten by every publish and rollback
  // with the rest of its cast-data.json set (pageData.applySet). One row per
  // page; absent when the page declares no state.
  page_state_config: defineTable({
    artifact_id: v.id("artifacts"),
    /** PageStateCollection[] as JSON. */
    collections_json: v.string(),
    /** The access key the publish resolved: team policy on public sharing is read from it. */
    workspace: v.string(),
    updated_at: v.number(),
  }).index("by_artifact", ["artifact_id"]),

  // One row per (page, collection, key). The value is JSON text, because a
  // page's own keys need not be Convex field names. Kept when the collection
  // leaves the declaration, so a rollback that brings it back finds its rows.
  page_state: defineTable({
    artifact_id: v.id("artifacts"),
    collection: v.string(),
    key: v.string(),
    value_json: v.string(),
    /** The signed-in author, stamped by the server; absent for anonymous rows and the owner's CLI writes carry the owner. */
    author_user_id: v.optional(v.id("users")),
    /** The agent session that last wrote the row through the CLI, so the page can show an agent's answer as the agent's. */
    author_conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_artifact_collection_key", ["artifact_id", "collection", "key"]),

  // Per (page, collection): rows and bytes held, so a write checks the caps
  // without reading the collection. Kept apart from the rows so a write does
  // not wake a subscriber of another collection.
  page_state_counts: defineTable({
    artifact_id: v.id("artifacts"),
    collection: v.string(),
    rows: v.number(),
    bytes: v.number(),
  }).index("by_artifact_collection", ["artifact_id", "collection"]),
};
