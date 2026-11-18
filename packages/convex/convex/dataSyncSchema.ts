// Data sync: folders outside any repo that a person's machines share, such as
// a tool's local data dir (eval freezes under ~/.local/share/codecast/evals).
// A repo declares them in .codecast/workspace.toml ([host] data); every daemon
// of that person keeps its copy level with this index (dataSync.ts). Personal
// by construction: a row is one person's file and carries no team routing.
// Spliced into schema.ts as `...dataSyncTables`.
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const dataSyncTables = {
  // A folder every machine of this person syncs, by its path under $HOME.
  data_folders: defineTable({
    user_id: v.id("users"),
    path: v.string(),
    // The repo whose manifest declared it, for `cast data` to show.
    declared_by: v.optional(v.string()),
    // Live bytes of this folder's files, held against the per-person quota.
    bytes: v.number(),
    files: v.number(),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_user_path", ["user_id", "path"]),

  // One file of a synced folder, at its newest version. A deletion stays as a
  // tombstone so every machine learns of it.
  data_files: defineTable({
    user_id: v.id("users"),
    folder: v.string(),
    rel: v.string(),
    sha256: v.string(),
    size: v.number(),
    // The writer's modification time, which settles a file both sides changed.
    mtime: v.number(),
    deleted: v.boolean(),
    storage_id: v.optional(v.id("_storage")),
    device_id: v.optional(v.string()),
    // Strictly increasing per person: a machine reads every change past the last one it saw.
    seq: v.number(),
  })
    .index("by_user_folder_rel", ["user_id", "folder", "rel"])
    .index("by_user_seq", ["user_id", "seq"])
    .index("by_user_sha", ["user_id", "sha256"]),
};
