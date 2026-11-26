// Who an owners change names and how it is written: owner refs resolved to
// people and roles, the one owners write under the session_owners feature, and
// the roster an owners picker offers. Split out of sessionOwnership.ts for its
// max-lines pin; its mutations and queries stay there.
import type { Id } from "../_generated/dataModel";
import { liveRoleByHandle, requireRole } from "./orgAccess";
import { roleMayHoldSession } from "./sessionTell";
import { addSessionOwnerRow, ownersModelOn, removeSessionOwnerRow, sessionOwnerFactsOf, syncPrimaryOwnerCache, type OwnerRowSnapshot } from "../sessionOwners";
import { applyOwnersChangeTo, mayEditOwners, ownersChangeRefusal, ownersLeftRefusal, ownersOf, type OwnersChange } from "@codecast/shared/contracts/sessionOwners";
import { rehandWait } from "./inboxOwners";
import type { ReparentSessionTarget } from "../sessionOwnership";
import { findConversationByAnyRefWhere } from "../conversationSessionLookup";
import { checkConversationAccess } from "../privacy";
import { isClosedSession } from "@codecast/shared/contracts";

// Picker roster cap. The live listOwners subscription must NEVER walk the
// team — that collect + N user-doc reads is what blew the syscall budget
// (and re-ran on every teammate daemon heartbeat, because those user docs
// are heartbeat-hot). Mutations still resolve names against the full set.
export const OWNER_CANDIDATE_CAP = 250;

export async function teamMemberDocs(
  ctx: { db: any },
  teamId: any,
  cap?: number,
): Promise<any[]> {
  const q = ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId));
  const memberships = cap ? await q.take(cap) : await q.collect();
  return (
    await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))
  ).filter(Boolean) as any[];
}

// Resolve one owner ref to a user doc: "me", then exact email, then exact name,
// then a UNIQUE substring — scripts pass exact emails; the looser tiers are for
// humans at the CLI.
export async function resolveOwnerRef(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  ownerRef: string,
): Promise<any> {
  if (ownerRef.toLowerCase() === "me") return ctx.db.get(authUserId);

  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);

  // A raw user id — the web owners picker passes each member's _id directly
  // (the CLI passes email/name). Resolve it, then apply the same access rule as
  // a lookup: the caller may always claim THEMSELVES (no team needed, e.g. a
  // private session), but adding anyone ELSE requires the session to have a team
  // they belong to — a teammate can't own a session they can't even see.
  if (/^[a-z0-9]{16,}$/i.test(ownerRef)) {
    let candidate: any = null;
    try { candidate = await ctx.db.get(ownerRef as Id<"users">); } catch { candidate = null; }
    if (candidate && (candidate.email !== undefined || candidate.name !== undefined)) {
      if (candidate._id.toString() === authUserId.toString()) return candidate; // self-claim
      if (!conversation.team_id) {
        throw new Error(`Session ${shortId} has no team — you can only add teammates to a shared/team session. Claim it yourself instead.`);
      }
      const membership = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) =>
          q.eq("user_id", candidate._id).eq("team_id", conversation.team_id))
        .first();
      if (!membership) {
        throw new Error(`${candidate.name || candidate.email || "That user"} isn't a member of this session's team`);
      }
      return candidate;
    }
    // Not a user id (or unresolvable) — fall through to name/email matching.
  }

  if (!conversation.team_id) {
    throw new Error(`Session ${shortId} has no team — an owner must be a teammate. Use "me" to claim it yourself.`);
  }
  const members = await teamMemberDocs(ctx, conversation.team_id);

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
export function assertHumanOwner(ownerUser: any): void {
  if (ownerUser.is_bot) {
    throw new Error(
      `${ownerUser.name || ownerUser.email || "That user"} is an agent account — sessions can only be owned by a human team member`
    );
  }
}

export function assertRoleMayOwn(conversation: any, role: any): void {
  if (role.status === "retired") throw new Error("That role is retired");
  // A team role only takes sessions routed to its team; a personal role
  // takes anything its owner may reparent.
  if (role.team_id && (conversation.team_id?.toString() ?? null) !== role.team_id.toString()) {
    throw new Error("That session is not in the role's team");
  }
}

// A role as an owners change names it: `@handle` among the roles of the
// session's team (the caller's own for a session with no team), else a short
// id or an id. The caller must be able to see the role.
export async function resolveOwnerRole(ctx: { db: any }, authUserId: Id<"users">, conversation: any, ref: string): Promise<any> {
  const trimmed = ref.trim();
  const byHandle = trimmed.startsWith("@")
    ? await liveRoleByHandle(ctx, conversation.team_id ? { team_id: conversation.team_id } : { scope_user_id: authUserId }, trimmed)
    : null;
  if (trimmed.startsWith("@") && !byHandle) throw new Error(`No role ${trimmed} in this session's workspace`);
  const role = await requireRole(ctx, authUserId, byHandle ? String(byHandle._id) : trimmed, "access");
  assertRoleMayOwn(conversation, role);
  if (!(await roleMayHoldSession(ctx, role, conversation))) {
    throw new Error(`That session is private to you, and @${role.handle} is a role your team can read; share the session with the team first`);
  }
  return role;
}

// Any reparent target as one owners change, refs resolved to ids. Used only
// under the session_owners feature, where every door writes through the one
// owner rule: adding a person keeps the role, and a role keeps the people.
export async function ownersChangeFor(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  target: ReparentSessionTarget,
  targetRole: any | null,
): Promise<OwnersChange> {
  const people = async (refs: string[] | undefined, adding: boolean): Promise<string[]> => {
    const ids: string[] = [];
    for (const ref of refs ?? []) {
      if (!ref.trim()) continue;
      const user = await resolveOwnerRef(ctx, authUserId, conversation, ref.trim());
      if (adding) assertHumanOwner(user);
      if (!ids.includes(String(user._id))) ids.push(String(user._id));
    }
    return ids;
  };
  if (target.kind === "role") return { role: String(targetRole._id) };
  if (target.kind === "user") {
    const mode = target.mode ?? (target.owners ? "set" : "add");
    const refs = target.owners ?? (target.user_id ? [String(target.user_id)] : []);
    if (mode === "remove") return { remove: await people(refs, false) };
    const add = await people(refs, true);
    if (mode === "add") return { add };
    // The set replaces every person who owns it now, the implicit starter included.
    const now = ownersOf(await sessionOwnerFactsOf(ctx, conversation));
    const current = [...now.people, ...(now.implicitStarter ? [now.implicitStarter] : [])];
    return { add, remove: current.filter((id) => !add.includes(id)) };
  }
  for (const row of target.restore ?? []) await assertRestorableRow(ctx, authUserId, conversation, row);
  return {
    add: await people(target.add, true),
    remove: await people(target.remove, false),
    ...(target.restore?.length ? { restore: target.restore } : {}),
    ...(target.role === undefined ? {} : { role: target.role === null ? null : String((await resolveOwnerRole(ctx, authUserId, conversation, target.role))._id) }),
    ...(target.release_parent ? { releaseParent: true } : {}),
    ...(target.take_over ? { takeOver: true } : {}),
    ...(target.adopt_parent || target.detach_parent ? assertMovableWorker(conversation) : {}),
    ...(target.adopt_parent ? { adoptParent: await adoptableParentId(ctx, authUserId, conversation, target.adopt_parent) } : {}),
    ...(target.detach_parent ? { detachParent: true } : {}),
  };
}

/** A session nested under its parent by how it was started, not by who owns
 *  it, never moves between parents: a Claude Code subagent or a
 *  `cast spawn --subagent` worker (is_subagent), a workflow station, a plan
 *  handoff. An adopt or a detach of one is refused. */
export function assertMovableWorker(conversation: any): {} {
  if (conversation.is_subagent || conversation.is_workflow_sub || conversation.parent_message_uuid) throw new Error("It is nested under its session by how it was started; it can't be moved");
  return {};
}

/** How many links up an adopt follows the target's parents looking for the
 *  session itself: a safety bound, since a visited set ends any loop. */
export const ADOPT_CHAIN_CAP = 50;

// The session an adopt makes this one work for, resolved from any ref, or a
// refusal. It must be one that can act for this one: the caller can read it,
// it is alive and under the owners model, the caller owns or runs it (you
// hand work only to a session that is yours), its runner can open this
// session, and it is not nested under this session at any depth (a loop of
// sessions answering each other). Adopting itself, or the parent it already
// has, is the shared rule's refusal.
export async function adoptableParentId(ctx: { db: any }, authUserId: Id<"users">, conversation: any, ref: string): Promise<string> {
  const target: any = await findConversationByAnyRefWhere(ctx, ref, async (c) => (await checkConversationAccess(ctx as any, authUserId, c as any)) !== "denied");
  if (!target) throw new Error(`No session you can read matches "${ref}"`);
  if (String(target._id) === String(conversation._id)) return String(target._id);
  if (target.inbox_killed_at) throw new Error("That session was killed; it cannot take workers");
  if (isClosedSession(target)) throw new Error("That session is closed; it cannot take workers");
  if (!(await ownersModelOn(ctx, target))) throw new Error("That session is not under session owners, so it cannot take workers");
  if (!mayEditOwners(await sessionOwnerFactsOf(ctx, target), String(authUserId))) throw new Error("You can only hand work to a session you own or run");
  if (!target.user_id || (await checkConversationAccess(ctx as any, target.user_id, conversation)) === "denied") {
    throw new Error("That session's runner cannot open this one, so it could not answer it");
  }
  const seen = new Set<string>();
  let link: unknown = target.parent_conversation_id;
  while (link && !seen.has(String(link)) && seen.size < ADOPT_CHAIN_CAP) {
    if (String(link) === String(conversation._id)) throw new Error("That session already works for this one: it cannot also be its worker");
    seen.add(String(link));
    link = (await ctx.db.get(link as Id<"conversations">))?.parent_conversation_id;
  }
  return String(target._id);
}

// A restored row (an undo of a remove) is held to the add rules: a teammate
// named by id, never an agent account.
export async function assertRestorableRow(ctx: { db: any }, authUserId: Id<"users">, conversation: any, row: Pick<OwnerRowSnapshot, "user_id">): Promise<void> {
  const user = await resolveOwnerRef(ctx, authUserId, conversation, row.user_id);
  if (String(user._id) !== row.user_id) throw new Error("A restored owner must be named by their id");
  assertHumanOwner(user);
}

// The row a restore writes, built from the snapshot's own typed fields only
// and checked by the add rules here too (assertRestorableRow), whatever door
// the change came through: an input row cannot name another conversation, or
// carry any field the table does not have. Who added it is the person
// restoring it, never the input (the snapshot's added_by is ignored), so a
// restore cannot put anyone else's name on the "added you" ping.
// conversation_id is this session's, always, and set last.
export async function restoredOwnerRow(ctx: { db: any }, authUserId: Id<"users">, conversation: any, row: OwnerRowSnapshot) {
  const user_id = String(row.user_id);
  if (typeof row.added_at !== "number" || !Number.isFinite(row.added_at)) throw new Error("A restored owner row must say when it was added");
  if (row.seen_at !== undefined && (typeof row.seen_at !== "number" || !Number.isFinite(row.seen_at))) throw new Error("A restored owner row's seen time must be a time");
  if (row.note !== undefined && typeof row.note !== "string") throw new Error("A restored owner row's note must be text");
  await assertRestorableRow(ctx, authUserId, conversation, { user_id });
  return {
    user_id: user_id as Id<"users">,
    added_by: authUserId,
    added_at: row.added_at,
    ...(row.seen_at !== undefined ? { seen_at: row.seen_at } : {}),
    ...(row.note !== undefined ? { note: row.note } : {}),
    conversation_id: conversation._id,
  };
}

// The one owners write under the session_owners feature: the shared rule
// decides the result and the refusals, and this writes the difference in one
// transaction. `added` names only the people handed the session (the
// implicit starter's own row, written so they stay an owner, is not a
// handoff). Every write stamps owners_changed_at (syncPrimaryOwnerCache).
export async function writeOwnersChange(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  change: OwnersChange,
  opts: { checkEdit: boolean; note?: string; hold: "bound" | "filed" },
): Promise<{ added: Id<"users">[]; removed: Id<"users">[]; roleId: Id<"org_roles"> | undefined }> {
  const now = Date.now();
  const at = { actor: String(authUserId), now };
  const facts = await sessionOwnerFactsOf(ctx, conversation);
  const refusal = opts.checkEdit ? ownersChangeRefusal(facts, change, at) : ownersLeftRefusal(facts, change, at);
  if (refusal) throw new Error(refusal);
  const next = applyOwnersChangeTo(facts, change, at);
  const was = ownersOf(facts);
  const will = ownersOf(next);
  if (will.people.includes(at.actor) && !was.people.includes(at.actor)) assertHumanOwner(await ctx.db.get(authUserId));

  const added: Id<"users">[] = [];
  const removed: Id<"users">[] = [];
  for (const id of was.people) {
    if (!will.people.includes(id) && await removeSessionOwnerRow(ctx, conversation._id, id as Id<"users">)) removed.push(id as Id<"users">);
  }
  for (const id of will.people) {
    if (was.people.includes(id)) continue;
    const restored = (change.restore as OwnerRowSnapshot[] | undefined)?.find((r) => r.user_id === id);
    if (restored) {
      await ctx.db.insert("session_owners", await restoredOwnerRow(ctx, authUserId, conversation, restored));
      added.push(id as Id<"users">);
    } else if (id === was.implicitStarter && !(change.add ?? []).includes(id)) {
      await addSessionOwnerRow(ctx, conversation._id, id as Id<"users">, id as Id<"users">);
    } else if (await addSessionOwnerRow(ctx, conversation._id, id as Id<"users">, authUserId, opts.note)) {
      added.push(id as Id<"users">);
    }
  }

  const patch: Record<string, unknown> = {};
  if (will.role !== was.role) {
    patch.org_role_id = will.role ?? undefined;
    patch.org_role_hold = will.role ? opts.hold : undefined;
  }
  if (change.adoptParent) {
    // A worker of another session now: the parent owns it (released only
    // when an undo puts a released parent back).
    patch.parent_conversation_id = change.adoptParent;
    if ((conversation.parent_released_at ?? null) !== (next.parent_released_at ?? null)) patch.parent_released_at = next.parent_released_at ?? undefined;
  } else if (change.detachParent) {
    // Out from under any parent, as if it never had one (an adopt's undo).
    if (conversation.parent_conversation_id !== undefined) patch.parent_conversation_id = undefined;
    if (conversation.parent_released_at !== undefined) patch.parent_released_at = undefined;
  } else if (next.parent_released_at !== facts.parent_released_at) patch.parent_released_at = next.parent_released_at ?? undefined;
  if (facts.role_started && !next.role_started) patch.role_started = undefined;
  if (Object.keys(patch).length) await ctx.db.patch(conversation._id, patch);
  // Its standing wait was settled for the agent owner it had: the new one hears it.
  if (change.adoptParent || change.detachParent) await rehandWait(ctx, conversation);
  // The session reports to the person this change named last.
  const named = [...(change.add ?? []), ...(added.includes(authUserId) ? [String(authUserId)] : [])].filter((id) => will.people.includes(id));
  await syncPrimaryOwnerCache(ctx, conversation._id, named[named.length - 1] as Id<"users"> | undefined);
  return { added, removed, roleId: (will.role ?? undefined) as Id<"org_roles"> | undefined };
}

// A row of the owner-candidate roster: who the picker may OFFER. Mirrors the
// fields the web/mobile pickers render off a store roster row.
export type OwnerCandidate = {
  _id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  github_avatar_url: string | null;
  is_bot: boolean;
};

export const toOwnerCandidate = (u: any): OwnerCandidate => ({
  _id: u._id.toString(),
  name: u.name ?? null,
  email: u.email ?? null,
  image: u.image ?? null,
  github_avatar_url: u.github_avatar_url ?? null,
  is_bot: !!u.is_bot,
});

// Who may become an owner of THIS session — the same rule resolveOwnerRef
// enforces on write: members of the session's team, or only the caller when
// the session is teamless (self-claim). The pickers render exactly this list;
// a roster taken from the viewer's ACTIVE team offers people the server would
// reject whenever the session is stamped with a different team.
//
// Cap the membership walk: a reactive subscriber that collected the whole
// team paid N user-doc reads (and re-ran on every teammate heartbeat). The
// picker is a one-shot open; 250 candidates is more humans than we show.
export async function ownerCandidatesFor(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
): Promise<OwnerCandidate[]> {
  if (!conversation.team_id) {
    const me = await ctx.db.get(authUserId);
    return me ? [toOwnerCandidate(me)] : [];
  }
  return (await teamMemberDocs(ctx, conversation.team_id, OWNER_CANDIDATE_CAP)).map(
    toOwnerCandidate,
  );
}
