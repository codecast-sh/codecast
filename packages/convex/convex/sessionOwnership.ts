import { mutation, query, internalMutation, internalAction } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";
import {
  addSessionOwnerRow,
  removeSessionOwnerRow,
  listSessionOwnerIds,
  syncPrimaryOwnerCache,
} from "./sessionOwners";
import { notifySessionAssigned } from "./notifications";

// Session OWNERS — the humans whose inboxes a session appears in and who may
// reply into it from the web composer. This is ONE of a session's three
// independent ownership axes; the other two are user_id (the account that RUNS +
// bills it) and owner_device_id (the DEVICE its daemon runs on). Reassigning
// owners never moves the device, and reparenting the device never changes the
// owners.
//
// A session has a SET of owners (the session_owners join table) — it can sit in
// several teammates' inboxes at once, each independently addable/removable.
// conversations.owner_user_id is only a denormalized cache of the primary owner,
// resynced after every write (syncPrimaryOwnerCache).
//
// Ownership affects where a session SURFACES and who may steer it — the
// send/steer mechanics (pending_messages) are unchanged. Besides the explicit
// paths here, a cross-user send into an UNOWNED session auto-owns it onto the
// sender (performSessionSend).

type OwnerInfo = { user_id: string; name: string | null; email: string | null };

const toOwnerInfo = (u: any): OwnerInfo => ({
  user_id: u._id.toString(),
  name: u.name ?? null,
  email: u.email ?? null,
});

export type OwnerMutationResult = {
  ok: true;
  short_id: string;
  conversation_id: Id<"conversations">;
  owners: OwnerInfo[]; // the full resulting owner set
  added: Id<"users">[]; // newly added by this call — exactly who to notify
  removed: Id<"users">[];
};

// Runner-or-team, exactly cast send's access rule: the running account may
// (re)assign its own sessions, and any teammate may claim/reassign a session
// they can already see. A merely share-linked viewer may not.
async function resolveOwnableConversation(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<any> {
  const conversation = await findConversationByAnyRefWhere(ctx, sessionId, async (candidate) => {
    const access = await checkConversationAccess(ctx, authUserId, candidate);
    return access === "owner" || access === "team";
  });
  if (!conversation) {
    throw new Error(
      `No session found for "${sessionId}" (you can only set an owner on your own sessions or sessions shared with your team)`
    );
  }
  return conversation;
}

// Resolve one owner ref to a user doc: "me", then exact email, then exact name,
// then a UNIQUE substring — scripts pass exact emails; the looser tiers are for
// humans at the CLI.
async function resolveOwnerRef(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  ownerRef: string,
): Promise<any> {
  if (ownerRef.toLowerCase() === "me") return ctx.db.get(authUserId);

  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  if (!conversation.team_id) {
    throw new Error(`Session ${shortId} has no team — an owner must be a teammate. Use "me" to claim it yourself.`);
  }
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", conversation.team_id))
    .collect();
  const members = (
    await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))
  ).filter(Boolean) as any[];

  const needle = ownerRef.toLowerCase();
  let ownerUser =
    members.find((u) => (u.email || "").toLowerCase() === needle) ??
    members.find((u) => (u.name || "").toLowerCase() === needle) ??
    null;
  if (!ownerUser) {
    const fuzzy = members.filter(
      (u) => (u.name || "").toLowerCase().includes(needle) || (u.email || "").toLowerCase().includes(needle)
    );
    if (fuzzy.length === 1) ownerUser = fuzzy[0];
    else if (fuzzy.length > 1) {
      const names = fuzzy.map((u) => u.name || u.email).join(", ");
      throw new Error(`"${ownerRef}" matches multiple team members (${names}) — use an exact email`);
    }
  }
  if (!ownerUser) throw new Error(`No team member found matching "${ownerRef}"`);
  return ownerUser;
}

// Bots may CALL these mutations to park a session on a human (the Aivery flow),
// but may never BE an owner — ownership means "this human's inbox is
// responsible," and nobody reads a bot's inbox.
function assertHumanOwner(ownerUser: any): void {
  if (ownerUser.is_bot) {
    throw new Error(
      `${ownerUser.name || ownerUser.email || "That user"} is an agent account — sessions can only be owned by a human team member`
    );
  }
}

async function listOwnerInfos(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<OwnerInfo[]> {
  const ids = await listSessionOwnerIds(ctx, conversationId);
  const docs = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(Boolean) as any[];
  return docs.map(toOwnerInfo);
}

// ── Owner mutation bodies ────────────────────────────────────────────────────
// Factored out so tests can drive them with an explicit authUserId (mirrors
// performSessionSend). Deliberately db-ONLY: each returns the `added` set and
// the PUBLIC mutations below fire the "assigned to you" notification for it,
// which keeps ctx.scheduler out of here and these testable against a fake db.

// Replace the owner set wholesale (empty list = disown everyone). Backs the web
// multi-select, where the UI holds the full desired set.
export async function performSetSessionOwners(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owners: string[] },
): Promise<OwnerMutationResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);

  const desiredKeys = new Set<string>();
  const desired: any[] = [];
  for (const ref of args.owners) {
    const trimmed = ref.trim();
    if (!trimmed) continue;
    const user = await resolveOwnerRef(ctx, authUserId, conversation, trimmed);
    assertHumanOwner(user);
    const key = user._id.toString();
    if (desiredKeys.has(key)) continue;
    desiredKeys.add(key);
    desired.push(user);
  }

  const current = await listSessionOwnerIds(ctx, conversation._id);

  const added: Id<"users">[] = [];
  for (const user of desired) {
    if (await addSessionOwnerRow(ctx, conversation._id, user._id, authUserId)) added.push(user._id);
  }
  const removed: Id<"users">[] = [];
  for (const ownerId of current) {
    if (desiredKeys.has(ownerId.toString())) continue;
    if (await removeSessionOwnerRow(ctx, conversation._id, ownerId)) removed.push(ownerId);
  }

  await syncPrimaryOwnerCache(ctx, conversation._id);
  return {
    ok: true,
    short_id: shortId,
    conversation_id: conversation._id,
    owners: desired.map(toOwnerInfo),
    added,
    removed,
  };
}

// Add ONE owner without disturbing the others (`cast own`).
export async function performAddSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string },
): Promise<OwnerMutationResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);

  const user = await resolveOwnerRef(ctx, authUserId, conversation, args.owner);
  assertHumanOwner(user);

  const added: Id<"users">[] = [];
  if (await addSessionOwnerRow(ctx, conversation._id, user._id, authUserId)) added.push(user._id);
  await syncPrimaryOwnerCache(ctx, conversation._id);

  return {
    ok: true,
    short_id: shortId,
    conversation_id: conversation._id,
    owners: await listOwnerInfos(ctx, conversation._id),
    added,
    removed: [],
  };
}

// Remove ONE owner, leaving the rest (`cast disown`; defaults to self).
export async function performRemoveSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string },
): Promise<OwnerMutationResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);

  const user = await resolveOwnerRef(ctx, authUserId, conversation, args.owner);

  const removed: Id<"users">[] = [];
  if (await removeSessionOwnerRow(ctx, conversation._id, user._id)) removed.push(user._id);
  await syncPrimaryOwnerCache(ctx, conversation._id);

  return {
    ok: true,
    short_id: shortId,
    conversation_id: conversation._id,
    owners: await listOwnerInfos(ctx, conversation._id),
    added: [],
    removed,
  };
}

// Back-compat single-owner form: `owner` REPLACES the whole set; null disowns
// everyone. Kept so existing callers keep their exact shape.
export async function performSetSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string | null }
): Promise<{ ok: true; short_id: string; owner: OwnerInfo | null }> {
  const ownerRef = args.owner?.trim() ?? null;
  const result = await performSetSessionOwners(ctx, authUserId, {
    session_id: args.session_id,
    owners: ownerRef ? [ownerRef] : [],
  });
  return { ok: true, short_id: result.short_id, owner: result.owners[0] ?? null };
}

// Admin: flag a full agent member account (e.g. Mr Bot) as is_bot so the
// ownership guards apply to it. Anchor identities get the flag at creation;
// agent accounts that predate it (or are created by plain signup) need this
// one-off. Run via `npx convex run sessionOwnership:flagBotAccount '{"ref":"…"}'`.
// Idempotent; `ref` matches exact email, exact name, or unique substring.
export const flagBotAccount = internalMutation({
  args: { ref: v.string() },
  handler: async (ctx, args) => {
    const needle = args.ref.trim().toLowerCase();
    const users = await ctx.db.query("users").collect();
    const matches = users.filter(
      (u: any) =>
        (u.email || "").toLowerCase() === needle ||
        (u.name || "").toLowerCase() === needle ||
        (u.email || "").toLowerCase().includes(needle) ||
        (u.name || "").toLowerCase().includes(needle)
    );
    // Prefer exact hits so a substring can't shadow an exact match.
    const exact = matches.filter(
      (u: any) => (u.email || "").toLowerCase() === needle || (u.name || "").toLowerCase() === needle
    );
    const pool = exact.length > 0 ? exact : matches;
    if (pool.length !== 1) {
      const names = pool.map((u: any) => `${u.name ?? "?"} <${u.email ?? "?"}>`).join(", ");
      throw new Error(
        pool.length === 0
          ? `No user matching "${args.ref}"`
          : `"${args.ref}" matches multiple users (${names}) — use an exact email`
      );
    }
    const user = pool[0];
    if (!user.is_bot) await ctx.db.patch(user._id, { is_bot: true });
    return { user_id: user._id.toString(), name: user.name ?? null, email: user.email ?? null, already_flagged: !!user.is_bot };
  },
});

// ── Public mutations ─────────────────────────────────────────────────────────
// Each fires the "assigned to you" notification for whoever it NEWLY added —
// the piece that turns a silent reassignment into an actual handoff. Claiming a
// session for yourself never notifies you (notifySessionAssigned skips the actor).

async function requireAuth(ctx: any, apiToken?: string): Promise<Id<"users">> {
  const authUserId = await getAuthenticatedUserId(ctx, apiToken);
  if (!authUserId) throw new Error("Authentication failed: invalid token or session");
  return authUserId;
}

// Any session ref: short_id (jx…), Claude session UUID, or conversation _id.
const SESSION_REF = v.string();
// Team member email (exact, preferred for scripts) or name; "me" for the caller.
const OWNER_REF = v.string();

// Back-compat: `owner` REPLACES the owner set; null/absent disowns everyone.
export const setSessionOwner = mutation({
  args: {
    session_id: SESSION_REF,
    owner: v.optional(v.union(v.string(), v.null())),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const ownerRef = args.owner?.trim() ?? null;
    const result = await performSetSessionOwners(ctx, authUserId, {
      session_id: args.session_id,
      owners: ownerRef ? [ownerRef] : [],
    });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId);
    return { ok: true as const, short_id: result.short_id, owner: result.owners[0] ?? null };
  },
});

// Replace the whole owner set — backs the web multi-select.
export const setSessionOwners = mutation({
  args: {
    session_id: SESSION_REF,
    owners: v.array(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await performSetSessionOwners(ctx, authUserId, {
      session_id: args.session_id,
      owners: args.owners,
    });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId);
    return result;
  },
});

// Add one owner, leaving existing owners in place (`cast own`).
export const addSessionOwner = mutation({
  args: {
    session_id: SESSION_REF,
    owner: v.optional(OWNER_REF), // default: claim for the caller
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await performAddSessionOwner(ctx, authUserId, {
      session_id: args.session_id,
      owner: args.owner?.trim() || "me",
    });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId);
    return result;
  },
});

// Remove one owner, leaving the rest (`cast disown`).
export const removeSessionOwner = mutation({
  args: {
    session_id: SESSION_REF,
    owner: v.optional(OWNER_REF), // default: remove the caller
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    return performRemoveSessionOwner(ctx, authUserId, {
      session_id: args.session_id,
      owner: args.owner?.trim() || "me",
    });
  },
});

// The full owner SET for one session — the session panel's owner chips. Fetched
// on demand for a single session, so the inbox list never pays a per-row lookup.
export const listOwners = query({
  args: { session_id: SESSION_REF, api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
    return {
      short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7),
      conversation_id: conversation._id,
      owners: await listOwnerInfos(ctx, conversation._id),
    };
  },
});

// Seed the session_owners join table from the legacy single-owner_user_id field.
// This migration is LOAD-BEARING, not optional: the inbox's owner merge reads the
// join table only (there is no index on owner_user_id anymore), so a legacy owned
// session stays out of its owner's inbox until its row exists here. The other
// owner paths (notifications, auto-claim, access) union in the owner_user_id
// cache and are safe either way.
//
// Idempotent and re-runnable. Drive it with the action below — one call:
//   npx convex run sessionOwnership:runBackfillSessionOwners '{}'
export const backfillSessionOwners = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Each owned row costs an extra index lookup + insert on top of the page
    // read, so keep the page small — 1000 blows the per-transaction
    // system-operation budget once it reaches the (recent) owned rows.
    const numItems = args.batch ?? 400;
    const page = await ctx.db
      .query("conversations")
      .paginate({ cursor: args.cursor ?? null, numItems });

    let migrated = 0;
    for (const conv of page.page) {
      const ownerId = (conv as any).owner_user_id;
      if (!ownerId) continue;
      // Legacy provenance is unknown — attribute the assignment to the owner.
      if (await addSessionOwnerRow(ctx, conv._id, ownerId, ownerId)) migrated++;
    }

    return {
      done: page.isDone,
      cursor: page.continueCursor,
      scanned: page.page.length,
      migrated,
    };
  },
});

// One-shot driver for the backfill: loops the paginated mutation SERVER-SIDE
// until it's done, so the migration is a single call instead of hundreds of CLI
// round-trips (each `npx convex run` costs ~1.5s of startup, which dominates the
// actual work — and a mid-run failure in a shell loop loses the cursor).
//   npx convex run sessionOwnership:runBackfillSessionOwners '{}'
export const runBackfillSessionOwners = internalAction({
  args: { batch: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ pages: number; scanned: number; migrated: number }> => {
    const batch = args.batch ?? 400;
    let cursor: string | null = null;
    let pages = 0;
    let scanned = 0;
    let migrated = 0;

    for (;;) {
      const res: any = await ctx.runMutation(
        internal.sessionOwnership.backfillSessionOwners,
        { cursor, batch },
      );
      pages++;
      scanned += res.scanned ?? 0;
      migrated += res.migrated ?? 0;
      if (res.done) break;
      cursor = res.cursor;
      // Backstop: a cursor that stops advancing would otherwise spin forever.
      if (pages > 5000) throw new Error(`backfill did not converge after ${pages} pages`);
    }

    return { pages, scanned, migrated };
  },
});
