// Remote mirror of a local markdown vault — the read-only projection that lets
// a vault registered on one machine be browsed from another device.
//
// THE LOCAL FILESYSTEM STAYS CANONICAL. Nothing here is a source of truth: the
// daemon on the owning device pushes metadata, the browser reads it, and every
// write still goes through the loopback bridge on the machine that holds the
// files. If this table were empty the local experience would be unchanged.
//
// Bodies are NOT rows. The docs table pages 12 at a time because Convex
// materializes whole bodies into a 64MB isolate heap before a handler can strip
// them; a vault of a thousand notes would hit that far harder. A note body
// rides ctx.storage and the row carries only a storage id, so every query here
// is metadata-sized no matter how much prose the vault holds.
//
// Access: a user reads ONLY their own mirrors. There is no team sharing in this
// phase — vault_mirrors.is_public exists for the later tier that will hang off
// directory_team_mappings, and nothing reads it yet.

import { v } from "convex/values";
import { query, mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { requireUser, requireUserOrToken, notFound } from "./lib/auth";
import {
  VAULT_MIRROR_MAX_LINKS,
  VAULT_MIRROR_MAX_STAMP_BATCH,
  VAULT_MIRROR_MAX_TAGS,
} from "@codecast/shared/contracts";

// One push carries at most this many notes. The daemon already chunks by
// serialized bytes (the syncService lesson: a multi-MB mutation can't commit
// inside the isolate/timeout budget); this is the backstop for a caller that
// doesn't.
export const MAX_UPSERT_BATCH = 500;

// The completion sweep walks the vault's rows in path order, at most this many
// per call, and hands back the path it stopped at. Never `collect()`: a vault is
// allowed to be large, and a mutation that walks every row of it is the exact
// shape of read that saturates a Convex isolate. The daemon keeps re-declaring
// completion until the cursor comes back null.
export const SWEEP_WALK_BUDGET = 500;

// Metadata rows are small, but `links` and `tags` still add up across a page.
// Small pages, always — this is the same discipline the docs clamp encodes.
export const MAX_NOTES_PAGE = 200;
const DEFAULT_NOTES_PAGE = 100;

const noteValidator = v.object({
  path: v.string(),
  title: v.string(),
  mtime: v.number(),
  size: v.number(),
  content_hash: v.string(),
  tags: v.array(v.string()),
  links: v.array(v.string()),
  heading_count: v.number(),
  is_dir: v.optional(v.boolean()),
  body_storage_id: v.optional(v.id("_storage")),
});

type IncomingNote = {
  path: string;
  title: string;
  mtime: number;
  size: number;
  content_hash: string;
  tags: string[];
  links: string[];
  heading_count: number;
  is_dir?: boolean;
  body_storage_id?: Id<"_storage">;
};

/**
 * Whether a stored row needs rewriting for an incoming push. content_hash is the
 * discriminator: identical content means the note is the same note even if its
 * mtime moved (a touch, a checkout, a backup restore), and skipping those writes
 * is what keeps an idle vault's periodic full scan free instead of rewriting
 * every row every cycle. The other fields are checked because a rename or a new
 * body upload changes the row without changing the content.
 *
 * Pure — unit-tested without a backend.
 */
export function mirrorRowNeedsWrite(
  existing: {
    content_hash: string;
    title: string;
    mtime: number;
    size: number;
    scan_id?: string;
    body_storage_id?: string;
  } | null,
  incoming: { content_hash: string; title: string; mtime: number; size: number; body_storage_id?: string },
  scanId?: string,
): boolean {
  if (!existing) return true;
  if (existing.content_hash !== incoming.content_hash) return true;
  if (existing.title !== incoming.title) return true;
  if (existing.mtime !== incoming.mtime || existing.size !== incoming.size) return true;
  if (incoming.body_storage_id && incoming.body_storage_id !== existing.body_storage_id) return true;
  // An unchanged row still has to be re-stamped, or the completion sweep would
  // delete every note the scan legitimately found unchanged.
  if (scanId !== undefined && existing.scan_id !== scanId) return true;
  return false;
}

/**
 * Clamp the two arrays that can grow without bound. A generated index note can
 * carry hundreds of links; mirroring all of them inflates the row and buys the
 * reader nothing, since a link list that long is never read as a list.
 *
 * Pure — unit-tested without a backend.
 */
export function clampMirrorNote<T extends { tags: string[]; links: string[] }>(note: T): T {
  return {
    ...note,
    tags: note.tags.slice(0, VAULT_MIRROR_MAX_TAGS),
    links: note.links.slice(0, VAULT_MIRROR_MAX_LINKS),
  };
}

/** Drop a body blob, tolerating an id that storage no longer has. One row owns
 *  one blob (the artifacts invariant), so this is always safe: no other row can
 *  be pointing at it. */
async function dropBody(ctx: MutationCtx, storageId?: Id<"_storage">): Promise<void> {
  if (!storageId) return;
  await ctx.storage.delete(storageId).catch(() => {});
}

/** A note row is addressed by (user, vault, device, path) — see the schema note
 *  on why the device is part of the identity and not just a field. */
async function findNote(
  ctx: { db: any },
  userId: Id<"users">,
  vaultId: string,
  deviceId: string,
  path: string,
): Promise<Doc<"vault_notes"> | null> {
  return await ctx.db
    .query("vault_notes")
    .withIndex("by_user_vault_device", (q: any) =>
      q.eq("user_id", userId).eq("vault_id", vaultId).eq("device_id", deviceId).eq("path", path),
    )
    .first();
}

async function findMirror(
  ctx: { db: any },
  userId: Id<"users">,
  vaultId: string,
  deviceId: string,
): Promise<Doc<"vault_mirrors"> | null> {
  return await ctx.db
    .query("vault_mirrors")
    .withIndex("by_user_vault", (q: any) =>
      q.eq("user_id", userId).eq("vault_id", vaultId).eq("device_id", deviceId),
    )
    .first();
}

// ---------------------------------------------------------------------------
// Daemon (token-authed) writes
// ---------------------------------------------------------------------------

/**
 * Announce a vault before pushing its notes, and carry its opt-in state. The
 * user turned mirroring on with `cast vault mirror <dir> --on`; turning it off
 * calls this with enabled:false, which deletes the mirror row AND every note it
 * projected. Off means gone, not stale — a user who revokes consent should not
 * find the notes still readable from another device.
 */
export const cliRegisterMirror = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    vault_id: v.string(),
    name: v.string(),
    root: v.string(),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const existing = await findMirror(ctx, userId, args.vault_id, args.device_id);

    if (args.enabled === false) {
      // Notes go first: a caller that stops looping mid-purge leaves the mirror
      // row behind as the marker that there is still something to clean up.
      const { removed, more } = await purgeVaultNotes(ctx, userId, args.vault_id, args.device_id);
      if (!more && existing) await ctx.db.delete(existing._id);
      return { ok: true, enabled: false, removed, more };
    }

    if (existing) {
      await ctx.db.patch(existing._id, { name: args.name, root: args.root });
      return { ok: true, enabled: true, mirror_id: existing._id };
    }
    const mirrorId = await ctx.db.insert("vault_mirrors", {
      user_id: userId,
      device_id: args.device_id,
      vault_id: args.vault_id,
      name: args.name,
      root: args.root,
      note_count: 0,
      last_synced_at: Date.now(),
    });
    return { ok: true, enabled: true, mirror_id: mirrorId };
  },
});

/** Delete one device's note rows (and their body blobs), budgeted so a huge
 *  vault can't blow the isolate. `more` tells the caller to call again. */
async function purgeVaultNotes(
  ctx: MutationCtx,
  userId: Id<"users">,
  vaultId: string,
  deviceId: string,
): Promise<{ removed: number; more: boolean }> {
  const rows = await ctx.db
    .query("vault_notes")
    .withIndex("by_user_vault_device", (q: any) =>
      q.eq("user_id", userId).eq("vault_id", vaultId).eq("device_id", deviceId))
    .take(SWEEP_WALK_BUDGET);
  let removed = 0;
  for (const row of rows) {
    await dropBody(ctx, row.body_storage_id);
    await ctx.db.delete(row._id);
    removed++;
  }
  return { removed, more: rows.length === SWEEP_WALK_BUDGET };
}

/**
 * The push. Upserts a batch of note metadata, applies any targeted deletes the
 * watcher reported, and — when the batch declares itself the last of a full scan
 * — sweeps rows the scan never touched.
 *
 * The sweep is why every row carries `scan_id`. A full scan arrives as many
 * batches, so no single batch knows the whole path list; stamping each upserted
 * row with the scan's id turns "absent from this scan" into a property the
 * server can decide one row at a time. That is what makes deletions the daemon
 * was never running to observe (a folder removed while the machine was off)
 * still reach the mirror.
 */
export const cliUpsertNotes = mutation({
  args: {
    api_token: v.optional(v.string()),
    device_id: v.string(),
    vault_id: v.string(),
    vault_name: v.string(),
    notes: v.array(noteValidator),
    deleted_paths: v.optional(v.array(v.string())),
    /** Paths the scan saw unchanged: re-stamp only, no metadata rewrite. */
    stamp_paths: v.optional(v.array(v.string())),
    scan_id: v.optional(v.string()),
    complete: v.optional(v.boolean()),
    /** Where the previous sweep call stopped. Absent starts at the beginning. */
    sweep_after_path: v.optional(v.string()),
    /** Notes the daemon's scan counted. It knows the number exactly; deriving it
     *  here would mean walking every row of the vault on every batch. */
    note_count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (args.notes.length > MAX_UPSERT_BATCH) {
      throw new Error(`Batch too large: ${args.notes.length} notes (max ${MAX_UPSERT_BATCH})`);
    }
    const now = Date.now();
    let upserted = 0;
    let deleted = 0;

    for (const raw of args.notes) {
      const note = clampMirrorNote(raw as IncomingNote);
      const existing = await findNote(ctx, userId, args.vault_id, args.device_id, note.path);
      if (!mirrorRowNeedsWrite(existing, note, args.scan_id)) continue;

      // The row owns its blob. When the content changed, the old body is dead
      // the moment the new one lands — dropping it here is what keeps storage
      // from growing by one blob per edit.
      const keepBody =
        existing && existing.content_hash === note.content_hash && !note.body_storage_id
          ? existing.body_storage_id
          : undefined;
      const nextBody = note.body_storage_id ?? keepBody;
      if (existing && existing.body_storage_id && existing.body_storage_id !== nextBody) {
        await dropBody(ctx, existing.body_storage_id);
      }

      const fields = {
        user_id: userId,
        device_id: args.device_id,
        vault_id: args.vault_id,
        vault_name: args.vault_name,
        path: note.path,
        title: note.title,
        mtime: note.mtime,
        size: note.size,
        content_hash: note.content_hash,
        tags: note.tags,
        links: note.links,
        heading_count: note.heading_count,
        ...(note.is_dir ? { is_dir: true as const } : {}),
        ...(nextBody ? { body_storage_id: nextBody } : {}),
        ...(args.scan_id ? { scan_id: args.scan_id } : {}),
        updated_at: now,
      };
      if (existing) await ctx.db.replace(existing._id, fields);
      else await ctx.db.insert("vault_notes", fields);
      upserted++;
    }

    // Unchanged notes: refresh the scan stamp so the sweep spares them, and
    // touch nothing else. This is the cheap half of a full scan — a vault where
    // nothing changed costs one index read per note and zero writes.
    const stampPaths = args.stamp_paths ?? [];
    if (stampPaths.length > VAULT_MIRROR_MAX_STAMP_BATCH) {
      throw new Error(
        `Too many stamp paths: ${stampPaths.length} (max ${VAULT_MIRROR_MAX_STAMP_BATCH})`,
      );
    }
    if (args.scan_id) {
      for (const path of stampPaths) {
        const row = await findNote(ctx, userId, args.vault_id, args.device_id, path);
        if (!row || row.scan_id === args.scan_id) continue;
        await ctx.db.patch(row._id, { scan_id: args.scan_id });
      }
    }

    for (const path of args.deleted_paths ?? []) {
      const row = await findNote(ctx, userId, args.vault_id, args.device_id, path);
      if (!row) continue;
      await dropBody(ctx, row.body_storage_id);
      await ctx.db.delete(row._id);
      deleted++;
    }

    let sweepAfter: string | null = null;
    if (args.complete && args.scan_id) {
      const walked = await ctx.db
        .query("vault_notes")
        .withIndex("by_user_vault_device", (q: any) => {
          const base = q
            .eq("user_id", userId)
            .eq("vault_id", args.vault_id)
            .eq("device_id", args.device_id);
          return args.sweep_after_path === undefined ? base : base.gt("path", args.sweep_after_path);
        })
        .take(SWEEP_WALK_BUDGET);
      for (const row of walked) {
        if (row.scan_id === args.scan_id) continue;
        await dropBody(ctx, row.body_storage_id);
        await ctx.db.delete(row._id);
        deleted++;
      }
      // A short walk means the index is exhausted and the sweep is finished.
      sweepAfter = walked.length === SWEEP_WALK_BUDGET ? walked[walked.length - 1].path : null;
    }

    const mirror = await findMirror(ctx, userId, args.vault_id, args.device_id);
    if (mirror) {
      await ctx.db.patch(mirror._id, {
        name: args.vault_name,
        ...(args.note_count === undefined ? {} : { note_count: args.note_count }),
        last_synced_at: now,
      });
    }

    return {
      upserted,
      deleted,
      sweep_complete: sweepAfter === null,
      sweep_after_path: sweepAfter,
      note_count: mirror?.note_count ?? args.note_count ?? 0,
    };
  },
});

// ---------------------------------------------------------------------------
// Web (session-authed) reads. Owner-only, every one of them.
// ---------------------------------------------------------------------------

/** Every vault the signed-in user mirrors, across all their devices. */
export const webListVaults = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const mirrors = await ctx.db
      .query("vault_mirrors")
      .withIndex("by_user", (q: any) => q.eq("user_id", userId))
      .collect();
    return mirrors
      .map((m) => ({
        vault_id: m.vault_id,
        device_id: m.device_id,
        name: m.name,
        root: m.root,
        note_count: m.note_count,
        last_synced_at: m.last_synced_at,
      }))
      .sort((a, b) => b.last_synced_at - a.last_synced_at);
  },
});

/**
 * One page of note metadata, walking the index in path order. The cursor is
 * just the last path returned, so a client resumes mid-vault without holding a
 * server cursor. Bodies never appear here — that is the whole point of the
 * split, and it is what lets the page size be sane instead of 12.
 *
 * `device_id` picks one machine's copy. Naming it also narrows the index, so a
 * vault mirrored from two machines pages each of them at full width instead of
 * interleaving them.
 */
export const webListNotes = query({
  args: {
    vault_id: v.string(),
    device_id: v.optional(v.string()),
    /** Exclusive: the last path from the previous page. */
    after_path: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const limit = Math.min(Math.max(args.limit ?? DEFAULT_NOTES_PAGE, 1), MAX_NOTES_PAGE);
    const after = (idx: any) =>
      args.after_path === undefined ? idx : idx.gt("path", args.after_path);
    const rows = args.device_id
      ? await ctx.db
          .query("vault_notes")
          .withIndex("by_user_vault_device", (idx: any) =>
            after(
              idx.eq("user_id", userId).eq("vault_id", args.vault_id).eq("device_id", args.device_id),
            ),
          )
          .take(limit + 1)
      : await ctx.db
          .query("vault_notes")
          .withIndex("by_user_vault", (idx: any) =>
            after(idx.eq("user_id", userId).eq("vault_id", args.vault_id)),
          )
          .take(limit + 1);
    const page = rows.slice(0, limit);
    return {
      notes: page.map(stripNoteRow),
      next_path: rows.length > limit ? page[page.length - 1].path : null,
    };
  },
});

function stripNoteRow(row: Doc<"vault_notes">) {
  return {
    vault_id: row.vault_id,
    device_id: row.device_id,
    path: row.path,
    title: row.title,
    mtime: row.mtime,
    size: row.size,
    content_hash: row.content_hash,
    tags: row.tags,
    links: row.links,
    heading_count: row.heading_count,
    ...(row.is_dir ? { is_dir: true } : {}),
    ...(row.body_storage_id ? { body_storage_id: row.body_storage_id } : {}),
    updated_at: row.updated_at,
  };
}

/**
 * One note plus a signed URL for its body. `body_url` is null when the body was
 * never uploaded — a note over the size gate, or one the daemon hasn't been
 * asked for yet. A reader that gets null shows the metadata and says the body
 * lives on the other machine; it does not treat it as an error.
 */
export const webGetNote = query({
  args: {
    vault_id: v.string(),
    path: v.string(),
    /** Required only to disambiguate a vault mirrored from two machines. */
    device_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = args.device_id
      ? await findNote(ctx, userId, args.vault_id, args.device_id, args.path)
      : await ctx.db
          .query("vault_notes")
          .withIndex("by_user_vault", (q: any) =>
            q.eq("user_id", userId).eq("vault_id", args.vault_id).eq("path", args.path))
          .first();
    if (!row) return notFound("Note not mirrored");
    return {
      note: stripNoteRow(row),
      body_url: row.body_storage_id ? await ctx.storage.getUrl(row.body_storage_id) : null,
    };
  },
});
