// Who owns a session, who drives it and who may change either, read the way
// the owners menu, `cast own`/`cast disown` and the org chart all read it,
// plus the rules a leave must keep. The rules themselves are shared with the
// web store (shared/contracts/sessionOwners); sessionOwnership.ts holds the
// reparent core and the mutations that use these.

import type { Id } from "../_generated/dataModel";
import { addSessionOwnerRow, ownersFactsOf, settleDriver, syncPrimaryOwnerCache } from "../sessionOwners";
import { driverOf as sharedDriverOf, leaveMovesFirst, leaveStands, listedOwnerIds, runnerTakesLeftSession } from "@codecast/shared/contracts/sessionOwners";
import { findOwnableConversation } from "./sessionTell";
import { liveRoleByHandle, resolveRoleRef } from "./orgAccess";
import { enqueueSyncReceipt } from "../functions";
import { userScopeKey } from "../syncLog";

export type OwnerInfo = {
  user_id: string;
  name: string | null;
  email: string | null;
  // Assignment provenance off the join row (absent on the wholesale-set result,
  // which is built from user docs before rows exist): who handed it over, when,
  // with what note, and whether the assignee has acknowledged it. Drives the
  // "X assigned this thread to you" banner for the open session.
  added_by?: string;
  added_by_name?: string | null;
  added_at?: number;
  note?: string | null;
  seen_at?: number | null;
  // Faces for the handoff marker in the transcript, resolved server-side so a
  // viewer whose roster lacks the assigner (another team) still sees them.
  image?: string | null;
  added_by_image?: string | null;
  // The starter, listed while the session has no owner rows.
  implicit?: boolean;
};

export const avatarOf = (u: any): string | null => u?.image ?? u?.github_avatar_url ?? null;

export const toOwnerInfo = (u: any): OwnerInfo => ({
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

export async function resolveOwnableConversation(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<any> {
  const conversation = await findOwnableConversation(ctx, authUserId, sessionId);
  if (!conversation) {
    throw new Error(
      `No session found for "${sessionId}" (you can only set an owner on your own sessions or sessions shared with your team)`
    );
  }
  return conversation;
}

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

// A person as `cast own --drive` names them, looked for among the session's
// owners before the team, so two teammates with one name resolve to the one
// who owns it: an exact email or name, else a unique partial match.
export async function ownerNamed(ctx: { db: any }, ownerIds: string[], ref: string): Promise<string | null> {
  const needle = ref.trim().toLowerCase();
  const owners = (await Promise.all(ownerIds.map((id) => ctx.db.get(id)))).filter(Boolean);
  const exact = owners.find((u: any) => (u.email || "").toLowerCase() === needle) ?? owners.find((u: any) => (u.name || "").toLowerCase() === needle);
  if (exact) return String(exact._id);
  const partial = owners.filter((u: any) => (u.name || "").toLowerCase().includes(needle) || (u.email || "").toLowerCase().includes(needle));
  return partial.length === 1 ? String(partial[0]._id) : null;
}

// A role as `cast own` names it, as its id: `@handle` among the roles of the
// session's team (the caller's own roles for a session with no team), or a
// short id (or-N). The reparent core still checks the caller may file under it.
export async function resolveOwnerRoleRef(ctx: { db: any }, authUserId: Id<"users">, conversation: any, roleRef: string): Promise<string> {
  const ref = roleRef.trim();
  const role = ref.startsWith("@")
    ? await liveRoleByHandle(ctx, conversation.team_id ? { team_id: conversation.team_id } : { scope_user_id: authUserId }, ref)
    : await resolveRoleRef(ctx, ref);
  if (!role) throw new Error(`No role ${ref} in this session's workspace`);
  return String(role._id);
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

// A restored row (an undo of a remove) is an owner like an added one: the
// same team rule, never an agent account, and who added it is a real person.
// Its owner gains owner access to the session.
export async function assertRestorableRows(ctx: { db: any }, authUserId: Id<"users">, conversation: any, rows: Array<{ user_id: string; added_by: string }>): Promise<void> {
  for (const r of rows) {
    const user = await resolveOwnerRef(ctx, authUserId, conversation, r.user_id);
    if (String(user._id) !== r.user_id) throw new Error("A restored owner must be named by their id");
    assertHumanOwner(user);
    const by = ctx.db.normalizeId ? ctx.db.normalizeId("users", r.added_by) : r.added_by;
    if (!by || !(await ctx.db.get(by))) throw new Error("A restored owner row must name who added it");
  }
}

export async function listOwnerInfos(
  ctx: { db: any },
  conversationId: Id<"conversations">,
): Promise<OwnerInfo[]> {
  const rows = await ctx.db
    .query("session_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .collect();
  rows.sort((a: any, b: any) => a.added_at - b.added_at);
  const infos: OwnerInfo[] = [];
  for (const row of rows) {
    const doc = await ctx.db.get(row.user_id);
    if (!doc) continue;
    const byDoc = row.added_by ? await ctx.db.get(row.added_by) : null;
    infos.push({
      ...toOwnerInfo(doc),
      added_by: row.added_by?.toString(),
      added_by_name: byDoc?.name ?? byDoc?.email ?? null,
      added_at: row.added_at,
      note: row.note ?? null,
      seen_at: row.seen_at ?? null,
      image: avatarOf(doc),
      added_by_image: avatarOf(byDoc),
    });
  }
  return infos;
}

// ── The driver ───────────────────────────────────────────────────────────────
// Exactly one owner drives: the role while it is filed and no person has taken
// over, else `driver_user_id`, else the primary owner. Pure, so the owners
// query and the tests read the same rule.
export type SessionDriver = { kind: "role"; role_id: Id<"org_roles"> } | { kind: "user"; user_id: Id<"users"> };

// The rule itself is shared with the web store (shared/contracts/sessionOwners).
export function driverOf(conversation: { org_role_id?: Id<"org_roles">; driver_user_id?: Id<"users">; owner_user_id?: Id<"users"> }, ownerIds: string[]): SessionDriver | null {
  return sharedDriverOf({
    role_id: conversation.org_role_id ? String(conversation.org_role_id) : null,
    driver_user_id: conversation.driver_user_id ? String(conversation.driver_user_id) : null,
    primary_id: conversation.owner_user_id ? String(conversation.owner_user_id) : null,
  }, ownerIds) as SessionDriver | null;
}

// The owner set as the session shows it (shared listedOwnerIds): its owner
// rows, else the human who started it, and nobody for a run a role started.
export async function ownerIdsOrStarter(ctx: { db: any }, conversation: any): Promise<string[]> {
  return listedOwnerIds(await ownersFactsOf(ctx, conversation));
}

// `none` hands the wheel back to the default: the role if one is filed,
// else the primary owner. It is how an undo puts back a driver nobody chose.
export type DriverTarget = { kind: "role" } | { kind: "user"; user_id: string } | { kind: "none" };

// Who may change the owners and the driver: an owner, or the account that
// runs the session. A teammate who can only see it reads the menu.
export async function mayEditOwners(ctx: { db: any }, authUserId: Id<"users">, conversation: any): Promise<boolean> {
  if (String(conversation.user_id) === String(authUserId)) return true;
  return (await ownerIdsOrStarter(ctx, conversation)).includes(String(authUserId));
}

// What a leave leaves behind, checked after the caller's row is gone: it no
// longer runs on their account, they no longer drive, and someone still owns
// it (the person whose account runs it takes a row when nobody else does). A
// run a role started needs neither: with no person left it is the role's.
export const LEAVE_MOVE_REFUSAL = "It runs on your account: move it to a teammate's or a team machine to leave it";
export async function settleLeave(ctx: { db: any }, authUserId: Id<"users">, conversation: any): Promise<void> {
  const me = String(authUserId);
  const facts = await ownersFactsOf(ctx, conversation);
  if (leaveMovesFirst(facts, me)) throw new Error(LEAVE_MOVE_REFUSAL);
  const runner = runnerTakesLeftSession(facts, me);
  if (runner) {
    await addSessionOwnerRow(ctx, conversation._id, runner as Id<"users">, authUserId);
    await syncPrimaryOwnerCache(ctx, conversation._id);
  }
  if (!leaveStands(await ownersFactsOf(ctx, await ctx.db.get(conversation._id)), me)) throw new Error("Nobody would own it after you leave: add a teammate first");
  await settleDriver(ctx, conversation._id);
  // The leave's write left the leaver's scope with their row, so their window
  // would get no receipt to retire its locks on: it gets one there too.
  await enqueueSyncReceipt(ctx, userScopeKey(me), "conversations", String(conversation._id));
}

// An owners edit that takes the caller out of the owners is their leave,
// whichever door it came by (an owners set, the chart's reparent mutation),
// so it keeps the leave rules. The org log's undo replays owner sets through
// the core directly: putting back an earlier set is not a leave.
export async function withLeaveRules<T>(ctx: { db: any }, authUserId: Id<"users">, sessionId: string, edit: () => Promise<T>): Promise<T> {
  const before = await resolveOwnableConversation(ctx, authUserId, sessionId);
  const me = String(authUserId);
  const owned = (await ownerIdsOrStarter(ctx, before)).includes(me);
  const out = await edit();
  if (owned) {
    const after = await ctx.db.get(before._id);
    if (!(await ownerIdsOrStarter(ctx, after)).includes(me)) await settleLeave(ctx, authUserId, after);
  }
  return out;
}
