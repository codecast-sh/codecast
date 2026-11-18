// Data sync: the index every machine of one person reads and writes to keep
// the folders their repos declare ([host] data in .codecast/workspace.toml)
// the same everywhere. The daemon's loop (packages/cli/src/dataSync) uploads a
// file's bytes to storage, commits its row here, and reads every row past the
// last `seq` it saw. Every function is scoped to the caller: a row is one
// person's file and nobody else's.
import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./permissions";
import {
  DATA_SYNC_MAX_FILE_BYTES,
  DATA_SYNC_MAX_USER_BYTES,
  DATA_SYNC_PAGE,
  dataFolderProblem,
  dataRelProblem,
} from "@codecast/shared/contracts/dataSync";

async function requireUser(ctx: { db: any }, apiToken: string | undefined): Promise<Id<"users">> {
  const userId = await getAuthenticatedUserId(ctx, apiToken);
  if (!userId) throw new Error("Authentication required");
  return userId;
}

/** Convex keeps a blob's sha256 as base64; the index keys files by hex. */
const hexOf = (b64: string): string => Array.from(atob(b64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

/** Records that a repo declared these folders; every machine of the caller then syncs them. */
export const declareFolders = mutation({
  args: { api_token: v.optional(v.string()), folders: v.array(v.object({ path: v.string(), declared_by: v.optional(v.string()) })) },
  handler: async (ctx, args): Promise<{ added: string[] }> => {
    const userId = await requireUser(ctx, args.api_token);
    const added: string[] = [];
    for (const f of args.folders.slice(0, 50)) {
      const problem = dataFolderProblem(f.path);
      if (problem) throw new Error(`data folder ${f.path}: ${problem}`);
      const existing = await ctx.db.query("data_folders").withIndex("by_user_path", (q: any) => q.eq("user_id", userId).eq("path", f.path)).first();
      if (existing) {
        if (f.declared_by && existing.declared_by !== f.declared_by) await ctx.db.patch(existing._id, { declared_by: f.declared_by, updated_at: Date.now() });
        continue;
      }
      const now = Date.now();
      await ctx.db.insert("data_folders", { user_id: userId, path: f.path, declared_by: f.declared_by, bytes: 0, files: 0, created_at: now, updated_at: now });
      added.push(f.path);
    }
    return { added };
  },
});

/** The caller's synced folders, with their live size. */
export const folders = query({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<Array<{ path: string; declared_by: string | null; bytes: number; files: number; updated_at: number }>> => {
    const userId = await requireUser(ctx, args.api_token);
    const rows = await ctx.db.query("data_folders").withIndex("by_user_path", (q: any) => q.eq("user_id", userId)).collect();
    return rows.map((r: any) => ({ path: r.path, declared_by: r.declared_by ?? null, bytes: r.bytes, files: r.files, updated_at: r.updated_at }));
  },
});

/** Every change to the caller's files after `since`, oldest first, with a download URL for each live one. */
export const changes = query({
  args: { api_token: v.optional(v.string()), since: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ rows: Array<{ folder: string; rel: string; sha256: string; size: number; mtime: number; deleted: boolean; seq: number; device_id: string | null; url: string | null }>; more: boolean }> => {
    const userId = await requireUser(ctx, args.api_token);
    const limit = Math.min(Math.max(args.limit ?? DATA_SYNC_PAGE, 1), DATA_SYNC_PAGE);
    const page = await ctx.db.query("data_files").withIndex("by_user_seq", (q: any) => q.eq("user_id", userId).gt("seq", args.since)).take(limit + 1);
    const rows = [];
    for (const r of page.slice(0, limit)) {
      const url = !r.deleted && r.storage_id ? await ctx.storage.getUrl(r.storage_id) : null;
      rows.push({ folder: r.folder, rel: r.rel, sha256: r.sha256, size: r.size, mtime: r.mtime, deleted: r.deleted, seq: r.seq, device_id: r.device_id ?? null, url });
    }
    return { rows, more: page.length > limit };
  },
});

/** Which of these contents are already stored for the caller, so a machine uploads only bytes nobody has sent. */
export const knownContents = query({
  args: { api_token: v.optional(v.string()), shas: v.array(v.string()) },
  handler: async (ctx, args): Promise<string[]> => {
    const userId = await requireUser(ctx, args.api_token);
    const known: string[] = [];
    for (const sha of [...new Set(args.shas)].slice(0, DATA_SYNC_PAGE)) {
      const hit = await ctx.db.query("data_files").withIndex("by_user_sha", (q: any) => q.eq("user_id", userId).eq("sha256", sha)).filter((q: any) => q.neq(q.field("storage_id"), undefined)).first();
      if (hit) known.push(sha);
    }
    return known;
  },
});

export const uploadUrl = mutation({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    await requireUser(ctx, args.api_token);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Writes this machine's changes. A live file names the bytes it uploaded
 * (`storage_id`), whose size and sha the storage itself must confirm, or
 * content the caller already stored (by sha). Bytes no row points to any more
 * leave storage. Returns the seq each change was written at.
 */
export const commit = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.optional(v.string()),
    changes: v.array(v.object({
      folder: v.string(),
      rel: v.string(),
      sha256: v.string(),
      size: v.number(),
      mtime: v.number(),
      deleted: v.boolean(),
      storage_id: v.optional(v.id("_storage")),
    })),
  },
  handler: async (ctx, args): Promise<{ seqs: number[] }> => {
    const userId = await requireUser(ctx, args.api_token);
    if (args.changes.length > DATA_SYNC_PAGE) throw new Error(`at most ${DATA_SYNC_PAGE} changes per commit`);
    const folderRows = new Map<string, any>();
    const folderOf = async (path: string) => {
      if (!folderRows.has(path)) folderRows.set(path, await ctx.db.query("data_folders").withIndex("by_user_path", (q: any) => q.eq("user_id", userId).eq("path", path)).first());
      const row = folderRows.get(path);
      if (!row) throw new Error(`${path} is not a synced folder; a repo declares it in .codecast/workspace.toml [host] data`);
      return row;
    };
    const last = await ctx.db.query("data_files").withIndex("by_user_seq", (q: any) => q.eq("user_id", userId)).order("desc").first();
    let seq = last?.seq ?? 0;
    const allFolders = await ctx.db.query("data_folders").withIndex("by_user_path", (q: any) => q.eq("user_id", userId)).collect();
    let userBytes = allFolders.reduce((n: number, f: any) => n + f.bytes, 0);
    const orphaned = new Map<Id<"_storage">, string>();
    const seqs: number[] = [];
    for (const c of args.changes) {
      const folder = await folderOf(c.folder);
      const problem = dataRelProblem(c.rel);
      if (problem) throw new Error(`${c.folder}/${c.rel}: ${problem}`);
      if (!/^[0-9a-f]{64}$/.test(c.sha256)) throw new Error(`${c.rel}: sha256 must be 64 hex digits`);
      if (c.size > DATA_SYNC_MAX_FILE_BYTES) throw new Error(`${c.rel} is ${c.size} bytes, over the ${DATA_SYNC_MAX_FILE_BYTES} byte limit for a synced file`);
      const prev = await ctx.db.query("data_files").withIndex("by_user_folder_rel", (q: any) => q.eq("user_id", userId).eq("folder", c.folder).eq("rel", c.rel)).first();
      let storageId: Id<"_storage"> | undefined;
      if (!c.deleted) {
        if (c.storage_id) {
          const blob = await ctx.db.system.get(c.storage_id);
          if (!blob || blob.size !== c.size || hexOf(blob.sha256) !== c.sha256) throw new Error(`${c.rel}: the uploaded bytes do not match its size and sha256`);
          storageId = c.storage_id;
        } else {
          const same = await ctx.db.query("data_files").withIndex("by_user_sha", (q: any) => q.eq("user_id", userId).eq("sha256", c.sha256)).filter((q: any) => q.neq(q.field("storage_id"), undefined)).first();
          if (!same) throw new Error(`${c.rel}: no stored content has sha256 ${c.sha256.slice(0, 12)}; upload it first`);
          storageId = same.storage_id;
        }
      }
      const delta = (c.deleted ? 0 : c.size) - (prev && !prev.deleted ? prev.size : 0);
      if (delta > 0 && userBytes + delta > DATA_SYNC_MAX_USER_BYTES) throw new Error(`synced data is over the ${Math.round(DATA_SYNC_MAX_USER_BYTES / 2 ** 30)} GiB limit`);
      userBytes += delta;
      seq = Math.max(seq + 1, Date.now());
      const row = { sha256: c.sha256, size: c.size, mtime: c.mtime, deleted: c.deleted, storage_id: storageId, device_id: args.device_id, seq };
      if (prev) {
        if (prev.storage_id && prev.storage_id !== storageId) orphaned.set(prev.storage_id, prev.sha256);
        await ctx.db.patch(prev._id, row);
      } else {
        await ctx.db.insert("data_files", { user_id: userId, folder: c.folder, rel: c.rel, ...row });
      }
      folder.bytes += delta;
      folder.files += (c.deleted ? 0 : 1) - (prev && !prev.deleted ? 1 : 0);
      seqs.push(seq);
    }
    for (const f of folderRows.values()) if (f) await ctx.db.patch(f._id, { bytes: f.bytes, files: f.files, updated_at: Date.now() });
    // Bytes no file points to any more: a tombstone keeps its sha but not its storage.
    // Only a row with the same content can share its storage, so the sha index answers whether any still does.
    for (const [id, sha] of orphaned) {
      const still = await ctx.db.query("data_files").withIndex("by_user_sha", (q: any) => q.eq("user_id", userId).eq("sha256", sha)).filter((q: any) => q.eq(q.field("storage_id"), id)).first();
      if (!still) await ctx.storage.delete(id);
    }
    return { seqs };
  },
});
