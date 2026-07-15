import { Id } from "./_generated/dataModel";

// ── Owner-set primitives (session_owners join table) ─────────────────────────
// The join table is the canonical multi-owner store — the humans whose inboxes a
// session appears in. These are the single choke points every owner reader/
// writer goes through. Kept in a dependency-free leaf module (imports only Id)
// so both privacy.ts (access policy) and sessionOwnership.ts (assignment
// workflow) can use them without an import cycle.
//
// The denormalized conversations.owner_user_id cache (the primary owner) is
// maintained by the owner mutations, not here, so callers stay uniform.

// Owners of a session, oldest-first (the first-added still-present owner is the
// "primary" mirrored to conversations.owner_user_id).
export async function listSessionOwnerIds(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<Id<"users">[]> {
  const rows = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  rows.sort((a: any, b: any) => a.added_at - b.added_at);
  return rows.map((r: any) => r.user_id as Id<"users">);
}

export async function isSessionOwner(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<boolean> {
  const row = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first();
  return !!row;
}

// Add an owner if absent. Idempotent; returns true iff a row was newly inserted.
export async function addSessionOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
  addedBy: Id<"users">,
): Promise<boolean> {
  if (await isSessionOwner(ctx, conversationId, userId)) return false;
  await ctx.db.insert("session_owners", {
    conversation_id: conversationId,
    user_id: userId,
    added_by: addedBy,
    added_at: Date.now(),
  });
  return true;
}

// Remove an owner if present. Returns true iff a row was deleted.
export async function removeSessionOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<boolean> {
  const existing = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first();
  if (!existing) return false;
  await ctx.db.delete(existing._id);
  return true;
}

// conversations.owner_user_id is a denormalized cache of the PRIMARY
// (first-added, still-present) owner. Recompute it from the canonical set after
// EVERY owner write so the two can never drift. This is the one place the cache
// is written — callers just add/remove rows and then call this.
export async function syncPrimaryOwnerCache(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<Id<"users"> | undefined> {
  const owners = await listSessionOwnerIds(ctx, conversationId);
  const primary = owners[0];
  await ctx.db.patch(conversationId, { owner_user_id: primary ?? undefined });
  return primary;
}
