// Published HTML artifacts — `cast publish <file|dir>` → https://codecast.sh/a/<slug>.
//
// DATA LAYER ONLY: queries and mutations. Presentation (bar, gate pages,
// source/diff/editor pages) lives in artifactPages.ts; HTTP routing and
// everything that needs Web Crypto or storage.store lives in artifactsHttp.ts.
//
// Access model: the slug is an unguessable secret — anyone holding the URL can
// view, unless gates (password / email wall / expiry) are set. Two further
// secrets exist per artifact: owner_key (management from the served page,
// travels only in the #o= fragment) and edit_key (link collaborators,
// #ed= fragment). Blob invariant: every storage_id in the artifact tables is
// referenced by exactly ONE row — rollback and link-edits COPY blobs.
//
// Publish identity: (user_id, source_path). Re-publishing the same file updates
// the same artifact in place — the URL is stable across revisions — unless the
// caller forces a fresh one (`cast publish --new`).

import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { performSessionSend } from "./pendingMessages";
import { findConversationByAnyRef } from "./conversationSessionLookup";

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

// Superseded versions kept per artifact (beyond the current one). Old blobs
// are snapshotted into artifact_versions on republish; past this cap the
// oldest snapshot (rows + blobs, including its assets) is pruned so
// auto-republish loops can't grow storage without bound.
export const MAX_ARTIFACT_HISTORY = 20;

export const MAX_COMMENT_BATCH = 12;
export const MAX_COMMENT_CHARS = 2000;

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LENGTH = 12; // ~71 bits of entropy — the slug IS the access gate.

export function newSlug(length = SLUG_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

/** owner_key / edit_key: same shape as slugs, longer. */
export function newSecret(): string {
  return newSlug(20);
}

export function artifactUrl(slug: string): string {
  return `${process.env.SITE_URL || "https://codecast.sh"}/a/${slug}`;
}

// ---------------------------------------------------------------------------
// Line diff (for the ?diff=A..B page). Common prefix/suffix trim + LCS over
// the middle, hard-capped so a pathological pair can't blow the action budget.
// ---------------------------------------------------------------------------

export type DiffOp = { t: "eq" | "add" | "del"; line: string };

const DIFF_MAX_LINES = 3000;

export function lineDiff(aText: string, bText: string): { ops: DiffOp[]; truncated: boolean } {
  let a = aText.split("\n");
  let b = bText.split("\n");
  let truncated = false;
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    a = a.slice(0, DIFF_MAX_LINES);
    b = b.slice(0, DIFF_MAX_LINES);
    truncated = true;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // LCS table over the middle segment only.
  const n = midA.length;
  const m = midB.length;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: "eq", line: a[i] });
  if (n * m > 4_000_000) {
    // Too dissimilar/large for LCS — degrade to wholesale replace.
    for (const line of midA) ops.push({ t: "del", line });
    for (const line of midB) ops.push({ t: "add", line });
  } else if (n || m) {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: "eq", line: midA[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: "del", line: midA[i] });
        i++;
      } else {
        ops.push({ t: "add", line: midB[j] });
        j++;
      }
    }
    while (i < n) ops.push({ t: "del", line: midA[i++] });
    while (j < m) ops.push({ t: "add", line: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: "eq", line: a[i] });
  return { ops, truncated };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

export function accessSummary(a: Doc<"artifacts">) {
  return {
    has_password: !!a.password_hash,
    email_gate: !!a.email_gate,
    expires_at: a.expires_at ?? null,
    edit_mode: a.edit_mode ?? "owner",
  };
}

function toCliRow(a: Doc<"artifacts">) {
  const url = artifactUrl(a.slug);
  return {
    slug: a.slug,
    title: a.title,
    source_path: a.source_path,
    size: a.size,
    version: a.version,
    kind: a.kind ?? "html",
    session_short_id: a.session_short_id ?? null,
    created_at: a.created_at,
    updated_at: a.updated_at,
    url,
    manage_url: a.owner_key ? `${url}#o=${a.owner_key}` : url,
    edit_url: a.edit_mode === "link" && a.edit_key ? `${url}#ed=${a.edit_key}` : null,
    ...accessSummary(a),
  };
}

// ---------------------------------------------------------------------------
// Internal queries used by the HTTP layer
// ---------------------------------------------------------------------------

// Pre-check for the publish HTTP action: it must resolve the user BEFORE
// storing the blob, so an unauthorized call never leaves an orphaned storage
// object behind.
export const verify = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    return result ? { user_id: result.userId } : null;
  },
});

export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    const stats = await ctx.db
      .query("artifact_stats")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .first();
    const comments = await ctx.db
      .query("artifact_comments")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    return {
      ...artifact,
      author_name: user?.name ?? null,
      views: stats?.view_count ?? 0,
      comment_count: comments.filter((c) => c.status === "open").length,
    };
  },
});

// The (user, source_path) row the publish action updates; lets the action know
// slug/owner_key/kind before it stores blobs (password hashing needs the slug).
export const byUserPath = internalQuery({
  args: { user_id: v.id("users"), source_path: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("artifacts")
      .withIndex("by_user_path", (q) => q.eq("user_id", args.user_id).eq("source_path", args.source_path))
      .first();
  },
});

export const slugTaken = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    return !!(await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", args.slug)).first());
  },
});

// Artifact + its superseded versions, for ?meta=1, ?v=N serving, and diff.
export const historyBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    const history = await ctx.db
      .query("artifact_versions")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    const stats = await ctx.db
      .query("artifact_stats")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .first();
    return {
      ...artifact,
      author_name: user?.name ?? null,
      views: stats?.view_count ?? 0,
      versions: [
        {
          version: artifact.version,
          title: artifact.title,
          size: artifact.size,
          published_at: artifact.updated_at,
          storage_id: artifact.storage_id,
          source_storage_id: artifact.source_storage_id,
          kind: artifact.kind ?? "html",
          edited_by: artifact.last_edited_by ?? null,
        },
        ...history
          .map((h) => ({
            version: h.version,
            title: h.title,
            size: h.size,
            published_at: h.published_at,
            storage_id: h.storage_id,
            source_storage_id: h.source_storage_id,
            kind: h.kind ?? artifact.kind ?? "html",
            edited_by: h.edited_by ?? null,
          }))
          .sort((a, b) => b.version - a.version),
      ],
    };
  },
});

export const assetByPath = internalQuery({
  args: { artifact_id: v.id("artifacts"), version: v.number(), path: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("artifact_assets")
      .withIndex("by_artifact_version", (q) =>
        q.eq("artifact_id", args.artifact_id).eq("version", args.version).eq("path", args.path),
      )
      .first();
  },
});

export const assetsForVersion = internalQuery({
  args: { artifact_id: v.id("artifacts"), version: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("artifact_assets")
      .withIndex("by_artifact_version", (q) => q.eq("artifact_id", args.artifact_id).eq("version", args.version))
      .collect();
  },
});

// Resolve the CLI-detected session ref to provenance fields at publish time.
export const resolveSessionRef = internalQuery({
  args: { ref: v.string(), user_id: v.id("users") },
  handler: async (ctx, args) => {
    try {
      const conversation = await findConversationByAnyRef(ctx, args.ref, args.user_id);
      if (!conversation) return null;
      return {
        short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7),
        conversation_id: conversation._id,
      };
    } catch {
      return null;
    }
  },
});

// Auth check for the link-edit flow: owner_key always may edit; edit_key only
// when edit_mode is "link". Same null for wrong key and missing artifact.
export const editTarget = internalQuery({
  args: { slug: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    if (!args.key) return null;
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const isOwner = !!artifact.owner_key && args.key === artifact.owner_key;
    const isEditor = artifact.edit_mode === "link" && !!artifact.edit_key && args.key === artifact.edit_key;
    if (!isOwner && !isEditor) return null;
    return { artifact, is_owner: isOwner };
  },
});

// Everything the owner's manage panel shows.
export const ownerPanel = internalQuery({
  args: { slug: v.string(), owner_key: v.string() },
  handler: async (ctx, args) => {
    if (!args.owner_key) return null;
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact || artifact.owner_key !== args.owner_key) return null;
    const stats = await ctx.db
      .query("artifact_stats")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .first();
    const viewers = await ctx.db
      .query("artifact_viewers")
      .withIndex("by_artifact_email", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    const comments = await ctx.db
      .query("artifact_comments")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    return {
      artifact_id: artifact._id,
      access: accessSummary(artifact),
      edit_url: artifact.edit_mode === "link" && artifact.edit_key ? `${artifactUrl(artifact.slug)}#ed=${artifact.edit_key}` : null,
      stats: { views: stats?.view_count ?? 0, last_viewed_at: stats?.last_viewed_at ?? null },
      viewers: viewers
        .map((w) => ({ email: w.email, first_seen: w.first_seen, last_seen: w.last_seen, view_count: w.view_count }))
        .sort((a, b) => b.last_seen - a.last_seen),
      comments: comments
        .map((c) => ({
          id: c._id,
          author_name: c.author_name,
          author_email: c.author_email ?? null,
          text: c.text,
          anchor: c.anchor ?? null,
          version: c.version,
          status: c.status,
          created_at: c.created_at,
        }))
        .sort((a, b) => b.created_at - a.created_at),
    };
  },
});

// ---------------------------------------------------------------------------
// Version bookkeeping core, shared by publish / edit / rollback
// ---------------------------------------------------------------------------

const accessPatchValidator = v.object({
  // null = clear the gate; absent = leave unchanged. password arrives
  // PRE-HASHED (actions own crypto).
  password_hash: v.optional(v.union(v.string(), v.null())),
  email_gate: v.optional(v.boolean()),
  expires_at: v.optional(v.union(v.number(), v.null())),
  edit_mode: v.optional(v.string()),
  edit_key: v.optional(v.string()),
});

type AccessPatch = {
  password_hash?: string | null;
  email_gate?: boolean;
  expires_at?: number | null;
  edit_mode?: string;
  edit_key?: string;
};

function buildAccessPatch(set: AccessPatch): Partial<Doc<"artifacts">> {
  const patch: Record<string, unknown> = {};
  if (set.password_hash !== undefined) patch.password_hash = set.password_hash ?? undefined;
  if (set.email_gate !== undefined) patch.email_gate = set.email_gate || undefined;
  if (set.expires_at !== undefined) patch.expires_at = set.expires_at ?? undefined;
  if (set.edit_mode !== undefined) {
    patch.edit_mode = set.edit_mode === "owner" ? undefined : set.edit_mode;
    if (set.edit_key !== undefined) patch.edit_key = set.edit_key;
  }
  return patch as Partial<Doc<"artifacts">>;
}

const assetInputValidator = v.array(
  v.object({
    path: v.string(),
    storage_id: v.id("_storage"),
    content_type: v.string(),
    size: v.number(),
  }),
);

type AssetInput = { path: string; storage_id: Id<"_storage">; content_type: string; size: number }[];

/** Snapshot the artifact's current state into artifact_versions, patch it to
 * the new content, write the new version's asset rows, prune history past the
 * cap. The one path every version bump goes through. */
async function bumpVersion(
  ctx: MutationCtx,
  artifact: Doc<"artifacts">,
  next: {
    storage_id: Id<"_storage">;
    size: number;
    title: string;
    kind?: string;
    source_storage_id?: Id<"_storage">;
    content_hash?: string;
    session_short_id?: string;
    session_conversation_id?: Id<"conversations">;
    edited_by?: string;
    assets?: AssetInput;
    thumb_storage_id?: Id<"_storage">;
  },
): Promise<number> {
  const version = artifact.version + 1;
  await ctx.db.insert("artifact_versions", {
    artifact_id: artifact._id,
    version: artifact.version,
    title: artifact.title,
    storage_id: artifact.storage_id,
    size: artifact.size,
    published_at: artifact.updated_at,
    kind: artifact.kind,
    source_storage_id: artifact.source_storage_id,
    session_short_id: artifact.session_short_id,
    // Who created the version being snapshotted (set when it was published).
    edited_by: artifact.last_edited_by,
  });
  const patch: Record<string, unknown> = {
    storage_id: next.storage_id,
    title: next.title,
    size: next.size,
    version,
    content_hash: next.content_hash,
    source_storage_id: next.source_storage_id,
    // Editor attribution for the NEW current version; cleared on owner
    // publishes so a later snapshot doesn't misattribute.
    last_edited_by: next.edited_by,
    updated_at: Date.now(),
  };
  if (next.kind !== undefined) patch.kind = next.kind === "html" ? undefined : next.kind;
  if (next.session_short_id) {
    patch.session_short_id = next.session_short_id;
    patch.session_conversation_id = next.session_conversation_id;
  }
  if (next.thumb_storage_id) {
    if (artifact.thumb_storage_id) await ctx.storage.delete(artifact.thumb_storage_id).catch(() => {});
    patch.thumb_storage_id = next.thumb_storage_id;
  }
  await ctx.db.patch(artifact._id, patch as Partial<Doc<"artifacts">>);
  for (const asset of next.assets ?? []) {
    await ctx.db.insert("artifact_assets", {
      artifact_id: artifact._id,
      version,
      path: asset.path,
      storage_id: asset.storage_id,
      content_type: asset.content_type,
      size: asset.size,
    });
  }
  await pruneHistory(ctx, artifact._id);
  return version;
}

async function pruneHistory(ctx: MutationCtx, artifactId: Id<"artifacts">): Promise<void> {
  const history = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact", (q) => q.eq("artifact_id", artifactId))
    .collect();
  const excess = history.slice(0, Math.max(0, history.length - MAX_ARTIFACT_HISTORY));
  for (const old of excess) {
    await deleteVersionRow(ctx, old);
  }
}

async function deleteVersionRow(ctx: MutationCtx, row: Doc<"artifact_versions">): Promise<void> {
  await ctx.storage.delete(row.storage_id).catch(() => {});
  if (row.source_storage_id) await ctx.storage.delete(row.source_storage_id).catch(() => {});
  const assets = await ctx.db
    .query("artifact_assets")
    .withIndex("by_artifact_version", (q) => q.eq("artifact_id", row.artifact_id).eq("version", row.version))
    .collect();
  for (const asset of assets) {
    await ctx.storage.delete(asset.storage_id).catch(() => {});
    await ctx.db.delete(asset._id);
  }
  await ctx.db.delete(row._id);
}

/** Delete blobs the caller stored for a publish that turned out to be a no-op
 * (or a failed create). */
async function deleteIncomingBlobs(
  ctx: MutationCtx,
  next: { storage_id: Id<"_storage">; source_storage_id?: Id<"_storage">; assets?: AssetInput; thumb_storage_id?: Id<"_storage"> },
): Promise<void> {
  await ctx.storage.delete(next.storage_id).catch(() => {});
  if (next.source_storage_id) await ctx.storage.delete(next.source_storage_id).catch(() => {});
  if (next.thumb_storage_id) await ctx.storage.delete(next.thumb_storage_id).catch(() => {});
  for (const asset of next.assets ?? []) await ctx.storage.delete(asset.storage_id).catch(() => {});
}

// ---------------------------------------------------------------------------
// Publish / edit / rollback mutations (called by artifactsHttp actions, which
// own blob storage and crypto)
// ---------------------------------------------------------------------------

export const upsertFromPublish = internalMutation({
  args: {
    user_id: v.id("users"),
    storage_id: v.id("_storage"),
    title: v.string(),
    size: v.number(),
    source_path: v.optional(v.string()),
    force_new: v.optional(v.boolean()),
    content_hash: v.optional(v.string()),
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    session_short_id: v.optional(v.string()),
    session_conversation_id: v.optional(v.id("conversations")),
    // Pre-minted by the action so it can hash passwords against the slug
    // before any db write. Used only when creating.
    slug: v.optional(v.string()),
    owner_key: v.optional(v.string()),
    access: v.optional(accessPatchValidator),
    assets: v.optional(assetInputValidator),
    thumb_storage_id: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const existing =
      !args.force_new && args.source_path
        ? await ctx.db
            .query("artifacts")
            .withIndex("by_user_path", (q) =>
              q.eq("user_id", args.user_id).eq("source_path", args.source_path),
            )
            .first()
        : null;

    const now = Date.now();

    if (existing) {
      const accessPatch = args.access ? buildAccessPatch(args.access) : {};
      // Identical bytes → no version bump: drop the freshly stored blobs, but
      // still apply access changes and provenance so `--password x` on an
      // unchanged file works.
      if (args.content_hash && existing.content_hash === args.content_hash) {
        await deleteIncomingBlobs(ctx, args);
        if (Object.keys(accessPatch).length) await ctx.db.patch(existing._id, accessPatch);
        const fresh = (await ctx.db.get(existing._id))!;
        return {
          slug: fresh.slug,
          url: artifactUrl(fresh.slug),
          version: fresh.version,
          updated: true,
          unchanged: true,
          owner_key: fresh.owner_key ?? null,
          edit_url: fresh.edit_mode === "link" && fresh.edit_key ? `${artifactUrl(fresh.slug)}#ed=${fresh.edit_key}` : null,
        };
      }

      if (Object.keys(accessPatch).length) await ctx.db.patch(existing._id, accessPatch);
      const base = (await ctx.db.get(existing._id))!;
      const version = await bumpVersion(ctx, base, {
        storage_id: args.storage_id,
        size: args.size,
        title: args.title,
        kind: args.kind,
        source_storage_id: args.source_storage_id,
        content_hash: args.content_hash,
        session_short_id: args.session_short_id,
        session_conversation_id: args.session_conversation_id,
        assets: args.assets,
        thumb_storage_id: args.thumb_storage_id,
      });
      const fresh = (await ctx.db.get(existing._id))!;
      return {
        slug: fresh.slug,
        url: artifactUrl(fresh.slug),
        version,
        updated: true,
        owner_key: fresh.owner_key ?? null,
        edit_url: fresh.edit_mode === "link" && fresh.edit_key ? `${artifactUrl(fresh.slug)}#ed=${fresh.edit_key}` : null,
      };
    }

    // Create. The action pre-mints slug/owner_key (it needed them for
    // hashing); fall back to minting here for direct callers.
    let slug = args.slug ?? newSlug();
    while (await ctx.db.query("artifacts").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) {
      slug = newSlug();
    }
    const ownerKey = args.owner_key ?? newSecret();
    const accessPatch = args.access ? buildAccessPatch(args.access) : {};

    const id = await ctx.db.insert("artifacts", {
      slug,
      user_id: args.user_id,
      title: args.title,
      source_path: args.source_path,
      storage_id: args.storage_id,
      size: args.size,
      version: 1,
      content_hash: args.content_hash,
      kind: args.kind === "html" ? undefined : args.kind,
      source_storage_id: args.source_storage_id,
      session_short_id: args.session_short_id,
      session_conversation_id: args.session_conversation_id,
      owner_key: ownerKey,
      thumb_storage_id: args.thumb_storage_id,
      created_at: now,
      updated_at: now,
      ...accessPatch,
    });
    for (const asset of args.assets ?? []) {
      await ctx.db.insert("artifact_assets", {
        artifact_id: id,
        version: 1,
        path: asset.path,
        storage_id: asset.storage_id,
        content_type: asset.content_type,
        size: asset.size,
      });
    }
    const fresh = (await ctx.db.get(id))!;
    return {
      slug,
      url: artifactUrl(slug),
      version: 1,
      updated: false,
      owner_key: ownerKey,
      edit_url: fresh.edit_mode === "link" && fresh.edit_key ? `${artifactUrl(slug)}#ed=${fresh.edit_key}` : null,
    };
  },
});

// A new version whose blobs were prepared by an action (link-edit save, or a
// rollback's blob copies). Auth happened in the action.
export const appendVersion = internalMutation({
  args: {
    artifact_id: v.id("artifacts"),
    storage_id: v.id("_storage"),
    size: v.number(),
    title: v.optional(v.string()),
    kind: v.optional(v.string()),
    source_storage_id: v.optional(v.id("_storage")),
    content_hash: v.optional(v.string()),
    edited_by: v.optional(v.string()),
    assets: v.optional(assetInputValidator),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db.get(args.artifact_id);
    if (!artifact) throw new Error("Artifact not found");
    const version = await bumpVersion(ctx, artifact, {
      storage_id: args.storage_id,
      size: args.size,
      title: args.title ?? artifact.title,
      kind: args.kind,
      source_storage_id: args.source_storage_id,
      content_hash: args.content_hash,
      edited_by: args.edited_by,
      assets: args.assets,
    });
    return { version };
  },
});

export const applyManage = internalMutation({
  args: {
    artifact_id: v.id("artifacts"),
    set: v.optional(
      v.object({
        title: v.optional(v.string()),
        password_hash: v.optional(v.union(v.string(), v.null())),
        email_gate: v.optional(v.boolean()),
        expires_at: v.optional(v.union(v.number(), v.null())),
        edit_mode: v.optional(v.string()),
        edit_key: v.optional(v.string()),
      }),
    ),
    resolve_comment_id: v.optional(v.id("artifact_comments")),
    delete_comment_id: v.optional(v.id("artifact_comments")),
  },
  handler: async (ctx, args) => {
    if (args.set) {
      const { title, ...access } = args.set;
      const patch: Record<string, unknown> = buildAccessPatch(access);
      if (title !== undefined) patch.title = title.slice(0, 200);
      if (Object.keys(patch).length) await ctx.db.patch(args.artifact_id, patch as Partial<Doc<"artifacts">>);
    }
    if (args.resolve_comment_id) {
      const c = await ctx.db.get(args.resolve_comment_id);
      if (c && c.artifact_id === args.artifact_id) await ctx.db.patch(c._id, { status: "resolved" });
    }
    if (args.delete_comment_id) {
      const c = await ctx.db.get(args.delete_comment_id);
      if (c && c.artifact_id === args.artifact_id) await ctx.db.delete(c._id);
    }
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Beacons and viewer-facing writes (public, slug-keyed)
// ---------------------------------------------------------------------------

export const recordView = mutation({
  args: { slug: v.string(), email: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return { ok: false };
    const now = Date.now();
    const stats = await ctx.db
      .query("artifact_stats")
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .first();
    if (stats) {
      await ctx.db.patch(stats._id, { view_count: stats.view_count + 1, last_viewed_at: now });
    } else {
      await ctx.db.insert("artifact_stats", { artifact_id: artifact._id, view_count: 1, last_viewed_at: now });
    }
    const email = args.email?.trim().toLowerCase();
    if (email && email.includes("@") && email.length <= 254) {
      const viewer = await ctx.db
        .query("artifact_viewers")
        .withIndex("by_artifact_email", (q) => q.eq("artifact_id", artifact._id).eq("email", email))
        .first();
      if (viewer) {
        await ctx.db.patch(viewer._id, { last_seen: now, view_count: viewer.view_count + 1 });
      } else {
        await ctx.db.insert("artifact_viewers", {
          artifact_id: artifact._id,
          email,
          first_seen: now,
          last_seen: now,
          view_count: 1,
        });
      }
    }
    return { ok: true };
  },
});

export const recordViewerEmail = internalMutation({
  args: { slug: v.string(), email: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return { ok: false };
    const email = args.email.trim().toLowerCase();
    if (!email.includes("@") || email.length > 254) return { ok: false };
    const now = Date.now();
    const viewer = await ctx.db
      .query("artifact_viewers")
      .withIndex("by_artifact_email", (q) => q.eq("artifact_id", artifact._id).eq("email", email))
      .first();
    if (!viewer) {
      await ctx.db.insert("artifact_viewers", {
        artifact_id: artifact._id,
        email,
        first_seen: now,
        last_seen: now,
        view_count: 0,
      });
    }
    return { ok: true };
  },
});

// One viewer's batch of comments → stored + delivered to the publishing
// session as a single message, sent under the artifact owner's identity.
export const submitComments = mutation({
  args: {
    slug: v.string(),
    author_name: v.string(),
    author_email: v.optional(v.string()),
    version: v.number(),
    comments: v.array(v.object({ text: v.string(), anchor: v.optional(v.string()) })),
  },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return { error: "Not found" };
    const list = args.comments
      .slice(0, MAX_COMMENT_BATCH)
      .map((c) => ({ text: c.text.trim().slice(0, MAX_COMMENT_CHARS), anchor: c.anchor?.slice(0, 2000) }))
      .filter((c) => c.text.length > 0);
    if (!list.length) return { error: "Empty comment batch" };
    const author = args.author_name.trim().slice(0, 80) || "anonymous";
    const email = args.author_email?.trim().toLowerCase().slice(0, 254);
    const now = Date.now();
    const batchId = newSlug(10);

    // Deliver first (as one message), then store rows stamped with the
    // outcome. A failed delivery still stores the comments — the owner sees
    // them in the manage panel.
    let delivered = false;
    if (artifact.session_conversation_id) {
      const anchorNote = (anchor?: string) => {
        if (!anchor) return "";
        try {
          const parsed = JSON.parse(anchor);
          if (parsed?.snippet) return `\n  ↳ on: "${String(parsed.snippet).slice(0, 120)}"`;
        } catch {
          /* opaque */
        }
        return "";
      };
      const lines = list.map((c, i) => `${list.length > 1 ? `${i + 1}. ` : ""}${c.text}${anchorNote(c.anchor)}`);
      const body = [
        `${list.length === 1 ? "A comment" : `${list.length} comments`} on your artifact "${artifact.title}" (v${args.version}) from ${author}${email ? ` <${email}>` : ""}:`,
        "",
        ...lines,
        "",
        artifactUrl(artifact.slug),
      ].join("\n");
      try {
        await performSessionSend(ctx, artifact.user_id, {
          to: artifact.session_conversation_id.toString(),
          body,
        });
        delivered = true;
      } catch {
        delivered = false;
      }
    }

    for (const c of list) {
      await ctx.db.insert("artifact_comments", {
        artifact_id: artifact._id,
        batch_id: batchId,
        author_name: author,
        author_email: email,
        text: c.text,
        anchor: c.anchor,
        version: args.version,
        status: "open",
        delivered,
        created_at: now,
      });
    }
    return { delivered, count: list.length };
  },
});

// ---------------------------------------------------------------------------
// CLI-facing list/delete (api_token auth)
// ---------------------------------------------------------------------------

export const listFromCLI = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_user", (q) => q.eq("user_id", auth.userId))
      .collect();
    rows.sort((a, b) => b.updated_at - a.updated_at);
    const out = [];
    for (const row of rows) {
      const stats = await ctx.db
        .query("artifact_stats")
        .withIndex("by_artifact", (q) => q.eq("artifact_id", row._id))
        .first();
      const comments = await ctx.db
        .query("artifact_comments")
        .withIndex("by_artifact", (q) => q.eq("artifact_id", row._id))
        .collect();
      out.push({
        ...toCliRow(row),
        views: stats?.view_count ?? 0,
        last_viewed_at: stats?.last_viewed_at ?? null,
        comments_open: comments.filter((c) => c.status === "open").length,
      });
    }
    return { artifacts: out };
  },
});

/** Find one artifact of this user by slug, exact path, or unambiguous path
 * suffix. Returns {match} or {error}. */
async function resolveTarget(
  ctx: { db: QueryCtx["db"] },
  userId: Id<"users">,
  target: string,
): Promise<{ match?: Doc<"artifacts">; error?: string }> {
  const bySlugMatch = await ctx.db
    .query("artifacts")
    .withIndex("by_slug", (q) => q.eq("slug", target))
    .first();
  if (bySlugMatch && bySlugMatch.user_id === userId) return { match: bySlugMatch };

  const mine = await ctx.db
    .query("artifacts")
    .withIndex("by_user", (q) => q.eq("user_id", userId))
    .collect();
  const suffix = target.startsWith("/") ? target : `/${target}`;
  const candidates = mine.filter((a) => a.source_path === target || a.source_path?.endsWith(suffix));
  if (candidates.length > 1) {
    const listing = candidates.map((a) => `  ${a.slug}  ${a.title}`).join("\n");
    return { error: `"${target}" matches ${candidates.length} artifacts — use a slug:\n${listing}` };
  }
  if (!candidates.length) return { error: `No artifact matches "${target}"` };
  return { match: candidates[0] };
}

export const resolveTargetForCLI = internalQuery({
  args: { api_token: v.string(), target: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const r = await resolveTarget(ctx, auth.userId, args.target);
    if (r.error) return { error: r.error };
    return { artifact: r.match };
  },
});

// `target` is a slug, an exact source path, or a path suffix (basename
// convenience: `cast publish rm report.html`).
export const deleteFromCLI = mutation({
  args: { api_token: v.string(), target: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) return { error: "Unauthorized" };
    const r = await resolveTarget(ctx, auth.userId, args.target);
    if (r.error || !r.match) return { error: r.error ?? `No artifact matches "${args.target}"` };
    const match = r.match;
    await deleteArtifactCascade(ctx, match);
    return { deleted: toCliRow(match) };
  },
});

async function deleteArtifactCascade(ctx: MutationCtx, artifact: Doc<"artifacts">): Promise<void> {
  const history = await ctx.db
    .query("artifact_versions")
    .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
    .collect();
  for (const row of history) await deleteVersionRow(ctx, row);
  // Current version's assets (deleteVersionRow only touched snapshot versions).
  const assets = await ctx.db
    .query("artifact_assets")
    .withIndex("by_artifact_version", (q) => q.eq("artifact_id", artifact._id))
    .collect();
  for (const asset of assets) {
    await ctx.storage.delete(asset.storage_id).catch(() => {});
    await ctx.db.delete(asset._id);
  }
  for (const table of ["artifact_comments", "artifact_stats"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_artifact", (q) => q.eq("artifact_id", artifact._id))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  const viewers = await ctx.db
    .query("artifact_viewers")
    .withIndex("by_artifact_email", (q) => q.eq("artifact_id", artifact._id))
    .collect();
  for (const row of viewers) await ctx.db.delete(row._id);
  await ctx.storage.delete(artifact.storage_id).catch(() => {});
  if (artifact.source_storage_id) await ctx.storage.delete(artifact.source_storage_id).catch(() => {});
  if (artifact.thumb_storage_id) await ctx.storage.delete(artifact.thumb_storage_id).catch(() => {});
  await ctx.db.delete(artifact._id);
}

// ---------------------------------------------------------------------------
// Web app (authed user) — the gallery. The WEB track extends these.
// ---------------------------------------------------------------------------

export const listForWeb = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { artifacts: [] };
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    rows.sort((a, b) => b.updated_at - a.updated_at);
    const out = [];
    for (const row of rows) {
      const stats = await ctx.db
        .query("artifact_stats")
        .withIndex("by_artifact", (q) => q.eq("artifact_id", row._id))
        .first();
      const comments = await ctx.db
        .query("artifact_comments")
        .withIndex("by_artifact", (q) => q.eq("artifact_id", row._id))
        .collect();
      out.push({
        ...toCliRow(row),
        has_thumb: !!row.thumb_storage_id,
        views: stats?.view_count ?? 0,
        last_viewed_at: stats?.last_viewed_at ?? null,
        comments_open: comments.filter((c) => c.status === "open").length,
      });
    }
    return { artifacts: out };
  },
});

// Viewer metadata for link unfurls and the (legacy) wrapper page. Exposes no
// more than the slug already grants.
export const getShared = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const artifact = await ctx.db
      .query("artifacts")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .first();
    if (!artifact) return null;
    const user = await ctx.db.get(artifact.user_id);
    return {
      slug: artifact.slug,
      title: artifact.title,
      size: artifact.size,
      version: artifact.version,
      kind: artifact.kind ?? "html",
      created_at: artifact.created_at,
      updated_at: artifact.updated_at,
      user: user ? { name: user.name, image: user.image } : null,
    };
  },
});
