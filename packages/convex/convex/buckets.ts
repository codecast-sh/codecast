import { query, mutation, type QueryCtx, type MutationCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { requireUser } from "./lib/auth";
import {
  advanceLocalViewRevision,
  readLocalViewRevision,
  runLocalCommand,
} from "./localFirstCommands";

export const BUCKETS_VIEW_CONTRACT_ID = "buckets.principal/v2";
export const BUCKETS_VIEW_KEY = "buckets:principal";

// Manual session buckets are "labels" in the UI: a personal catalog of names
// (inbox_buckets) plus exclusive per-(user, conversation) filing
// (bucket_assignments). Every read/write is scoped to the authenticated user.
//
// The WEB app mutates through dispatch (SIDE_EFFECTS.createBucket /
// assignSessionToBucket + applyPatches for field edits). The CLI authenticates by
// api_token instead, so it calls the cli* functions below. Both paths share the
// same write helpers (createBucketForUser / assignConversationToBucketForUser /
// resolveOrCreateBucket) so the two surfaces can never drift.
export const webList = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { buckets: [], assignments: [] };

    const buckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    // Assignments for archived buckets still sync — read-time filters decide
    // visibility, matching the delta-cache convention everywhere else.
    const assignments = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    return { buckets, assignments };
  },
});

// Versioned complete-view contract for the principal-scoped local materializer.
// Unlike the v1 array-shaped result, auth state and authoritative coverage are
// explicit and cannot be confused with a legitimate empty catalog.
export const webListV2 = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return {
        contractId: BUCKETS_VIEW_CONTRACT_ID,
        viewKey: BUCKETS_VIEW_KEY,
        access: "unauthenticated" as const,
      };
    }
    const [buckets, assignments, viewRevision] = await Promise.all([
      ctx.db
        .query("inbox_buckets")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect(),
      ctx.db
        .query("bucket_assignments")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect(),
      readLocalViewRevision(ctx, userId, BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY),
    ]);
    return {
      contractId: BUCKETS_VIEW_CONTRACT_ID,
      viewKey: BUCKETS_VIEW_KEY,
      access: "granted" as const,
      // Opaque within the already principal-scoped store; application code must
      // not inspect or synthesize this value.
      grantKeys: ["bucket-catalog"],
      viewRevision,
      buckets,
      assignments,
    };
  },
});

// Pure label-name → bucket match: exact (case-insensitive) wins, then
// substring; archived buckets are invisible. The error variant lists the
// caller's labels so a typo is self-correcting.
export function matchBucketByName<B extends { name: string; archived_at?: number }>(
  buckets: B[],
  label: string
): B | { error: string } {
  const active = buckets.filter((b) => !b.archived_at);
  const needle = label.trim().toLowerCase();
  const bucket =
    active.find((b) => b.name.toLowerCase() === needle) ??
    active.find((b) => b.name.toLowerCase().includes(needle));
  if (bucket) return bucket;
  const names = [...new Set(active.map((b) => b.name))].sort().join(", ");
  return {
    error: names
      ? `No label matching "${label}". Your labels: ${names}`
      : `No label matching "${label}" — you have no labels yet (create them in the web sessions panel)`,
  };
}

// Resolve a label (bucket) name to the set of conversation ids the user filed
// under it. Labels are per-user, so this is always "my" filing regardless of
// whose conversations the caller goes on to filter. Used by the CLI read
// surface (cast search/feed/sessions --label).
export async function resolveLabelConvIds(
  ctx: QueryCtx,
  userId: Id<"users">,
  label: string
): Promise<{ convIds: Set<string> } | { error: string }> {
  const buckets = await ctx.db
    .query("inbox_buckets")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const matched = matchBucketByName(buckets, label);
  if ("error" in matched) return matched;
  const assignments = await ctx.db
    .query("bucket_assignments")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  return {
    convIds: new Set(
      assignments
        .filter((a) => a.bucket_id === matched._id)
        .map((a) => a.conversation_id.toString())
    ),
  };
}

// ── Shared write helpers ──────────────────────────────────────────────────────
// Used by BOTH the web dispatch SIDE_EFFECTS and the CLI cli* functions so the
// two surfaces stay byte-for-byte identical. Each takes an already-resolved
// userId; the caller is responsible for authentication (getAuthUserId on web,
// verifyApiToken on the CLI).

// Create a label, appending it to the END of the user's order (the web "+" is
// where new labels are born). Never-ordered labels sort at 0, so max+1024 lands
// after both those and any explicitly drag-ordered ones.
export async function createBucketForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  opts: { name: string; color?: string }
): Promise<{ _id: Id<"inbox_buckets"> }> {
  const result = await createBucketRow(ctx, userId, opts);
  await advanceLocalViewRevision(ctx, userId, BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY);
  return result;
}

async function createBucketRow(
  ctx: MutationCtx,
  userId: Id<"users">,
  opts: { name: string; color?: string },
): Promise<{ _id: Id<"inbox_buckets"> }> {
  const name = (opts?.name || "").trim();
  if (!name) throw new Error("Label name required");
  const now = Date.now();
  const existing = await ctx.db
    .query("inbox_buckets")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const maxOrder = existing.reduce((m: number, b) => Math.max(m, b.sort_order ?? 0), 0);
  const _id = await ctx.db.insert("inbox_buckets", {
    user_id: userId,
    name,
    sort_order: maxOrder + 1024,
    ...(opts.color ? { color: opts.color } : {}),
    created_at: now,
    updated_at: now,
  });
  return { _id };
}

// Exact (case-insensitive) match among the user's ACTIVE labels — distinct from
// matchBucketByName's exact-then-substring lookup. Filing/creating by name must
// not fuzzy-match ("api" should never land on an existing "apiv2" label), so the
// resolve-or-create and rename/archive paths use exact matching.
export async function findActiveBucketByExactName<
  B extends { name: string; archived_at?: number }
>(buckets: B[], name: string): Promise<B | null> {
  const needle = name.trim().toLowerCase();
  return buckets.find((b) => !b.archived_at && b.name.toLowerCase() === needle) ?? null;
}

// Resolve a label by exact name, creating it if absent. Returns the bucket id
// plus whether it was freshly created (so callers can report "created label X").
export async function resolveOrCreateBucket(
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
  color?: string
): Promise<{ bucketId: Id<"inbox_buckets">; name: string; created: boolean }> {
  const trimmed = (name || "").trim();
  if (!trimmed) throw new Error("Label name required");
  const buckets = await ctx.db
    .query("inbox_buckets")
    .withIndex("by_user_id", (q) => q.eq("user_id", userId))
    .collect();
  const existing = await findActiveBucketByExactName(buckets, trimmed);
  if (existing) return { bucketId: existing._id, name: existing.name, created: false };
  const { _id } = await createBucketForUser(ctx, userId, { name: trimmed, color });
  return { bucketId: _id, name: trimmed, created: true };
}

// Exclusive per-user filing: upsert the single (user, conversation) row.
// bucketId null = unfile (tombstone row, never deleted — delta sync). The caller
// has already resolved & ownership-checked the conversation.
export async function assignConversationToBucketForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  convId: Id<"conversations">,
  bucketId: Id<"inbox_buckets"> | null
): Promise<void> {
  await assignConversationToBucketRow(ctx, userId, convId, bucketId);
  await advanceLocalViewRevision(ctx, userId, BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY);
}

async function assignConversationToBucketRow(
  ctx: MutationCtx,
  userId: Id<"users">,
  convId: Id<"conversations">,
  bucketId: Id<"inbox_buckets"> | null,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("bucket_assignments")
    .withIndex("by_user_conversation", (q) =>
      q.eq("user_id", userId).eq("conversation_id", convId))
    .first();
  if (existing) {
    await ctx.db.patch(existing._id, { bucket_id: bucketId ?? undefined, updated_at: now });
  } else {
    await ctx.db.insert("bucket_assignments", {
      user_id: userId,
      conversation_id: convId,
      ...(bucketId ? { bucket_id: bucketId } : {}),
      updated_at: now,
    });
  }
}

// ── V2 local-command surface ────────────────────────────────────────────────
// These handlers return durable receipts rather than asking the client to infer
// acknowledgment from a later value match. Domain rejection is data; auth
// failures still throw before any receipt lookup or write.

export const webCreateV2 = mutation({
  args: {
    command_id: v.string(),
    name: v.string(),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "buckets.create/v2",
      arguments: { name: args.name, color: args.color },
    }, async () => {
      if (!args.name.trim()) {
        return { status: "rejected", code: "INVALID_ARGUMENT", message: "Label name required" };
      }
      const created = await createBucketRow(ctx, userId, { name: args.name, color: args.color });
      return {
        status: "acknowledged",
        result: { bucketId: created._id },
        coverageViews: [{ contractId: BUCKETS_VIEW_CONTRACT_ID, viewKey: BUCKETS_VIEW_KEY }],
      };
    });
  },
});

export const webUpdateV2 = mutation({
  args: {
    command_id: v.string(),
    bucket_id: v.id("inbox_buckets"),
    name: v.optional(v.string()),
    color: v.optional(v.union(v.string(), v.null())),
    sort_order: v.optional(v.number()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const commandArgs = {
      bucketId: args.bucket_id,
      name: args.name,
      color: args.color,
      sortOrder: args.sort_order,
      archived: args.archived,
    };
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "buckets.update/v2",
      arguments: commandArgs,
    }, async () => {
      const bucket = await ctx.db.get(args.bucket_id);
      if (!bucket || String(bucket.user_id) !== String(userId)) {
        return { status: "rejected", code: "NOT_FOUND", message: "Label not found" };
      }
      if (args.name !== undefined && !args.name.trim()) {
        return { status: "rejected", code: "INVALID_ARGUMENT", message: "Label name required" };
      }
      const patch: Record<string, unknown> = { updated_at: Date.now() };
      if (args.name !== undefined) patch.name = args.name.trim();
      if (args.color !== undefined) patch.color = args.color ?? undefined;
      if (args.sort_order !== undefined) patch.sort_order = args.sort_order;
      if (args.archived !== undefined) patch.archived_at = args.archived ? Date.now() : undefined;
      if (Object.keys(patch).length === 1) {
        return { status: "rejected", code: "INVALID_ARGUMENT", message: "No label fields supplied" };
      }
      await ctx.db.patch(args.bucket_id, patch);
      return {
        status: "acknowledged",
        result: { bucketId: args.bucket_id },
        coverageViews: [{ contractId: BUCKETS_VIEW_CONTRACT_ID, viewKey: BUCKETS_VIEW_KEY }],
      };
    });
  },
});

export const webAssignV2 = mutation({
  args: {
    command_id: v.string(),
    conversation_id: v.id("conversations"),
    bucket_id: v.optional(v.id("inbox_buckets")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "buckets.assign/v2",
      arguments: { conversationId: args.conversation_id, bucketId: args.bucket_id },
    }, async () => {
      const conversation = await ctx.db.get(args.conversation_id);
      if (!conversation || String(conversation.user_id) !== String(userId)) {
        return { status: "rejected", code: "NOT_FOUND", message: "Conversation not found" };
      }
      if (args.bucket_id) {
        const bucket = await ctx.db.get(args.bucket_id);
        if (!bucket || String(bucket.user_id) !== String(userId) || bucket.archived_at) {
          return { status: "rejected", code: "NOT_FOUND", message: "Active label not found" };
        }
      }
      await assignConversationToBucketRow(
        ctx,
        userId,
        args.conversation_id,
        args.bucket_id ?? null,
      );
      return {
        status: "acknowledged",
        result: { conversationId: args.conversation_id, bucketId: args.bucket_id ?? null },
        coverageViews: [{ contractId: BUCKETS_VIEW_CONTRACT_ID, viewKey: BUCKETS_VIEW_KEY }],
      };
    });
  },
});

// ── CLI surface (api_token authenticated) ─────────────────────────────────────
// `cast label …`. Filing is personal, so every ref resolves own-only via
// findConversationByAnyRef (the same resolver `cast send` uses).

async function requireCliUser(ctx: QueryCtx | MutationCtx, apiToken: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, apiToken, false);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId;
}

// List the user's active labels with how many sessions are filed under each,
// shaped to feed the CLI's formatLabelsList (labels + counts.total = labeled sum,
// so it suppresses the "unlabeled" line a full inbox scan would compute).
export const cliListLabels = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const buckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const assignments = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const counts = new Map<string, number>();
    for (const a of assignments) {
      if (a.bucket_id) counts.set(a.bucket_id.toString(), (counts.get(a.bucket_id.toString()) ?? 0) + 1);
    }
    const labels = buckets
      .filter((b) => !b.archived_at)
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((b) => ({ name: b.name, count: counts.get(b._id.toString()) ?? 0, color: b.color ?? null }));
    const labeled = labels.reduce((n, l) => n + l.count, 0);
    return { labels, counts: { total: labeled } };
  },
});

// File a session under a label (creating the label if it doesn't exist yet).
export const cliSetLabel = mutation({
  args: { api_token: v.string(), session: v.string(), name: v.string(), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const conv = await findConversationByAnyRef(ctx, args.session, userId);
    if (!conv) throw new Error(`No session of yours found for "${args.session}"`);
    const label = await resolveOrCreateBucket(ctx, userId, args.name, args.color);
    await assignConversationToBucketForUser(ctx, userId, conv._id, label.bucketId);
    return {
      label: label.name,
      created_label: label.created,
      session_short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
    };
  },
});

// Unfile a session (clears whatever label it was under).
export const cliClearLabel = mutation({
  args: { api_token: v.string(), session: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const conv = await findConversationByAnyRef(ctx, args.session, userId);
    if (!conv) throw new Error(`No session of yours found for "${args.session}"`);
    const prior = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_conversation", (q) =>
        q.eq("user_id", userId).eq("conversation_id", conv._id))
      .first();
    let priorLabel: string | null = null;
    if (prior?.bucket_id) {
      const b = await ctx.db.get(prior.bucket_id);
      priorLabel = b?.name ?? null;
    }
    await assignConversationToBucketForUser(ctx, userId, conv._id, null);
    return {
      session_short_id: conv.short_id ?? conv._id.toString().slice(0, 7),
      prior_label: priorLabel,
    };
  },
});

// Create an empty label up front (idempotent on exact name).
export const cliCreateLabel = mutation({
  args: { api_token: v.string(), name: v.string(), color: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const label = await resolveOrCreateBucket(ctx, userId, args.name, args.color);
    return { label: label.name, created: label.created };
  },
});

// Rename a label (matches the existing one by name; the filed sessions follow it).
export const cliRenameLabel = mutation({
  args: { api_token: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const newName = (args.to || "").trim();
    if (!newName) throw new Error("New label name required");
    const buckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const matched = matchBucketByName(buckets, args.from);
    if ("error" in matched) throw new Error(matched.error);
    await ctx.db.patch(matched._id, { name: newName, updated_at: Date.now() });
    await advanceLocalViewRevision(ctx, userId, BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY);
    return { old: matched.name, new: newName };
  },
});

// Remove a label by archiving it (soft delete, matching the web). The label
// stops showing everywhere; existing filings become inert tombstones.
export const cliArchiveLabel = mutation({
  args: { api_token: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCliUser(ctx, args.api_token);
    const buckets = await ctx.db
      .query("inbox_buckets")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const matched = matchBucketByName(buckets, args.name);
    if ("error" in matched) throw new Error(matched.error);
    const assignments = await ctx.db
      .query("bucket_assignments")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const filed = assignments.filter((a) => a.bucket_id === matched._id).length;
    await ctx.db.patch(matched._id, { archived_at: Date.now(), updated_at: Date.now() });
    await advanceLocalViewRevision(ctx, userId, BUCKETS_VIEW_CONTRACT_ID, BUCKETS_VIEW_KEY);
    return { label: matched.name, filed_count: filed };
  },
});
