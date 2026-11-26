import { Id } from "./_generated/dataModel";
import { dropViewerTriage, mayBeTeamOwned, viewerTriageFor, viewerTriageMap } from "./lib/viewerTriage";
import { ownersOf, parentLinkOf, type SessionOwnerFacts } from "@codecast/shared/contracts/sessionOwners";
import { workspaceHasFeature } from "./lib/teamFeatureGuard";
import { roleManagers, type OrgPartyRef } from "@codecast/shared/contracts/orgLead";

// ── Owner-set primitives (session_owners join table) ─────────────────────────
// The join table is the canonical multi-owner store: the humans whose inboxes a
// session appears in. Every owner read and row write goes through these, and
// so does the denormalized conversations.owner_user_id cache (the primary
// owner), whose one writer is syncPrimaryOwnerCache below; setSessionOwnerRows
// and the owner mutations call it after they change rows. Kept in a
// dependency-free leaf module (imports only Id) so both privacy.ts (access
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

// Whether `userId` owns the session: a person row, or membership in a team
// that owns it (session_team_owners).
export async function isSessionOwner(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
  // The conversation, when the caller holds it: skips the team read for a
  // session no team owns.
  conversation?: any,
): Promise<boolean> {
  return !!(await sessionOwnerRow(ctx, conversationId, userId, conversation));
}

// The user's own owner row for a conversation, or null. A member of an owning
// team gets that team's row read as theirs: who shared it, when, with what
// note, already acknowledged (one teammate's ack cannot be stored per person
// on a team row, so a team share notifies once and draws no banner), and the
// team it came through. Read-only: callers that write acks query
// session_owners themselves.
export async function sessionOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
  conversation?: any,
): Promise<any | null> {
  const own = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation_user", (q: any) =>
      q.eq("conversation_id", conversationId).eq("user_id", userId))
    .first();
  if (own) return own;
  if (conversation && !mayBeTeamOwned(conversation)) return null;
  const team = await teamOwnerRowFor(ctx, conversationId, userId);
  if (!team) return null;
  return {
    conversation_id: conversationId,
    user_id: userId,
    added_by: team.added_by,
    added_at: team.added_at,
    seen_at: team.added_at,
    ...(team.note ? { note: team.note } : {}),
    team_id: team.team_id,
    // This person's own dismiss, stash, snooze and pin (lib/viewerTriage).
    triage: await viewerTriageFor(ctx, userId, conversationId),
  };
}

// ── Team owners (session_team_owners) ────────────────────────────────────────

async function teamOwnerRows(ctx: { db: any }, conversationId: Id<"conversations">): Promise<any[]> {
  const rows = await ctx.db
    .query("session_team_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  return rows.sort((a: any, b: any) => a.added_at - b.added_at);
}

// The teams that own a session, oldest-first.
export async function listSessionTeamOwnerIds(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<Id<"teams">[]> {
  return (await teamOwnerRows(ctx, conversationId)).map((r: any) => r.team_id as Id<"teams">);
}

// The owning team row `userId` belongs to, or null. An agent account owns
// nothing a team owns.
async function teamOwnerRowFor(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  userId: Id<"users">,
): Promise<any | null> {
  const rows = await teamOwnerRows(ctx, conversationId);
  if (rows.length === 0) return null;
  if ((await ctx.db.get(userId))?.is_bot) return null;
  for (const row of rows) {
    const member = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", row.team_id))
      .first();
    if (member) return row;
  }
  return null;
}

// The people on a team: members who are not agent accounts.
export async function teamPeopleIds(ctx: { db: any }, teamId: Id<"teams">): Promise<Id<"users">[]> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  const users = await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)));
  return users.filter((u: any) => u && !u.is_bot).map((u: any) => u._id as Id<"users">);
}

// Everyone who owns a session as a person: the person owners first, then the
// people of each owning team. This is who hears about the session and who is
// asked its questions; listSessionOwnerIds stays the person rows alone, the set
// the owner writes diff and the primary-owner cache reads.
export async function listSessionPartyIds(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<Id<"users">[]> {
  const out = await listSessionOwnerIds(ctx, conversationId);
  const seen = new Set(out.map(String));
  for (const teamId of await listSessionTeamOwnerIds(ctx, conversationId)) {
    for (const id of await teamPeopleIds(ctx, teamId)) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      out.push(id);
    }
  }
  return out;
}

// Make `teamId` an owner of the session. Returns true iff a row was inserted.
export async function addSessionTeamOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  teamId: Id<"teams">,
  addedBy: Id<"users">,
  note?: string,
): Promise<boolean> {
  const rows = await teamOwnerRows(ctx, conversationId);
  if (rows.some((r: any) => String(r.team_id) === String(teamId))) return false;
  // One team owns a session at a time: a session moved to another team and
  // made a team session again belongs to the new team only.
  for (const r of rows) await ctx.db.delete(r._id);
  await ctx.db.insert("session_team_owners", {
    conversation_id: conversationId,
    team_id: teamId,
    added_by: addedBy,
    added_at: Date.now(),
    ...(note ? { note } : {}),
  });
  await ctx.db.patch(conversationId, { team_owner_team_id: teamId });
  return true;
}

// Stop `teamId` owning the session. Returns true iff a row was deleted.
export async function removeSessionTeamOwnerRow(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  teamId: Id<"teams">,
): Promise<boolean> {
  const existing = (await teamOwnerRows(ctx, conversationId)).find((r: any) => String(r.team_id) === String(teamId));
  if (!existing) return false;
  await ctx.db.delete(existing._id);
  const left = await teamOwnerRows(ctx, conversationId);
  await ctx.db.patch(conversationId, { team_owner_team_id: left[0]?.team_id ?? undefined });
  // No team owns it any more: each person's own triage of it goes too.
  if (left.length === 0) await dropViewerTriage(ctx, conversationId);
  return true;
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

// A peer (a session another one only spawned) has no parent to own it, so it
// needs an owner of its own. Under the owners model, one a bot-run session
// spawned has no human by its own fields, so it takes its spawner's: the
// spawner's people (its implicit starter included) get owner rows, or, when a
// role alone owns the spawner (a role's standing session or hand), the peer
// is that role's start. Otherwise it would be in nobody's inbox. Returns
// whether it wrote anything.
export async function ownPeerByItsSpawnersHuman(
  ctx: { db: any },
  child: { _id: Id<"conversations">; user_id: Id<"users">; author_user_id?: Id<"users">; team_id?: Id<"teams">; org_role_id?: unknown; parent_conversation_id?: unknown },
  spawner: any | null,
): Promise<boolean> {
  if (!spawner || child.parent_conversation_id || child.org_role_id || (await humanStarterUser(ctx, child)) || !(await ownersModelOn(ctx, child))) return false;
  // A spawner that is itself a worker has only its parent session: climb to
  // the first session in the chain with people or a role.
  let at = spawner;
  for (let hops = 0; at && hops < PEER_OWNER_HOPS; hops++) {
    const owners = ownersOf(await sessionOwnerFactsOf(ctx, at));
    const people = owners.people.length ? owners.people : owners.implicitStarter ? [owners.implicitStarter] : [];
    if (people.length) {
      for (const id of people) await addSessionOwnerRow(ctx, child._id, id as Id<"users">, id as Id<"users">);
      await syncPrimaryOwnerCache(ctx, child._id);
      return true;
    }
    if (owners.role) {
      // A role is filed only in its own team: a peer elsewhere stays unowned
      // and its waits reach the fallback person.
      if (String(at.team_id ?? "") !== String(child.team_id ?? "")) return false;
      await ctx.db.patch(child._id, { org_role_id: owners.role, org_role_hold: "filed", role_started: true, owners_changed_at: Date.now() });
      return true;
    }
    at = owners.parentSession ? await ctx.db.get(owners.parentSession) : null;
  }
  return false;
}
const PEER_OWNER_HOPS = 8;

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
  // The team and people never own a session together: a person is added to a
  // team session only after the team row comes off (the owners menu's Take
  // ownership). Every other writer (undo, a role seat, the creator, a
  // migration) leaves a team session the team's.
  if ((await teamOwnerRows(ctx, conversationId)).length > 0) return false;
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
  const stamp = await ownersModelOn(ctx, await ctx.db.get(conversationId)) ? { owners_changed_at: Date.now() } : {};
  await ctx.db.patch(conversationId, { owner_user_id: primary ?? undefined, ...stamp });
  return primary;
}

// The session_owners team feature as shared contracts/sessionOwners
// ownersModelOn reads it: the session's own team's flag, or for a personal
// session any team of the account that runs it (workspaceHasFeature's
// personal rule, the same one). Off is the owner model before it.
export async function ownersModelOn(ctx: { db: any }, conversation: { team_id?: Id<"teams">; user_id?: Id<"users"> } | null | undefined): Promise<boolean> {
  if (!conversation) return false;
  return workspaceHasFeature(ctx, { team_id: conversation.team_id, user_id: conversation.user_id }, "session_owners");
}

// When a session's parent stopped owning it without anyone releasing it: the
// parent was deleted (0) or killed (its kill time). A parent that cannot
// answer is a released one, so the child falls back to its people or its
// starter and is never left in nobody's inbox.
export async function deadParentAt(ctx: { db: any }, conversation: any): Promise<number | null> {
  const link = parentLinkOf(conversation);
  if (!link) return null;
  const parent = await ctx.db.get(link);
  if (!parent) return 0;
  return parent.inbox_killed_at ?? null;
}

// A session's facts as the shared owner rule reads them.
export async function sessionOwnerFactsOf(ctx: { db: any }, conversation: any): Promise<SessionOwnerFacts> {
  const rows = (await ownerRows(ctx, conversation._id)).map((r: any) => ({ user_id: String(r.user_id), added_at: r.added_at }));
  const starter = await humanStarterUser(ctx, conversation);
  return {
    conversation_id: conversation._id,
    rows,
    starter: starter ? String(starter._id) : null,
    user_id: conversation.user_id,
    org_role_id: conversation.org_role_id,
    parent_conversation_id: conversation.parent_conversation_id,
    parent_released_at: conversation.parent_released_at ?? await deadParentAt(ctx, conversation),
    role_started: conversation.role_started ?? null,
  };
}

// A role's standing session is owned by whom the role reports to (org-staffing.md
// S28): reporting to a person IS being in their inbox, so a seat has every
// person among the role's managers as an owner (org-people.md P3), and a seat
// under roles only has none (it rides the parent lead's card through
// org_role_id). One writer, called wherever a role's managers are set:
// provisioning, a move, a retire's re-home and the backfill.
export async function stampSeatOwners(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  role: { reports_to?: OrgPartyRef | null; also_reports_to?: OrgPartyRef[] | null } | null | undefined,
  addedBy: Id<"users">,
): Promise<boolean> {
  const bosses = role ? roleManagers(role).flatMap((p) => (p.kind === "user" ? [String(p.user_id)] : [])) : [];
  return setSessionOwnerRows(ctx, conversationId, bosses, addedBy);
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
  // A team owner reads as `team:<id>`, so an undo puts a team session back.
  const teams = (await listSessionTeamOwnerIds(ctx, conversationId)).map((id) => `team:${String(id)}`);
  return [...owners.filter((id) => id === primary), ...owners.filter((id) => id !== primary).sort(), ...teams];
}

/** One owner row as the org change log keeps it, so an undo puts the row back
 *  as it was: who added it, when, and whether its owner had acknowledged it. */
export type OwnerRowSnapshot = { user_id: string; added_by: string; added_at: number; seen_at?: number; note?: string };

export async function ownerRowsOf(ctx: { db: any }, conversationId: Id<"conversations">): Promise<OwnerRowSnapshot[]> {
  return (await ownerRows(ctx, conversationId)).map((r: any) => ({
    user_id: String(r.user_id),
    added_by: String(r.added_by),
    added_at: r.added_at,
    ...(r.seen_at ? { seen_at: r.seen_at } : {}),
    ...(r.note ? { note: r.note } : {}),
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
  // Only an undo putting a recorded set back replaces a team owner; every
  // other writer leaves a team session the team's (see addSessionOwnerRow).
  opts: { replaceTeam?: boolean } = {},
): Promise<boolean> {
  const teamRefs = owners.filter((o) => o.startsWith("team:"));
  if (teamRefs.length > 0) {
    // A recorded team session: its people come off and its team goes back.
    let changed = false;
    for (const id of await listSessionOwnerIds(ctx, conversationId)) if (await removeSessionOwnerRow(ctx, conversationId, id)) changed = true;
    for (const ref of teamRefs) if (await addSessionTeamOwnerRow(ctx, conversationId, ref.slice(5) as Id<"teams">, addedBy)) changed = true;
    if (changed) await syncPrimaryOwnerCache(ctx, conversationId);
    return changed;
  }
  const teamRows = await teamOwnerRows(ctx, conversationId);
  if (teamRows.length > 0) {
    if (!opts.replaceTeam) return false;
    for (const r of teamRows) await removeSessionTeamOwnerRow(ctx, conversationId, r.team_id);
  }
  const keep = new Set(owners);
  let changed = false;
  const present = new Set<string>();
  for (const id of await listSessionOwnerIds(ctx, conversationId)) {
    present.add(String(id));
    if (!keep.has(String(id)) && await removeSessionOwnerRow(ctx, conversationId, id)) changed = true;
  }
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
  const primary = owners[0] as Id<"users"> | undefined;
  if (!changed && primary && String((await ctx.db.get(conversationId))?.owner_user_id ?? "") !== primary) changed = true;
  if (changed) await syncPrimaryOwnerCache(ctx, conversationId, primary);
  return changed;
}

// The team sessions a user's teams own, read as theirs (see sessionOwnerRow):
// each team's `cap` most recently active ones that nobody killed (Done ones
// stay: a team session is placed in Needs You, Working or Done like any), with
// this person's own triage laid on. A window of its own, read from the
// conversations themselves (by_team_owner_updated): `truncatedTeamIds` names a
// team with more, whose older team sessions are recovered by id when met.
// One read of the memberships, one range per team, one triage read per
// windowed session. An agent account owns nothing a team owns.
// The alerts that mean a session waits on a person, and how many of a
// person's newest unread ones the team window looks through.
const WAITING_ALERT_TYPES = new Set(["session_idle", "permission_request", "session_error"]);
const WAITING_ALERT_CAP = 100;
const TEAMS_PER_SCAN = 10;

export async function teamOwnerRowsForUser(
  ctx: { db: any },
  userId: Id<"users">,
  cap: number,
  known?: any[],
): Promise<{ rows: any[]; truncated: boolean; truncatedTeamIds: string[] }> {
  const none = { rows: [], truncated: false, truncatedTeamIds: [] as string[] };
  // `known`: the caller already read the memberships (the inbox scan's memo).
  const memberships = known ?? await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  if (memberships.length === 0) return none;
  // An agent account owns nothing a team owns: it reads no team window.
  const self = await ctx.db.get(userId);
  if (!self || self.is_bot) return none;
  // A bound on the teams one scan reads. Teams past it count as overflowed,
  // so their team sessions are recovered by id when the scan meets them.
  const teams = memberships.slice(0, TEAMS_PER_SCAN);
  const teamIds = new Set(memberships.map((m: any) => String(m.team_id)));
  const truncatedTeamIds: string[] = memberships.slice(TEAMS_PER_SCAN).map((m: any) => String(m.team_id));
  const convs: any[] = [];
  const perTeam = await Promise.all(teams.map((m: any) => ctx.db
    .query("conversations")
    .withIndex("by_team_owner_updated", (q: any) => q.eq("team_owner_team_id", m.team_id).eq("inbox_killed_at", undefined))
    .order("desc")
    .take(cap + 1)));
  perTeam.forEach((rows: any[], i: number) => {
    if (rows.length > cap) truncatedTeamIds.push(String(teams[i].team_id));
    convs.push(...rows.slice(0, cap));
  });
  if (convs.length === 0 && truncatedTeamIds.length === 0) return none;
  // Past a full window, a team session waiting on this person (an unread
  // alert asking for input) still belongs in their inbox, however many others
  // were more active since. Read only when a window overflowed.
  if (truncatedTeamIds.length > 0) {
    const inWindow = new Set(convs.map((c) => String(c._id)));
    const waiting = await ctx.db
      .query("notifications")
      .withIndex("by_recipient_read", (q: any) => q.eq("recipient_user_id", userId).eq("read", false))
      .order("desc")
      .take(WAITING_ALERT_CAP);
    const waitingIds = [...new Set(waiting
      .filter((n: any) => n.conversation_id && WAITING_ALERT_TYPES.has(n.type) && !inWindow.has(String(n.conversation_id)))
      .map((n: any) => String(n.conversation_id)))];
    for (const c of await Promise.all(waitingIds.map((id) => ctx.db.get(id)))) {
      if (c && !c.inbox_killed_at && c.team_owner_team_id && teamIds.has(String(c.team_owner_team_id))) convs.push(c);
    }
  }
  const truncated = truncatedTeamIds.length > 0;
  if (convs.length === 0) return { rows: [], truncated, truncatedTeamIds };
  const triage = await viewerTriageMap(ctx, userId, convs.map((c) => c._id));
  return {
    truncated,
    truncatedTeamIds,
    rows: convs.map((c) => ({
      conversation_id: c._id,
      user_id: userId,
      added_at: c.updated_at ?? 0,
      // A team session draws no per-person banner: already acknowledged.
      seen_at: c.updated_at ?? 0,
      team_id: c.team_owner_team_id,
      triage: triage.get(String(c._id)) ?? {},
      // The conversation itself, already read: the inbox scan uses it as is.
      doc: c,
    })),
  };
}

// A user's newest owner rows, newest first, at most `cap`: their person rows
// and, read as theirs (see sessionOwnerRow), the rows of sessions their teams
// own. A session held both ways reads as the person row. `truncated` says a
// source had more than `cap`, so absence from the list proves nothing.
export async function ownerRowsForUser(
  ctx: { db: any },
  userId: Id<"users">,
  cap: number,
): Promise<{ rows: any[]; truncated: boolean }> {
  const own: any[] = await ctx.db
    .query("session_owners")
    .withIndex("by_user", (q: any) => q.eq("user_id", userId))
    .order("desc")
    .take(cap + 1);
  let truncated = own.length > cap;
  const byConversation = new Map<string, any>();
  for (const row of own.slice(0, cap)) byConversation.set(String(row.conversation_id), row);
  // Two windows, each with its own cap: the person rows above, and the live
  // team sessions here. Either one overflowing makes absence unproven.
  const team = await teamOwnerRowsForUser(ctx, userId, cap);
  if (team.truncated) truncated = true;
  for (const row of team.rows) {
    const key = String(row.conversation_id);
    if (!byConversation.has(key)) byConversation.set(key, row);
  }
  return { rows: [...byConversation.values()].sort((a, b) => b.added_at - a.added_at), truncated };
}

// A session moved to another account (a pull, a device claim) under the
// session_owners feature: the person who started it still owns it implicitly,
// but an inbox finds a session by the rows a person owns and the account that
// runs it, so that ownership is written down as their own row.
export async function writeStarterRowOnMove(ctx: { db: any }, conversationId: Id<"conversations">): Promise<void> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || !(await ownersModelOn(ctx, conversation))) return;
  const starter = ownersOf(await sessionOwnerFactsOf(ctx, conversation)).implicitStarter;
  if (!starter || starter === String(conversation.user_id)) return;
  await addSessionOwnerRow(ctx, conversationId, starter as Id<"users">, starter as Id<"users">);
  await syncPrimaryOwnerCache(ctx, conversationId);
}
