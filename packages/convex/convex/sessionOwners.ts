import { Id } from "./_generated/dataModel";
import { listedOwnerIds, starterOf, type OwnersFacts } from "@codecast/shared/contracts/sessionOwners";

// ── Owner-set primitives (session_owners join table) ─────────────────────────
// The join table is the canonical multi-owner store: the humans whose inboxes a
// session appears in. Every owner read and row write goes through these, and
// so does the denormalized conversations.owner_user_id cache (the primary
// owner), whose one writer is syncPrimaryOwnerCache below; setSessionOwnerRows
// and the owner mutations call it after they change rows. Kept in a
// leaf module (imports only Id and the pure shared owner rules) so both privacy.ts (access
// policy) and sessionOwnership.ts (assignment workflow) can use them without an
// import cycle.

async function ownerRows(ctx: { db: any }, conversationId: Id<"conversations">): Promise<any[]> {
  const rows = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  return rows.sort((a: any, b: any) => a.added_at - b.added_at);
}

// Owners of a session, oldest-first (the first-added still-present owner is the
// "primary" mirrored to conversations.owner_user_id).
export async function listSessionOwnerIds(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<Id<"users">[]> {
  return (await ownerRows(ctx, conversationId)).map((r: any) => r.user_id as Id<"users">);
}

export async function isSessionOwner(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<boolean> {
  return !!(await sessionOwnerRow(ctx, conversationId, userId));
}

// The user's own session_owners row for a conversation, or null.
export async function sessionOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<any | null> {
  return (await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first()) ?? null;
}

// The person who started this session: the original author if the session
// later moved machines, otherwise the current runner — but only if that
// account is a human. Bots cannot own, so a bot-run thread with no author
// has no starter.
export async function humanStarterUser(
  ctx: { db: any },
  conversation: { user_id: Id<"users">; author_user_id?: Id<"users"> },
): Promise<any | null> {
  const ids = [conversation.author_user_id, conversation.user_id].filter(Boolean) as Id<"users">[];
  const seen = new Set<string>();
  for (const id of ids) {
    const key = id.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const user = await ctx.db.get(id);
    if (user && !user.is_bot) return user;
  }
  return null;
}

export async function conversationHasHumanStarter(
  ctx: { db: any },
  conversation: { user_id: Id<"users">; author_user_id?: Id<"users"> },
): Promise<boolean> {
  return !!(await humanStarterUser(ctx, conversation));
}

// Add an owner if absent. Idempotent; returns true iff the assignee has a NEW
// handoff to hear about: a row was inserted, or someone ELSE handed an existing
// co-owner the session again with a note. That second case re-stamps the row
// (who, when, what note, unacknowledged) so the note is neither lost nor
// silent — a handoff message to a teammate who already co-owns the session is
// still a message. A bare re-add with no note stays a no-op.
export async function addSessionOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
  addedBy: Id<"users">,
  note?: string,
): Promise<boolean> {
  const existing = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first();
  if (existing) {
    if (!note || userId.toString() === addedBy.toString()) return false;
    await ctx.db.patch(existing._id, { added_by: addedBy, added_at: Date.now(), note, seen_at: undefined });
    return true;
  }
  await ctx.db.insert("session_owners", {
    conversation_id: conversationId,
    user_id: userId,
    added_by: addedBy,
    added_at: Date.now(),
    ...(note ? { note } : {}),
    // Self-claims are pre-acknowledged — the ping is for handoffs from others.
    ...(userId.toString() === addedBy.toString() ? { seen_at: Date.now() } : {}),
  });
  return true;
}

// Replying in an assigned thread IS the acknowledgment: stamp seen_at on the
// SENDER's own unacked handoff row so the "assigned to you" ping doesn't
// outlive their engagement. Only handoffs from someone ELSE carry a ping
// (self-claims are pre-acknowledged at insert), so the added_by check is just
// a guard against legacy rows. Idempotent no-op otherwise.
export async function ackAssignmentOnEngage(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<void> {
  const row = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first();
  if (row && !row.seen_at && row.added_by?.toString() !== userId.toString()) {
    await ctx.db.patch(row._id, { seen_at: Date.now() });
  }
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
  await settleDriver(ctx, conversationId);
  return true;
}

// conversations.owner_user_id is a denormalized cache of the PRIMARY owner:
// the person the session reports to, whom the org chart files it under.
// A reparent names that person (`preferred`, org-staffing.md S11: adding an
// owner re-homes the session under them); with no preference, or when the
// preferred person is not an owner, it is the first-added still-present
// owner. Recompute it from the canonical set after EVERY owner write so the
// two can never drift. This is the one place the cache is written — callers
// just add/remove rows and then call this.
export async function syncPrimaryOwnerCache(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  preferred?: Id<"users">,
): Promise<Id<"users"> | undefined> {
  const owners = await listSessionOwnerIds(ctx, conversationId);
  const primary = (preferred && owners.find((id) => id.toString() === preferred.toString())) || owners[0];
  await ctx.db.patch(conversationId, { owner_user_id: primary ?? undefined, owners_changed_at: Date.now() });
  return primary;
}

// A role's standing session is owned by whom the role reports to (org-staffing.md
// S28): reporting to a person IS being in their inbox, so a seat under a person
// has exactly that person as owner, and a seat under a role has none (it rides
// the parent lead's card through org_role_id). One writer, called wherever a
// role's parent is set: provisioning, a move, a retire's re-home and the backfill.
export async function stampSeatOwners(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  reportsTo: { kind: "user"; user_id: Id<"users"> } | { kind: "role"; role_id: any } | null | undefined,
  addedBy: Id<"users">,
): Promise<boolean> {
  const boss = reportsTo?.kind === "user" ? reportsTo.user_id : null;
  return setSessionOwnerRows(ctx, conversationId, boss ? [String(boss)] : [], addedBy);
}

// A session's owner set as one comparable value: the primary (the
// owner_user_id cache) first, the rest sorted. The org change log records it
// before and after a change so an undo can put the exact set back. A caller
// that already holds the conversation passes it, and it is not read again.
export async function ownerSetOf(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  loaded?: { owner_user_id?: unknown } | null,
): Promise<string[]> {
  const owners = (await listSessionOwnerIds(ctx, conversationId)).map(String);
  const conversation = loaded === undefined ? await ctx.db.get(conversationId) : loaded;
  const primary = String(conversation?.owner_user_id ?? "");
  return [...owners.filter((id) => id === primary), ...owners.filter((id) => id !== primary).sort()];
}

/** One owner row as the org change log keeps it, so an undo puts the row back
 *  as it was: who added it, when, and whether its owner had acknowledged it. */
export type OwnerRowSnapshot = { user_id: string; added_by: string; added_at: number; seen_at?: number; note?: string; released_from?: string };

export async function ownerRowsOf(ctx: { db: any }, conversationId: Id<"conversations">): Promise<OwnerRowSnapshot[]> {
  return (await ownerRows(ctx, conversationId)).map((r: any) => ({
    user_id: String(r.user_id),
    added_by: String(r.added_by),
    added_at: r.added_at,
    ...(r.seen_at ? { seen_at: r.seen_at } : {}),
    ...(r.note ? { note: r.note } : {}),
    ...(r.released_from ? { released_from: String(r.released_from) } : {}),
  }));
}

// Make the owner rows exactly `owners`, the first listed as primary. Returns
// true iff a row or the primary changed. Writes nothing for a set already in place.
//
// `restore` is an undo putting a set back: each owner that has to be re-added
// gets its recorded row back unchanged. One with no recorded row (a log entry
// written before rows were kept) comes back already acknowledged, because an
// undo returns a state and must never read as a fresh handoff from the person
// who clicked it.
export async function setSessionOwnerRows(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  owners: string[],
  addedBy: Id<"users">,
  restore?: OwnerRowSnapshot[],
): Promise<boolean> {
  const keep = new Set(owners);
  let changed = false;
  const before = await listSessionOwnerIds(ctx, conversationId);
  const present = new Set(before.map(String));
  // Adds before removes: a driver among the kept owners still owns it at every step.
  for (const id of owners) {
    if (!restore) {
      if (await addSessionOwnerRow(ctx, conversationId, id as Id<"users">, addedBy)) changed = true;
      continue;
    }
    if (present.has(id)) continue;
    const now = Date.now();
    const row = restore.find((r) => r.user_id === id) ?? { user_id: id, added_by: String(addedBy), added_at: now, seen_at: now };
    await ctx.db.insert("session_owners", { conversation_id: conversationId, ...row });
    changed = true;
  }
  for (const id of before) {
    if (!keep.has(String(id)) && await removeSessionOwnerRow(ctx, conversationId, id)) changed = true;
  }
  const primary = owners[0] as Id<"users"> | undefined;
  if (!changed && primary && String((await ctx.db.get(conversationId))?.owner_user_id ?? "") !== primary) changed = true;
  if (changed) await syncPrimaryOwnerCache(ctx, conversationId, primary);
  return changed;
}

// Put removed rows back exactly as they were: who added them, when, the
// note and the ack. A row already present stays as it is.
export async function restoreOwnerRows(ctx: { db: any }, conversationId: Id<"conversations">, rows: OwnerRowSnapshot[]): Promise<void> {
  const present = new Set((await listSessionOwnerIds(ctx, conversationId)).map(String));
  let changed = false;
  for (const r of rows) {
    if (present.has(r.user_id)) continue;
    await ctx.db.insert("session_owners", { conversation_id: conversationId, user_id: r.user_id as Id<"users">, added_by: r.added_by as Id<"users">, added_at: r.added_at, ...(r.seen_at ? { seen_at: r.seen_at } : {}), ...(r.note ? { note: r.note } : {}) });
    present.add(r.user_id);
    changed = true;
  }
  if (changed) await syncPrimaryOwnerCache(ctx, conversationId);
}

// A conversation's owner facts as the shared model reads them. The inbox row
// passes the owner rows it already read and its memoized doc reader.
export async function ownersFactsOf(
  ctx: { db: any },
  conversation: any,
  loaded: { rows?: Array<{ user_id: string; added_at: number }>; getDoc?: (id: any) => Promise<any> } = {},
): Promise<OwnersFacts> {
  const rows = (loaded.rows ?? await ownerRowsOf(ctx, conversation._id)).map((r) => ({ user_id: r.user_id, added_at: r.added_at }));
  const getDoc = loaded.getDoc ?? ((id: any) => ctx.db.get(id));
  const bots: string[] = [];
  for (const id of [conversation.author_user_id, conversation.user_id]) {
    if (id && (await getDoc(id))?.is_bot) bots.push(String(id));
  }
  return {
    rows,
    author_id: conversation.author_user_id ? String(conversation.author_user_id) : null,
    runner_id: String(conversation.user_id),
    bots,
    role_id: conversation.org_role_id ? String(conversation.org_role_id) : null,
    role_started: !!conversation.role_started,
    standing_role_id: conversation.standing_role_id ? String(conversation.standing_role_id) : null,
    driver_user_id: conversation.driver_user_id ? String(conversation.driver_user_id) : null,
    primary_id: conversation.owner_user_id ? String(conversation.owner_user_id) : null,
  };
}

/** The person who owns a session with no owner rows, by the starter rule
 *  (shared starterOf); null once it has rows. */
export async function rowlessStarterOf(ctx: { db: any }, conversation: any): Promise<string | null> {
  const facts = await ownersFactsOf(ctx, conversation);
  return facts.rows.length ? null : starterOf(facts);
}

/** Writes the row that starter (rowlessStarterOf, read before the move) owned
 *  the session by, once it moves to another account; nothing for null. */
export async function writeStarterRow(ctx: { db: any }, conversationId: Id<"conversations">, starter: string | null): Promise<void> {
  if (!starter) return;
  await addSessionOwnerRow(ctx, conversationId, starter as Id<"users">, starter as Id<"users">);
  await syncPrimaryOwnerCache(ctx, conversationId);
}

// ── The driver (shared driverOf) ─────────────────────────────────────────────
// Exactly one owner drives, and a person who drives owns the session: one of
// its rows, or its starter while it has none (shared listedOwnerIds). This is
// the one writer of conversations.driver_user_id. Every removal of an owner
// row (removeSessionOwnerRow) settles it, so a driver whose row went hands
// the wheel back to the role, else the primary owner. Returns whether the
// driver changed; callers that route decisions reroute on true.
export async function writeDriver(ctx: { db: any }, conversationId: Id<"conversations">, userId: string | null): Promise<boolean> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return false;
  const owns = userId ? listedOwnerIds(await ownersFactsOf(ctx, conversation)).includes(userId) : false;
  const next = owns ? userId : null;
  if (String(conversation.driver_user_id ?? "") === String(next ?? "")) return false;
  await ctx.db.patch(conversationId, { driver_user_id: (next ?? undefined) as Id<"users"> | undefined, driver_changed_at: Date.now() });
  return true;
}

/** Keep the driver an owner after the owners changed: cleared when they no longer own it. */
export async function settleDriver(ctx: { db: any }, conversationId: Id<"conversations">): Promise<boolean> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation?.driver_user_id) return false;
  return writeDriver(ctx, conversationId, String(conversation.driver_user_id));
}
