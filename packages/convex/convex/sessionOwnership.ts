import { mutation, query, internalMutation, internalAction } from "./functions";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess, isVisibilityShareable, teamVisibleConvTeam } from "./privacy";
import {
  addSessionOwnerRow,
  removeSessionOwnerRow,
  listSessionOwnerIds,
  syncPrimaryOwnerCache,
  humanStarterUser,
} from "./sessionOwners";
import { notifySessionAssigned, notifySessionOwnershipChanged } from "./sessionAssignmentNotifications";
import { enqueuePendingMessage, formatSessionMessage } from "./pendingMessages";
import { requireRole, userCanAdminRole } from "./lib/orgAccess";
import { resolveActor } from "./lib/actor";
import { wakeCost, wakeFieldsOf } from "./wakeCost";
import { reroutePendingDecisionsForConversation } from "./sessionDecisions";
import { movedFields } from "@codecast/shared/contracts/orgChange";
import { labelsOf, noteOrgChange, rememberOrgRecord, roleSubject, sessionParent, sessionSubject, whereOfRole, whereOfSession, withOrgChange } from "./lib/orgChangeLog";

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
// send/steer mechanics (pending_messages) are unchanged. A cross-user send
// auto-owns only a bot-run session with an empty owner set
// (performSessionSend); a message into a session a person started never
// claims it.

type OwnerInfo = {
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
};

const avatarOf = (u: any): string | null => u?.image ?? u?.github_avatar_url ?? null;

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
// they can already see. A merely share-linked viewer may not. Returns null when
// nothing accessible matches — reads treat that as "no data" (the web mounts
// listOwners with refs that may not have synced yet, e.g. an optimistic stub
// session's client UUID), while mutations escalate it to an error.
async function findOwnableConversation(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<any> {
  return findConversationByAnyRefWhere(ctx, sessionId, async (candidate) => {
    const access = await checkConversationAccess(ctx, authUserId, candidate);
    return access === "owner" || access === "team";
  });
}

async function resolveOwnableConversation(
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

async function teamMemberDocs(
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
async function resolveOwnerRef(
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

// ── The reparent core (org-staffing.md S11) ──────────────────────────────────
// Who a session reports to is one gesture everywhere: the ownership menu
// (take ownership, add an owner, remove one, replace the set), `cast own` /
// `cast disown`, and dragging a session on the org chart all land here. It is
// the ONE place session_owners and conversations.org_role_id change together:
// a person target re-homes the session under that person (they become the
// primary owner the chart files it under) and clears the role pointer; a role
// target sets the pointer and leaves the owners alone. Every move that changes
// the reporting line tells the agent once, through the session message rail,
// from the acting person.
//
// Factored out of the mutations so tests drive them with an explicit
// authUserId (mirrors performSessionSend). Deliberately db-only: the result
// carries the `added` set and the PUBLIC mutations fire the "assigned to you"
// notification for it, which keeps ctx.scheduler out of here.

export type ReparentSessionTarget =
  // A person: the org chart passes `user_id` (the owner set becomes that
  // person); the ownership menu passes owner refs with the set arithmetic it
  // wants. `add` re-homes under the added person; `set` under the first
  // listed; `remove` leaves the reporting line to whoever remains.
  | { kind: "user"; user_id?: Id<"users">; owners?: string[]; mode?: "set" | "add" | "remove" }
  | { kind: "role"; role_id: string };

export type ReportsTo =
  | { kind: "user"; user_id: Id<"users">; name: string }
  | { kind: "role"; role_id: Id<"org_roles">; short_id: string; handle: string; name: string };

export type ReparentSessionResult = OwnerMutationResult & {
  org_role_id: Id<"org_roles"> | null;
  reports_to: ReportsTo | null;
  // What the mutation told: the session itself (one message) and, for a
  // session move, never a role. `deferred` counts a session too stale to wake
  // for one sentence: the line waits and it reads it when it next runs. The
  // web says it in one toast.
  told: { sessions: number; roles: number; deferred?: number };
};

// A person's name as the product shows it: display name, then login, then
// the email's local part. Shared with the role reparent's line.
export function personName(u: any): string {
  return u?.name || u?.github_username || u?.email?.split("@")[0] || "a teammate";
}

// The line every reparent delivers (org-staffing.md S11). One writer, so the
// session and the role hear the same sentence.
export function reportsToLine(name: string, note?: string): string {
  const trimmed = note?.trim();
  return `You now report to ${name}.${trimmed ? ` ${trimmed}` : ""}`;
}

// Who a session reports to: its role, else its primary owner (the
// owner_user_id cache, which the chart files by; syncPrimaryOwnerCache is its
// one writer).
// `read` is the doc read (a batch passes its memo, so a hundred sessions of
// one host read that host once); `row` is the conversation when the caller
// already holds it as it stands.
async function reportsToOf(ctx: { db: any }, conversationId: Id<"conversations">, roleId: Id<"org_roles"> | undefined, known: { read?: (id: any) => Promise<any>; row?: any } = {}): Promise<ReportsTo | null> {
  const read = known.read ?? ((id: any) => ctx.db.get(id));
  if (roleId) {
    const role = await read(roleId);
    if (role) return { kind: "role", role_id: role._id, short_id: role.short_id, handle: role.handle, name: role.name };
  }
  const primary = (known.row ?? await ctx.db.get(conversationId))?.owner_user_id;
  const user = primary ? await read(primary) : null;
  return user ? { kind: "user", user_id: user._id, name: personName(user) } : null;
}

// A team role's standing session is team visible, and its wake frame prints
// each of its sessions' title, state and task (R1). So a session the team
// cannot see never reports to a team role: filing it there would publish it.
// A personal role (no team) has only its owner as a reader and takes any.
const sessionVisibility = new WeakMap<object, Map<string, Promise<boolean>>>();

export async function roleMayHoldSession(ctx: { db: any }, role: { team_id?: any }, c: any): Promise<boolean> {
  if (!role.team_id) return true;
  if (String(teamVisibleConvTeam(c) ?? "") !== String(role.team_id)) return false;
  let cache = sessionVisibility.get(ctx);
  if (!cache) { cache = new Map(); sessionVisibility.set(ctx, cache); }
  const key = `${role.team_id}:${c.user_id}`;
  let visible = cache.get(key);
  if (!visible) {
    visible = ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", c.user_id).eq("team_id", role.team_id)).first().then((m: any) => !!m && isVisibilityShareable(m.visibility ?? "summary"));
    cache.set(key, visible!);
  }
  return visible!;
}

const reportsToKey = (r: ReportsTo | null): string => !r ? "" : r.kind === "role" ? `role:${r.role_id}` : `user:${r.user_id}`;

// Take the previous holder's triage off a row that is being put in front of
// someone: a handoff to a new owner, or a role's escalation. Only a stamp that
// is set is cleared, so an untouched row takes no write. A kill is left alone:
// that row is retired, and `cast restore` is the gesture that brings it back.
async function unhide(ctx: { db: any }, conversation: any): Promise<void> {
  const hidden: Record<string, undefined> = {};
  if (conversation.inbox_dismissed_at) hidden.inbox_dismissed_at = undefined;
  if (conversation.inbox_stashed_at) {
    hidden.inbox_stashed_at = undefined;
    hidden.inbox_stash_hidden = undefined;
  }
  if (conversation.inbox_snoozed_until) hidden.inbox_snoozed_until = undefined;
  if (Object.keys(hidden).length > 0) await ctx.db.patch(conversation._id, hidden);
}

// What many reparents to ONE role resolve once (the takeover moves up to 100
// sessions in one transaction, and each used to resolve the same role, the
// same admin check, the same acting person and the same sender again: 16
// reads a session). `read` memoizes user and role docs, which no reparent
// writes; conversations are never read through it.
export type ReparentBatch = {
  role: any;
  canReshape: boolean;
  actor: any;
  sender: any | null;
  read: (id: any) => Promise<any>;
};

export async function prepareReparentBatch(ctx: { db: any }, authUserId: Id<"users">, roleRef: string, fromSession?: string): Promise<ReparentBatch> {
  const role = await requireRole(ctx, authUserId, roleRef, "access");
  const docs = new Map<string, Promise<any>>();
  const read = (id: any): Promise<any> => {
    const key = String(id);
    const cached = docs.get(key);
    if (cached) return cached;
    const doc: Promise<any> = ctx.db.get(id);
    docs.set(key, doc);
    return doc;
  };
  docs.set(String(role._id), Promise.resolve(role));
  const fromRef = fromSession?.trim();
  return {
    role,
    canReshape: await userCanAdminRole(ctx, authUserId, role),
    actor: await read(authUserId),
    sender: fromRef ? await findConversationByAnyRefWhere(ctx, fromRef, async () => true) : null,
    read,
  };
}

export async function performReparentSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; target: ReparentSessionTarget; note?: string; from_session?: string },
  // The batch form: the prepared role target, and the session's row as the
  // caller read it in this same transaction. The access rule below is the
  // same one; only the lookups that would answer the same thing are skipped.
  known?: { batch: ReparentBatch; row: any },
): Promise<ReparentSessionResult> {
  return withOrgChange(ctx, authUserId, { kind: "session", door: args.from_session ? "cli" : "chart", gesture: args.from_session ? "command" : "drag" }, () => reparentSessionCore(ctx, authUserId, args, known));
}

async function reparentSessionCore(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; target: ReparentSessionTarget; note?: string; from_session?: string },
  known?: { batch: ReparentBatch; row: any },
): Promise<ReparentSessionResult> {
  const note = args.note?.trim() || undefined;
  const targetRole = args.target.kind === "role" ? known?.batch.role ?? await requireRole(ctx, authUserId, args.target.role_id, "access") : null;
  const canReshapeTarget = known ? known.batch.canReshape : targetRole ? await userCanAdminRole(ctx, authUserId, targetRole) : false;
  // Who may file: a person target is the ownership rule (the runner, or any
  // teammate who can see the session); a role target is an owner, or a team
  // viewer who may reshape the role. A session the caller cannot see, never.
  const mayFileUnderRole = async (c: any) => {
    const access = await checkConversationAccess(ctx, authUserId, c);
    return access === "owner" || (access === "team" && canReshapeTarget);
  };
  const conversation = args.target.kind === "user"
    ? await resolveOwnableConversation(ctx, authUserId, args.session_id)
    : known ? ((await mayFileUnderRole(known.row)) ? known.row : null)
    : await findConversationByAnyRefWhere(ctx, args.session_id, mayFileUnderRole);
  if (!conversation) throw new Error("Session not found, or you are not one of its owners");
  // A standing session IS a seat; it reports to no seat (org-roles-standing.md
  // T1). Filed under a role it would count as that role's hand, be interrupted
  // by a pause and spend its hand cap. One refusal here, so every door (the
  // chart, the ownership menu, the CLI) inherits it.
  if (args.target.kind === "role" && (conversation.standing_role_id || conversation.anchor_id)) {
    throw new Error("That session is a standing agent's own thread; it cannot be filed under a role");
  }
  // A session of another team keeps the older refusal below; this one is for a
  // session routed to the role's team that the team cannot see.
  if (targetRole?.team_id && String(conversation.team_id ?? "") === String(targetRole.team_id) && !(await roleMayHoldSession(ctx, targetRole, conversation))) {
    throw new Error(`That session is private to you, and @${targetRole.handle} is a role your team can read; share the session with the team first, or keep it under you`);
  }
  rememberOrgRecord(ctx, conversation);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  const before = await reportsToOf(ctx, conversation._id, conversation.org_role_id, { read: known?.batch.read, row: conversation });
  const parentBefore = await sessionParent(ctx, conversation);

  const added: Id<"users">[] = [];
  const removed: Id<"users">[] = [];
  let owners: OwnerInfo[];
  let roleId: Id<"org_roles"> | undefined = conversation.org_role_id;

  if (args.target.kind === "user") {
    // A bare `user_id` is the chart's drop on a person: it ADDS that person
    // and re-homes the session under them (S11), so a session two people own
    // does not silently lose the other. The owner list form is the picker's,
    // which holds the whole desired set.
    const mode = args.target.mode ?? (args.target.owners ? "set" : "add");
    const refs = args.target.owners ?? (args.target.user_id ? [args.target.user_id.toString()] : []);
    const desiredKeys = new Set<string>();
    const desired: any[] = [];
    for (const ref of refs) {
      const trimmed = ref.trim();
      if (!trimmed) continue;
      const user = await resolveOwnerRef(ctx, authUserId, conversation, trimmed);
      if (mode !== "remove") assertHumanOwner(user);
      const key = user._id.toString();
      if (desiredKeys.has(key)) continue;
      desiredKeys.add(key);
      desired.push(user);
    }
    if (mode === "remove") {
      for (const user of desired) {
        if (await removeSessionOwnerRow(ctx, conversation._id, user._id)) removed.push(user._id);
      }
    } else {
      for (const user of desired) {
        if (await addSessionOwnerRow(ctx, conversation._id, user._id, authUserId, note)) added.push(user._id);
      }
      if (mode === "set") {
        for (const ownerId of await listSessionOwnerIds(ctx, conversation._id)) {
          if (desiredKeys.has(ownerId.toString())) continue;
          if (await removeSessionOwnerRow(ctx, conversation._id, ownerId)) removed.push(ownerId);
        }
      }
    }
    // A handoff un-hides the row. Dismiss, stash and snooze are the PREVIOUS
    // holder's triage ("not in my inbox"), and they live on the row rather than
    // per viewer, so leaving them set would hand someone a session they cannot
    // see. Only a real addition clears them, and only a stamp that is set — an
    // untouched row takes no write. A kill is left alone: that row is retired,
    // and `cast restore` is the gesture that brings it back.
    if (added.length > 0) await unhide(ctx, conversation);
    // The session reports to the person this act named: `add` hands it to the
    // added person (a handoff, the chart follows), `set` to the LAST listed —
    // callers put the person the act names at the end of `owners`. A remove
    // leaves the line to whoever remains, oldest first.
    const preferred = mode === "remove" ? undefined : desired[desired.length - 1]?._id;
    await syncPrimaryOwnerCache(ctx, conversation._id, preferred);
    // A person is now the parent: the role pointer comes off (S11). A remove
    // is not a re-homing, so a session filed under a role stays there.
    if (mode !== "remove" && desired.length > 0 && roleId) {
      // The escalation is the role's line (R1); with no role there is none.
      await ctx.db.patch(conversation._id, { org_role_id: undefined, escalated_by_role: undefined });
      roleId = undefined;
    }
    owners = mode === "set" ? desired.map(toOwnerInfo) : await listOwnerInfos(ctx, conversation._id);
  } else {
    if (targetRole.status === "retired") throw new Error("That role is retired");
    // A team role only takes sessions routed to its team; a personal role
    // takes anything its owner may reparent.
    if (targetRole.team_id && (conversation.team_id?.toString() ?? null) !== targetRole.team_id.toString()) {
      throw new Error("That session is not in the role's team");
    }
    // Another role's escalation does not carry over: the new role has not
    // said why this is in front of a person.
    const staleEscalation = conversation.escalated_by_role && String(conversation.escalated_by_role.role_id) !== String(targetRole._id);
    await ctx.db.patch(conversation._id, { org_role_id: targetRole._id, ...(staleEscalation ? { escalated_by_role: undefined } : {}) });
    roleId = targetRole._id;
    owners = await listOwnerInfos(ctx, conversation._id);
  }

  const after = await reportsToOf(ctx, conversation._id, roleId, { read: known?.batch.read });
  const told: { sessions: number; roles: number; deferred?: number } = { sessions: 0, roles: 0 };
  if (after && reportsToKey(after) !== reportsToKey(before)) {
    const how = await tellSession(ctx, authUserId, conversation, reportsToLine(after.name, note), args.from_session, reportsToKey(after), known?.batch);
    if (how === "deferred") told.deferred = 1; else told.sessions = 1;
  }
  // Open questions follow the new owners. Without this, asked_user_ids and
  // decision_inbox stay on the runner / role parent and the card never leaves
  // their question stack.
  await reroutePendingDecisionsForConversation(ctx, conversation._id, Date.now());
  // The org log (org-staffing.md S21): where the session was and where it is
  // now. Inside a takeover this folds into the row of the change that caused
  // it; on its own (the chart, the ownership menu) it is a row.
  const parentAfter = targetRole ? { ...parentBefore, org_role_id: String(targetRole._id) } : await sessionParent(ctx, { _id: conversation._id, org_role_id: roleId });
  await noteOrgChange(ctx, authUserId, targetRole ? whereOfRole(targetRole) : whereOfSession(conversation), {
    kind: "session",
    subject: sessionSubject(conversation),
    ...movedFields({ parent: parentBefore }, { parent: parentAfter }),
    labels: await labelsOf(ctx, [...parentBefore.owner_user_ids, ...parentAfter.owner_user_ids, parentBefore.org_role_id, parentAfter.org_role_id], known?.batch.read),
    door: args.from_session ? "cli" : "chart",
    gesture: args.from_session ? "command" : "drag",
  });
  return {
    ok: true,
    short_id: shortId,
    conversation_id: conversation._id,
    owners,
    added,
    removed,
    org_role_id: roleId ?? null,
    reports_to: after,
    told,
  };
}

// One message into the session, attributed to the acting person through the
// session message rail: their own session when the CLI names one, else a
// named line with no session pill (the web's rendering of an unlinked
// sender). A session that is killed or whose prompt cache has expired (the
// send rail's own rule, wakeCost) is not woken to read one sentence: the line
// is deferred and rides its next turn.
async function tellSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  conversation: any,
  body: string,
  fromSession: string | undefined,
  moveKey: string,
  batch?: Pick<ReparentBatch, "actor" | "sender">,
): Promise<"told" | "deferred"> {
  const actor = batch ? batch.actor : await ctx.db.get(authUserId);
  const fromRef = fromSession?.trim();
  const sender = batch ? batch.sender : fromRef ? await findConversationByAnyRefWhere(ctx, fromRef, async () => true) : null;
  const fromShortId = sender ? (sender.short_id ?? sender._id.toString().slice(0, 7)) : "unknown";
  const crossUser = conversation.user_id.toString() !== authUserId.toString();
  const cost = wakeCost({ ...conversation, ...wakeFieldsOf(conversation) }, Date.now());
  const defer = !conversation.standing_role_id && (cost.killed || cost.cacheCold);
  await enqueuePendingMessage(ctx, conversation, authUserId, {
    content: formatSessionMessage(fromShortId, body, personName(actor)),
    client_id: `reparent:${conversation._id}:${moveKey}:${Date.now()}`,
    from_conversation_id: crossUser && sender ? sender._id : undefined,
    human: !sender,
    defer,
  });
  return defer ? "deferred" : "told";
}

// ── A role's triage (org-roles-run-work.md R1) ───────────────────────────────
// A session under a role stays out of its host's needs input. Escalation is
// the one way back in: the role (or a person, with the same gesture on the
// row) puts the session in front of the person with one line saying what they
// will decide, and `clear` takes it back under the role.

export const ESCALATION_LINE_MAX = 200;

export type EscalateSessionResult = {
  ok: true;
  short_id: string;
  conversation_id: Id<"conversations">;
  changed: boolean;
  escalated_by_role: { role_id: Id<"org_roles">; line: string; at: number } | null;
  // Null only for a clear on a session whose role is gone (retired, or the
  // pointer dropped): the stamp is removed and there is no role to name.
  role: { short_id: string; handle: string; name: string } | null;
};

export async function performEscalateSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; line?: string; at?: number; clear?: boolean; from_session?: string },
): Promise<EscalateSessionResult> {
  const fromRef = args.from_session?.trim();
  const caller = fromRef ? await findConversationByAnyRefWhere(ctx, fromRef, async () => true) : null;
  const actor = await resolveActor(ctx, authUserId, caller);
  // A hand that could escalate itself would make the role's triage mean
  // nothing: every session would put itself in front of the person.
  if (actor.kind === "hand") {
    throw new Error(`Your role decides what reaches a person. Tell it why this needs one: cast send @${actor.role?.handle ?? "your-role"} "<why>"`);
  }
  // Who may: the role the session reports to, or a person who could have
  // filed it there (an owner, or a team viewer who may reshape the role).
  const conversation = await findConversationByAnyRefWhere(ctx, args.session_id, async (c: any) => {
    if (actor.kind === "role") return !!c.org_role_id && String(c.org_role_id) === String(actor.role?._id);
    const access = await checkConversationAccess(ctx, authUserId, c);
    if (access === "owner") return true;
    if (access !== "team" || !c.org_role_id) return false;
    const role = await ctx.db.get(c.org_role_id);
    return !!role && await userCanAdminRole(ctx, authUserId, role);
  });
  if (!conversation) throw new Error(actor.kind === "role" ? "Session not found among the sessions that report to you" : "Session not found, or you are not one of its owners");
  const role = conversation.org_role_id ? await ctx.db.get(conversation.org_role_id) : null;
  // A stamp can outlive its role (an old row, a pointer dropped by hand): a
  // clear always succeeds, or the card would sit in needs input for good.
  if (!role && args.clear) {
    if (conversation.escalated_by_role) await ctx.db.patch(conversation._id, { escalated_by_role: undefined });
    return { ok: true as const, short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7), conversation_id: conversation._id, role: null, changed: !!conversation.escalated_by_role, escalated_by_role: null };
  }
  if (!role) throw new Error("That session reports to no role, so it is already in its owner's inbox");

  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  const base = { ok: true as const, short_id: shortId, conversation_id: conversation._id, role: { short_id: role.short_id, handle: role.handle, name: role.name } };
  if (args.clear) {
    if (conversation.escalated_by_role) await ctx.db.patch(conversation._id, { escalated_by_role: undefined });
    return { ...base, changed: !!conversation.escalated_by_role, escalated_by_role: null };
  }
  // The role never escalates silently: its line is the reason on the card. A
  // person's own gesture needs no reason, so it is recorded as theirs.
  const line = (args.line ?? "").replace(/\s+/g, " ").trim().slice(0, ESCALATION_LINE_MAX)
    || (actor.kind === "user" ? `${personName(await ctx.db.get(authUserId))} put this in their inbox` : "");
  if (!line) throw new Error("Say in one line what the person will decide: cast escalate <session> \"<one line>\"");
  // A person's gesture on the web writes the row in a store draft first, and
  // the draft's field lock retires only on an echo equal to it by value, so the
  // web passes the stamp it drafted (the dismissBrowserPaneOffer pattern). A
  // role's own escalation is always stamped here. Only a stamp from the future
  // is refused: a gesture replayed from the offline outbox is honestly old.
  const at = actor.kind === "user" && typeof args.at === "number" && args.at <= Date.now() + 60_000 ? args.at : Date.now();
  const escalated = { role_id: role._id, line, at };
  await ctx.db.patch(conversation._id, { escalated_by_role: escalated });
  await unhide(ctx, conversation);
  return { ...base, changed: conversation.escalated_by_role?.line !== line, escalated_by_role: escalated };
}

// A role that gains scope takes over the sessions in it (R1): every session
// the caller passes that reports to the role's host and to no role is filed
// under the role through the one reparent core, so each is told once and its
// open questions follow the new line. The caller reads the scope (org.ts
// sessionsInScope) and passes the rows, which keeps this module free of the
// scope reader. `dry` counts without writing, for the change's note before it
// is accepted.
export const REHOME_CAP = 100;

export type RehomeResult = {
  // Short ids of the sessions that moved (or would move, when dry).
  sessions: string[];
  // Of those, the ones that stay in front of the person: a question to a
  // person was open at the takeover, so the card keeps its place.
  kept_in_front: string[];
  // Eligible sessions past the cap, left where they are for the next apply.
  over_cap: number;
  told: { sessions: number; roles: number; deferred: number };
};

// One takeover is one row of the org log (org-staffing.md S21): each session
// the loop moves folds into the row of the change that caused it, and the
// counts land beside them. On its own, the takeover is the row.
export async function performRehomeSessions(ctx: { db: any }, authUserId: Id<"users">, role: any, candidates: Array<{ raw: any }>, opts: { note?: string; dry?: boolean; from_session?: string } = {}): Promise<RehomeResult> {
  if (opts.dry) return rehomeSessions(ctx, authUserId, role, candidates, opts);
  return withOrgChange(ctx, authUserId, { kind: "scope", subject: roleSubject(role) }, async () => {
    const result = await rehomeSessions(ctx, authUserId, role, candidates, opts);
    if (result.sessions.length) {
      await noteOrgChange(ctx, authUserId, whereOfRole(role), {
        kind: "scope",
        subject: roleSubject(role),
        effects: { takeover: { role_id: String(role._id), handle: role.handle, sessions: [], kept_in_front: result.kept_in_front, over_cap: result.over_cap, told: result.told } },
      });
    }
    return result;
  });
}

async function rehomeSessions(
  ctx: { db: any },
  authUserId: Id<"users">,
  role: any,
  candidates: Array<{ raw: any }>,
  opts: { note?: string; dry?: boolean; from_session?: string } = {},
): Promise<RehomeResult> {
  const result: RehomeResult = { sessions: [], kept_in_front: [], over_cap: 0, told: { sessions: 0, roles: 0, deferred: 0 } };
  const eligible: any[] = [];
  for (const { raw: c } of candidates) {
    if (!c.org_role_id && !c.standing_role_id && !c.anchor_id
      && String(c.owner_user_id ?? c.user_id) === String(role.host_user_id)
      && await roleMayHoldSession(ctx, role, c)) eligible.push(c);
  }
  result.over_cap = Math.max(0, eligible.length - REHOME_CAP);
  // The role, the admin check, the acting person and the sender are the same
  // for every session of one takeover: resolved once, never per session.
  const batch = opts.dry || eligible.length === 0 ? null : await prepareReparentBatch(ctx, authUserId, role._id.toString(), opts.from_session);
  for (const c of eligible.slice(0, REHOME_CAP)) {
    const shortId = c.short_id ?? c._id.toString().slice(0, 7);
    const openAsk = await ctx.db
      .query("session_decisions")
      .withIndex("by_conversation_status", (q: any) => q.eq("conversation_id", c._id).eq("status", "pending"))
      .first();
    result.sessions.push(shortId);
    if (openAsk) result.kept_in_front.push(shortId);
    if (opts.dry) continue;
    const moved = await performReparentSession(ctx, authUserId, {
      session_id: c._id.toString(),
      target: { kind: "role", role_id: role._id.toString() },
      note: opts.note,
      from_session: opts.from_session,
    }, { batch: batch!, row: c });
    result.told.sessions += moved.told.sessions;
    result.told.deferred += moved.told.deferred ?? 0;
    if (openAsk) {
      await ctx.db.patch(c._id, { escalated_by_role: { role_id: role._id, line: "A question to you was open when this session moved", at: Date.now() } });
    }
  }
  return result;
}

// ── The ownership menu's entry points ────────────────────────────────────────
// Thin names over the core, kept so the mutations, `cast own`/`cast disown`
// and the tests read as the gesture they perform.

// Replace the owner set wholesale (empty list = disown everyone). Backs the web
// multi-select, where the UI holds the full desired set.
export async function performSetSessionOwners(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owners: string[]; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: args.owners, mode: "set" }, note: args.note, from_session: args.from_session });
}

// Add ONE owner without disturbing the others (`cast own`).
export async function performAddSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: [args.owner], mode: "add" }, note: args.note, from_session: args.from_session });
}

// Remove ONE owner, leaving the rest (`cast disown`; defaults to self).
export async function performRemoveSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; from_session?: string },
): Promise<ReparentSessionResult> {
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: [args.owner], mode: "remove" }, from_session: args.from_session });
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
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return { ok: true as const, short_id: result.short_id, owner: result.owners[0] ?? null };
  },
});

// Replace the whole owner set — backs the web multi-select.
export const setSessionOwners = mutation({
  args: {
    session_id: SESSION_REF,
    owners: v.array(v.string()),
    note: v.optional(v.string()),
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await performSetSessionOwners(ctx, authUserId, {
      session_id: args.session_id,
      owners: args.owners,
      note: args.note?.trim() || undefined,
      from_session: args.from_session,
    });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId, args.note?.trim());
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

// Add one owner, leaving existing owners in place (`cast own`).
export const addSessionOwner = mutation({
  args: {
    session_id: SESSION_REF,
    owner: v.optional(OWNER_REF), // default: claim for the caller
    note: v.optional(v.string()), // optional handoff message shown to the assignee
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await performAddSessionOwner(ctx, authUserId, {
      session_id: args.session_id,
      owner: args.owner?.trim() || "me",
      note: args.note?.trim() || undefined,
      from_session: args.from_session,
    });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId, args.note?.trim());
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

// Put a role's session in front of the person, or take it back (`cast
// escalate`, and the row's Put in my inbox / Hand back gestures).
export const escalateSession = mutation({
  args: {
    session_id: SESSION_REF,
    line: v.optional(v.string()),
    clear: v.optional(v.boolean()),
    at: v.optional(v.number()),
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    return performEscalateSession(ctx, authUserId, args);
  },
});

// The assignee acknowledges a handoff: stamps seen_at on THEIR OWN owner row,
// which retires the "assigned to you" banner and the inbox row's assigned ping.
// Idempotent; a no-op when the caller isn't an owner.
export const ackSessionAssignment = mutation({
  args: { session_id: SESSION_REF, api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const conversation = await findOwnableConversation(ctx, authUserId, args.session_id);
    if (!conversation) return { ok: false as const };
    const row = await ctx.db
      .query("session_owners")
      .withIndex("by_conversation_user", (q: any) =>
        q.eq("conversation_id", conversation._id).eq("user_id", authUserId))
      .first();
    if (row && !row.seen_at) await ctx.db.patch(row._id, { seen_at: Date.now() });
    return { ok: true as const };
  },
});

// Remove one owner, leaving the rest (`cast disown`).
export const removeSessionOwner = mutation({
  args: {
    session_id: SESSION_REF,
    owner: v.optional(OWNER_REF), // default: remove the caller
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await performRemoveSessionOwner(ctx, authUserId, {
      session_id: args.session_id,
      owner: args.owner?.trim() || "me",
      from_session: args.from_session,
    });
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

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

const toOwnerCandidate = (u: any): OwnerCandidate => ({
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
async function ownerCandidatesFor(
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

// The owner SET for one session — chips, the "assigned to you" banner, ack
// state. Fetched on demand for a single open session, so the inbox list never
// pays a per-row lookup. Deliberately does NOT include the picker roster:
// that collect is bounded but still N user-doc reads, and this query is
// live-subscribed for as long as the thread is open. Returns null (never
// throws) when the ref doesn't resolve to an accessible session: the web
// subscribes while a session is open, and it legitimately races creation —
// an optimistic stub's client UUID only resolves once the server row syncs.
export async function performListOwners(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<{
  short_id: string;
  conversation_id: Id<"conversations">;
  owners: OwnerInfo[];
} | null> {
  const conversation = await findOwnableConversation(ctx, authUserId, sessionId);
  if (!conversation) return null;
  const owners = await listOwnerInfos(ctx, conversation._id);
  if (owners.length === 0) {
    const starter = await humanStarterUser(ctx, conversation);
    if (starter) {
      const startedAt = conversation.started_at ?? conversation._creationTime ?? Date.now();
      owners.push({
        ...toOwnerInfo(starter),
        added_by: starter._id.toString(),
        added_by_name: starter.name ?? starter.email ?? null,
        added_at: startedAt,
        seen_at: startedAt,
        image: avatarOf(starter),
        added_by_image: avatarOf(starter),
      });
    }
  }
  return {
    short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7),
    conversation_id: conversation._id,
    owners,
  };
}

export const listOwners = query({
  args: { session_id: SESSION_REF, api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    // A missing session-cookie (guest, stale tab) is "no data", not a thrown
    // error: useQuery rethrows those and unmounts ConversationView. CLI tokens
    // still fail loudly so `cast owners` doesn't print an empty set for a
    // bad token.
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      if (args.api_token) throw new Error("Authentication failed: invalid token or session");
      return null;
    }
    return performListOwners(ctx, authUserId, args.session_id);
  },
});

// Picker roster — session team's members, not the viewer's active team.
// Subscribed only while the assignment menu is open, never for the banner
// or the header chip.
export async function performListOwnerCandidates(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
): Promise<{
  conversation_id: Id<"conversations">;
  team_members: OwnerCandidate[];
} | null> {
  const conversation = await findOwnableConversation(ctx, authUserId, sessionId);
  if (!conversation) return null;
  return {
    conversation_id: conversation._id,
    team_members: await ownerCandidatesFor(ctx, authUserId, conversation),
  };
}

export const listOwnerCandidates = query({
  args: { session_id: SESSION_REF, api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      if (args.api_token) throw new Error("Authentication failed: invalid token or session");
      return null;
    }
    return performListOwnerCandidates(ctx, authUserId, args.session_id);
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
