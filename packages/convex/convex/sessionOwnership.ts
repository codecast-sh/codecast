import { mutation, query, internalMutation, internalAction } from "./functions";
import { isTeamOwnedConversation } from "./lib/viewerTriage";
import { roleRunner } from "./lib/seatPlace";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { buildShareUpdate, checkConversationAccess } from "./privacy";
import { patchConversationVisibility } from "./lib/conversationVisibility";
import { requireTeamFeature } from "./lib/teamFeatureGuard";
import {
  addSessionTeamOwnerRow,
  listSessionPartyIds,
  listSessionTeamOwnerIds,
  removeSessionTeamOwnerRow,
  teamPeopleIds,
  addSessionOwnerRow,
  removeSessionOwnerRow,
  listSessionOwnerIds,
  syncPrimaryOwnerCache,
  humanStarterUser,
  ownersModelOn,
  sessionOwnerFactsOf,
  type OwnerRowSnapshot,
} from "./sessionOwners";
import { mayEditOwners, ownersOf } from "@codecast/shared/contracts/sessionOwners";
import { assertHumanOwner, assertRoleMayOwn, ownerCandidatesFor, ownersChangeFor, resolveOwnerRef, writeOwnersChange, type OwnerCandidate } from "./lib/ownersChange";
import { originRead } from "./lib/ownersOrigin";
export { OWNER_CANDIDATE_CAP, type OwnerCandidate } from "./lib/ownersChange";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { notifySessionAssigned, notifySessionOwnershipChanged } from "./sessionAssignmentNotifications";
import { routeUpWaitingSession } from "./agentTasks";
import { requireRole, userCanAdminRole } from "./lib/orgAccess";
import { holdChangeFor, type HoldChange } from "./lib/orgOwnership";
import { resolveActor } from "./lib/actor";
import { reroutePendingDecisionsForConversation } from "./sessionDecisions";
import { movedFields } from "@codecast/shared/contracts/orgChange";
import { findOwnableConversation, personName, roleMayHoldSession, tellSession } from "./lib/sessionTell";
import { reportsToKey, reportsToLine, reportsToOf, type ReportsTo } from "./lib/reportsTo";
export { reportsToLine, type ReportsTo };
export { personName, roleMayHoldSession };
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
  // The team whose every member owns the session (the `everyone` owner ref),
  // and the people this call newly reached by sharing it with them: who to
  // notify beyond `added`.
  team: TeamOwnerInfo | null;
  shared_with: Id<"users">[];
};

export type TeamOwnerInfo = { team_id: string; name: string; added_by: string; added_at: number; note: string | null };

// The owner ref that means "everyone on the session's team".
export function isEveryoneRef(ref: string): boolean {
  return ref.trim().toLowerCase() === "everyone";
}

async function teamOwnerInfo(ctx: { db: any }, conversationId: Id<"conversations">): Promise<TeamOwnerInfo | null> {
  const row = await ctx.db
    .query("session_team_owners")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conversationId))
    .first();
  if (!row) return null;
  const team = await ctx.db.get(row.team_id);
  return { team_id: String(row.team_id), name: team?.name ?? "the team", added_by: String(row.added_by), added_at: row.added_at, note: row.note ?? null };
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
  // `hold` says why the role holds it (org-staffing.md S35): `bound`, the
  // rule moved it for the work it is bound to, so a binding may move it
  // again; `filed` (default), a person or role put it there, so only a
  // person or role moves it.
  | { kind: "role"; role_id: string; hold?: "bound" | "filed" }
  // The owner model's one change (session_owners feature, shared
  // contracts/sessionOwners): people by ref, rows put back by an undo, the
  // role (a ref replaces it, null takes it off) and the parent's release.
  // `take_over` takes every agent owner off and makes the caller an owner;
  // `adopt_parent` (a session ref) makes it that session's worker;
  // `restore_parent` puts back the parent a release or take-over let go.
  | { kind: "owners"; add?: string[]; remove?: string[]; restore?: OwnerRowSnapshot[]; role?: string | null; release_parent?: boolean; restore_parent?: boolean; take_over?: boolean; adopt_parent?: string; detach_parent?: boolean };

export type ReparentSessionResult = OwnerMutationResult & {
  org_role_id: Id<"org_roles"> | null;
  reports_to: ReportsTo | null;
  // What the mutation told: the session itself (one message) and, for a
  // session move, never a role. `deferred` counts a session too stale to wake
  // for one sentence: the line waits and it reads it when it next runs. The
  // web says it in one toast.
  told: { sessions: number; roles: number; deferred?: number };
};

// The line every reparent delivers (org-staffing.md S11). It says what the
// move changes for the agent: under a role, how to reach it; under a person,
// that their questions now go to them. `note` is written to the agent; a
// `handoff` note was written to the new owner (the ownership menu, `cast own`)
// and is quoted as theirs, so the agent does not read it as its own orders.
// Take the previous holder's triage off a row that is being put in front of
// someone: a handoff to a new owner. Only a stamp that
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
// writes; conversations are never read through it. `ownersModel` is
// ownersModelOn read once per team (or runner) for the batch.
export type ReparentBatch = {
  role: any;
  canReshape: boolean;
  actor: any;
  sender: any | null;
  read: (id: any) => Promise<any>;
  ownersModel: (conversation: any) => Promise<boolean>;
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
  const models = new Map<string, Promise<boolean>>();
  const modelKey = (c: any) => (c.team_id ? `team:${c.team_id}` : `user:${c.user_id}`);
  const ownersModel = (c: any) => models.get(modelKey(c)) ?? models.set(modelKey(c), ownersModelOn(ctx, c)).get(modelKey(c))!;
  const fromRef = fromSession?.trim();
  return {
    role,
    canReshape: await userCanAdminRole(ctx, authUserId, role),
    actor: await read(authUserId),
    sender: fromRef ? await findOwnableConversation(ctx, authUserId, fromRef) : null,
    read,
    ownersModel,
  };
}

export async function performReparentSession(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; target: ReparentSessionTarget; note?: string; handoff?: string; from_session?: string },
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
  args: { session_id: string; target: ReparentSessionTarget; note?: string; handoff?: string; from_session?: string },
  known?: { batch: ReparentBatch; row: any },
): Promise<ReparentSessionResult> {
  const note = args.note?.trim() || undefined;
  const handoff = args.handoff?.trim() || undefined;
  const targetRole = args.target.kind === "role" ? known?.batch.role ?? await requireRole(ctx, authUserId, args.target.role_id, "access") : null;
  const canReshapeTarget = known ? known.batch.canReshape : targetRole ? await userCanAdminRole(ctx, authUserId, targetRole) : false;
  // Who may file: a person target is the ownership rule (the runner, or any
  // teammate who can see the session); a role target is an owner, or a team
  // viewer who may reshape the role. A session the caller cannot see, never.
  const mayFileUnderRole = async (c: any) => {
    const access = await checkConversationAccess(ctx, authUserId, c);
    return access === "owner" || (access === "team" && canReshapeTarget);
  };
  const conversation = args.target.kind === "user" || args.target.kind === "owners"
    ? await resolveOwnableConversation(ctx, authUserId, args.session_id)
    : known ? ((await mayFileUnderRole(known.row)) ? known.row : null)
    : await findConversationByAnyRefWhere(ctx, args.session_id, mayFileUnderRole);
  if (!conversation) throw new Error("Session not found, or you are not one of its owners");
  // A standing session IS a seat; it reports to no seat (org-roles-standing.md
  // T1). Filed under a role it would count as that role's hand, be interrupted
  // by a pause and spend its hand cap. One refusal here, so every door (the
  // chart, the ownership menu, the CLI) inherits it.
  const setsRole = args.target.kind === "role" || (args.target.kind === "owners" && !!args.target.role);
  if (setsRole && (conversation.standing_role_id || conversation.anchor_id)) {
    throw new Error("That session is a standing agent's own thread; it cannot be filed under a role");
  }
  // A role's own session is owned by whom the role reports to (S28,
  // sessionOwners.stampSeatOwners), so its owner changes only by moving the
  // role. One writer keeps the chart line and the inbox from disagreeing.
  if ((args.target.kind === "user" || args.target.kind === "owners") && conversation.standing_role_id) {
    const seatRole = await ctx.db.get(conversation.standing_role_id);
    throw new Error(`That is @${seatRole?.handle ?? "the role"}'s own session: it belongs to whoever the role reports to. Change who the role reports to instead (cast org reparent @${seatRole?.handle ?? "<role>"} --to <person or @role>, or the role page).`);
  }
  // A session of another team keeps the older refusal below; this one is for a
  // session routed to the role's team that the team cannot see.
  if (targetRole?.team_id && String(conversation.team_id ?? "") === String(targetRole.team_id) && !(await roleMayHoldSession(ctx, targetRole, conversation))) {
    throw new Error(`That session is private to you, and @${targetRole.handle} is a role your team can read; share the session with the team first, or keep it under you`);
  }
  const ownersModel = await (known ? known.batch.ownersModel(conversation) : ownersModelOn(ctx, conversation));
  rememberOrgRecord(ctx, conversation);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  const before = await reportsToOf(ctx, conversation._id, conversation.org_role_id, { read: known?.batch.read, row: conversation, ownersModel });
  const parentBefore = await sessionParent(ctx, conversation);

  const added: Id<"users">[] = [];
  const removed: Id<"users">[] = [];
  const sharedWith: Id<"users">[] = [];
  let owners: OwnerInfo[];
  let roleId: Id<"org_roles"> | undefined = conversation.org_role_id;
  // An adopt, its undo's detach, or a restore hands the session's standing wait on
  // (writeOwnersChange): the line telling it so must not answer that wait.
  let adopted = false;

  if (ownersModel) {
    const change = await ownersChangeFor(ctx, authUserId, conversation, args.target, targetRole);
    adopted = !!(change.adoptParent || change.detachParent || change.restoreParent);
    const res = await writeOwnersChange(ctx, authUserId, conversation, change, {
      // The chart's drop on a role keeps its own access rule (mayFileUnderRole).
      checkEdit: args.target.kind !== "role",
      note: handoff ?? note,
      hold: args.target.kind === "role" ? args.target.hold ?? "filed" : "filed",
    });
    added.push(...res.added);
    removed.push(...res.removed);
    roleId = res.roleId;
    if (added.length > 0) await unhide(ctx, conversation);
    owners = await listOwnerInfos(ctx, conversation._id);
  } else if (args.target.kind === "user") {
    // A bare `user_id` is the chart's drop on a person: it ADDS that person
    // and re-homes the session under them (S11), so a session two people own
    // does not silently lose the other. The owner list form is the picker's,
    // which holds the whole desired set.
    const mode = args.target.mode ?? (args.target.owners ? "set" : "add");
    const refs = args.target.owners ?? (args.target.user_id ? [args.target.user_id.toString()] : []);
    const desiredKeys = new Set<string>();
    const desired: any[] = [];
    let everyone = false;
    let namedTeam: Id<"teams"> | undefined;
    for (const ref of refs) {
      const trimmed = ref.trim();
      if (!trimmed) continue;
      if (isEveryoneRef(trimmed)) { everyone = true; continue; }
      // A recorded team owner (`team:<id>`, the org log's form): everyone on that team.
      // Only the session's own team: a team ref never moves a session elsewhere.
      if (trimmed.startsWith("team:")) {
        if (!trimmed.slice(5) || trimmed.slice(5) !== String(conversation.team_id ?? "")) throw new Error("A session can only be shared with everyone on its own team");
        everyone = true; namedTeam = trimmed.slice(5) as Id<"teams">; continue;
      }
      const user = await resolveOwnerRef(ctx, authUserId, conversation, trimmed);
      if (mode !== "remove") assertHumanOwner(user);
      const key = user._id.toString();
      if (desiredKeys.has(key)) continue;
      desiredKeys.add(key);
      desired.push(user);
    }
    // Everyone on the session's team: one team owner row. Adding it needs the
    // session to be on a team the caller belongs to, the rule an owner ref of
    // a teammate follows.
    // A session with no team yet takes the team sharing it would give its
    // RUNNER (buildShareUpdate for the account that runs it), never the
    // caller's: a co-owner cannot carry someone's session into their own team.
    let teamId = (namedTeam ?? conversation.team_id) as Id<"teams"> | undefined;
    if (everyone && mode !== "remove" && !teamId) teamId = (await buildShareUpdate(ctx as any, conversation, conversation.user_id)).team_id;
    if (everyone && mode !== "remove") {
      if (!teamId) throw new Error(`Session ${shortId} has no team, so there is no everyone to share it with`);
      await requireTeamFeature(ctx as any, teamId, "team_sessions");
      const member = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_team", (q: any) => q.eq("user_id", authUserId).eq("team_id", teamId))
        .first();
      if (!member) throw new Error("You are not a member of this session's team");
      // A session the runner locked private is theirs alone to open to the team.
      if (conversation.team_visibility === "private" && String(authUserId) !== String(conversation.user_id)) {
        throw new Error("Only the person running this session can share it, since they made it private");
      }
      // The team replaces the person owners, so each of them must be on it, or
      // they lose their own session (a teamless session an agent account runs
      // resolves to the agent's team, which its people may not share).
      for (const ownerId of await listSessionOwnerIds(ctx, conversation._id)) {
        if ((await ctx.db.get(ownerId))?.is_bot) continue;
        const onTeam = await ctx.db
          .query("team_memberships")
          .withIndex("by_user_team", (q: any) => q.eq("user_id", ownerId).eq("team_id", teamId))
          .first();
        if (!onTeam) throw new Error("Every owner must be on the team before it becomes a team session");
      }
      const reachedBefore = new Set((await listSessionPartyIds(ctx, conversation._id)).map(String));
      if (await addSessionTeamOwnerRow(ctx, conversation._id, teamId, authUserId, handoff ?? note)) {
        for (const id of await teamPeopleIds(ctx, teamId)) if (!reachedBefore.has(String(id))) sharedWith.push(id);
        // A team session is always the team's to read, whole.
        await patchConversationVisibility(ctx as any, conversation, { team_id: teamId, is_private: false, team_visibility: "full", auto_shared: undefined }, authUserId);
      }
    } else if (mode === "remove" ? everyone : mode === "set" || desired.length > 0) {
      // Personal again: a set without everyone, or a person added to it.
      // Every team row goes, whatever team the session is on now.
      for (const tid of await listSessionTeamOwnerIds(ctx, conversation._id)) await removeSessionTeamOwnerRow(ctx, conversation._id, tid);
    }
    // The team and people never own a session together (team sessions spec:
    // a team session has no person owners). Adding the team takes every
    // person row off, so each member's triage is their own row for all of them.
    if (everyone && mode !== "remove") {
      desired.length = 0;
      desiredKeys.clear();
      for (const ownerId of await listSessionOwnerIds(ctx, conversation._id)) {
        if (await removeSessionOwnerRow(ctx, conversation._id, ownerId)) removed.push(ownerId);
      }
    }
    if (mode === "remove") {
      for (const user of desired) {
        if (await removeSessionOwnerRow(ctx, conversation._id, user._id)) removed.push(user._id);
      }
    } else {
      for (const user of desired) {
        if (await addSessionOwnerRow(ctx, conversation._id, user._id, authUserId, handoff ?? note)) added.push(user._id);
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
    if (added.length > 0 || sharedWith.length > 0) await unhide(ctx, conversation);
    // The session reports to the person this act named: `add` hands it to the
    // added person (a handoff, the chart follows), `set` to the LAST listed —
    // callers put the person the act names at the end of `owners`. A remove
    // leaves the line to whoever remains, oldest first.
    const preferred = mode === "remove" ? undefined : desired[desired.length - 1]?._id;
    // Also the conversation write that re-stamps its access grants, so a team
    // owner added or removed reaches the team's sync scope.
    await syncPrimaryOwnerCache(ctx, conversation._id, preferred);
    // A person is now the parent: the role pointer comes off (S11). A remove
    // is not a re-homing, so a session filed under a role stays there.
    if (mode !== "remove" && desired.length > 0 && roleId) {
      await ctx.db.patch(conversation._id, { org_role_id: undefined, org_role_hold: undefined });
      roleId = undefined;
    }
    owners = mode === "set" ? desired.map(toOwnerInfo) : await listOwnerInfos(ctx, conversation._id);
  } else if (args.target.kind === "role") {
    assertRoleMayOwn(conversation, targetRole);
    await ctx.db.patch(conversation._id, { org_role_id: targetRole._id, org_role_hold: args.target.hold ?? "filed" });
    roleId = targetRole._id;
    owners = await listOwnerInfos(ctx, conversation._id);
  } else {
    // An owners change is the owner model's alone.
    throw new Error(teamFeatureOffMessage("session_owners"));
  }

  const after = await reportsToOf(ctx, conversation._id, roleId, { read: known?.batch.read, ownersModel });
  const told: { sessions: number; roles: number; deferred?: number } = { sessions: 0, roles: 0 };
  if (after && reportsToKey(after) !== reportsToKey(before)) {
    const how = await tellSession(ctx, authUserId, conversation, reportsToLine(after, { note, handoff }), args.from_session, reportsToKey(after), known?.batch, { keepsWait: adopted });
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
    team: await teamOwnerInfo(ctx, conversation._id),
    shared_with: sharedWith,
    org_role_id: roleId ?? null,
    reports_to: after,
    told,
  };
}

// ── A role's sessions (org-roles-run-work.md R1, org-staffing.md S28) ───────
// A session under a role stays out of its host's needs input. What it needs
// from a person travels up the reporting line as messages: the hand tells its
// role, a role tells the role it reports to, and the role that reports to a
// person raises it in its own standing thread. Nothing on the row lifts it.

// A role that gains scope takes over the sessions in it (R1): every session
// the caller passes that reports to the role's host is filed under the role
// through the one reparent core, so each is told once and its open questions
// follow the new line. The caller reads the scope (org.ts sessionsInScope)
// and, with `by_rule`, passes only the sessions the role owns by the one
// ownership rule (lib/orgOwnership sessionsOwnedBy), which may take a session
// from a wider role; without it a session another role holds never moves.
// That keeps this module free of the scope reader and of the rule. `dry` counts without writing, for the change's note before it
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
export async function performRehomeSessions(ctx: { db: any }, authUserId: Id<"users">, role: any, candidates: Array<{ raw: any }>, opts: { note?: string; dry?: boolean; from_session?: string; by_rule?: boolean } = {}): Promise<RehomeResult> {
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
  ctx: { db: any; scheduler?: any },
  authUserId: Id<"users">,
  role: any,
  candidates: Array<{ raw: any }>,
  opts: { note?: string; dry?: boolean; from_session?: string; by_rule?: boolean } = {},
): Promise<RehomeResult> {
  const result: RehomeResult = { sessions: [], kept_in_front: [], over_cap: 0, told: { sessions: 0, roles: 0, deferred: 0 } };
  const eligible: any[] = [];
  const runner = String(await roleRunner(ctx, role));
  for (const { raw: c } of candidates) {
    if ((opts.by_rule ? String(c.org_role_id ?? "") !== String(role._id ?? "") : !c.org_role_id) && !c.standing_role_id && !c.anchor_id
      && String(c.owner_user_id ?? c.user_id) === runner
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
      target: { kind: "role", role_id: role._id.toString(), hold: opts.by_rule ? "bound" : "filed" },
      note: opts.note,
      from_session: opts.from_session,
    }, { batch: batch!, row: c });
    result.told.sessions += moved.told.sessions;
    result.told.deferred += moved.told.deferred ?? 0;
    // A question to the person was open when the session moved: the role
    // that now holds it hears so at once (S28), the way a blocked hand tells
    // its role, and answers or passes it up.
    if (openAsk) {
      const movedRow = await ctx.db.get(c._id);
      if (movedRow) await routeUpWaitingSession(ctx, movedRow, { why: "question", since: openAsk.created_at ?? openAsk._creationTime });
    }
    // A moved session that already waits settled before it had a role to
    // tell: its needs-input check runs again, as a role's resume does, so the
    // role hears it, or the person does when the role cannot be told.
    await ctx.scheduler?.runAfter(0, internal.notifications.checkNeedsInput, { conversation_id: c._id });
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
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: args.owners, mode: "set" }, handoff: args.note, from_session: args.from_session });
}

// Add ONE owner without disturbing the others (`cast own`). An `@role` makes
// that role the session's role (the session_owners feature only).
export async function performAddSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const target: ReparentSessionTarget = args.owner.trim().startsWith("@")
    ? { kind: "owners", role: args.owner.trim() }
    : { kind: "user", owners: [args.owner], mode: "add" };
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target, handoff: args.note, from_session: args.from_session });
}

// Remove ONE owner, leaving the rest (`cast disown`; defaults to self). Under
// the session_owners feature, `@role` takes its role off and `parent`
// releases its parent session, each alone (taking it over is `take_over`).
export const PARENT_OWNER_REF = "parent";

export async function performRemoveSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const ref = args.owner.trim();
  let target: ReparentSessionTarget = { kind: "user", owners: [args.owner], mode: "remove" };
  if (ref.startsWith("@") || ref.toLowerCase() === PARENT_OWNER_REF) {
    const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
    if (!(await ownersModelOn(ctx, conversation))) throw new Error(teamFeatureOffMessage("session_owners"));
    const owners = ownersOf(await sessionOwnerFactsOf(ctx, conversation));
    if (ref.startsWith("@")) {
      const role = owners.role ? await ctx.db.get(owners.role) : null;
      if (!role || role.handle !== ref.slice(1).toLowerCase()) throw new Error(`${ref} does not own this session`);
      target = { kind: "owners", role: null };
    } else {
      if (!owners.parentSession) throw new Error("No parent session owns this session");
      target = { kind: "owners", release_parent: true };
    }
  }
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target, from_session: args.from_session });
}

// The owners Save, `cast own --take-over` and Take it over under the
// session_owners feature: one change, one transaction (shared
// contracts/sessionOwners applyOwnersChangeTo is the rule). Refused cleanly
// when the session's team does not have the feature.
export async function performApplyOwnersChange(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; add?: string[]; remove?: string[]; restore?: OwnerRowSnapshot[]; role?: string | null; release_parent?: boolean; restore_parent?: boolean; take_over?: boolean; adopt_parent?: string; detach_parent?: boolean; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const { session_id, note, from_session, ...change } = args;
  return performReparentSession(ctx, authUserId, { session_id, target: { kind: "owners", ...change }, handoff: note, from_session });
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
    await notifySessionAssigned(ctx, result.conversation_id, [...result.added, ...result.shared_with], authUserId);
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
    await notifySessionAssigned(ctx, result.conversation_id, [...result.added, ...result.shared_with], authUserId, args.note?.trim());
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
    await notifySessionAssigned(ctx, result.conversation_id, [...result.added, ...result.shared_with], authUserId, args.note?.trim());
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
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

// One owners change under the session_owners feature (performApplyOwnersChange).
export const applyOwnersChange = mutation({
  args: {
    session_id: SESSION_REF,
    add: v.optional(v.array(OWNER_REF)),
    remove: v.optional(v.array(OWNER_REF)),
    restore: v.optional(v.array(v.object({
      user_id: v.string(),
      added_by: v.string(),
      added_at: v.number(),
      seen_at: v.optional(v.number()),
      note: v.optional(v.string()),
    }))),
    // A role ref (@handle, or-N, id) replaces the role; null takes it off.
    role: v.optional(v.union(v.string(), v.null())),
    release_parent: v.optional(v.boolean()),
    // Put back the parent a release or take-over let go.
    restore_parent: v.optional(v.boolean()),
    // Take it over: every agent owner comes off and the caller becomes an owner.
    take_over: v.optional(v.boolean()),
    // Make it the worker of this session (a session ref): the dragger's own row comes off.
    adopt_parent: v.optional(v.string()),
    // Out from under any parent, link and release gone (an adopt's undo).
    detach_parent: v.optional(v.boolean()),
    note: v.optional(v.string()),
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { api_token, ...rest } = args;
    const authUserId = await requireAuth(ctx, api_token);
    const result = await performApplyOwnersChange(ctx, authUserId, { ...rest, note: rest.note?.trim() || undefined });
    await notifySessionAssigned(ctx, result.conversation_id, result.added, authUserId, rest.note?.trim());
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

// The owner SET for one session — chips, the "assigned to you" banner, ack
// state. Fetched on demand for a single open session, so the inbox list never
// pays a per-row lookup. Deliberately does NOT include the picker roster:
// that collect is bounded but still N user-doc reads, and this query is
// live-subscribed for as long as the thread is open. Returns null (never
// throws) when the ref doesn't resolve to an accessible session: the web
// subscribes while a session is open, and it legitimately races creation —
// an optimistic stub's client UUID only resolves once the server row syncs.
// Under the session_owners feature the read also names the session's role,
// its parent session and its implicit starter apart (shared ownersOf), and
// whether the viewer may edit them. `owners` stays the people list a
// person-only reader shows: the rows, else the implicit starter.
export type OwnersModelRead = {
  session_owners: true;
  people: OwnerInfo[];
  role: { role_id: string; short_id: string | null; handle: string; name: string } | null;
  parent_session: { conversation_id: string; short_id: string; title: string | null } | null;
  /** Where it came from, which the owners menu offers back first: the parent
   *  a person released it from (only when the viewer may put it back), the
   *  role an owners change took off it, and the session that spawned it
   *  (`adoptable`: the viewer may make it that session's worker). Read for an
   *  open conversation only (listOwners), never for the inbox cards: the
   *  spawner's row changes with every message it streams. */
  released_parent?: { conversation_id: string; short_id: string; title: string | null } | null;
  released_role?: { role_id: string; short_id: string | null; handle: string; name: string } | null;
  spawned_by?: { conversation_id: string; short_id: string; title: string | null; adoptable: boolean } | null;
  implicit_starter: (OwnerInfo & { implicit: true }) | null;
  /** The human who started it (shared SessionOwnerFacts.starter) and whether
   *  a role started it: what a client needs to paint an owners change by the
   *  shared rule before the server answers. */
  starter_id: string | null;
  role_started: boolean;
  can_edit: boolean;
  owners_changed_at: number | null;
};

function starterInfo(conversation: any, starter: any): OwnerInfo {
  const startedAt = conversation.started_at ?? conversation._creationTime ?? Date.now();
  return {
    ...toOwnerInfo(starter),
    added_by: starter._id.toString(),
    added_by_name: starter.name ?? starter.email ?? null,
    added_at: startedAt,
    seen_at: startedAt,
    image: avatarOf(starter),
    added_by_image: avatarOf(starter),
  };
}

export async function performListOwners(
  ctx: { db: any },
  authUserId: Id<"users">,
  sessionId: string,
  opts: { origin?: boolean } = {},
): Promise<({
  short_id: string;
  conversation_id: Id<"conversations">;
  owners: OwnerInfo[];
  team: TeamOwnerInfo | null;
} & (OwnersModelRead | { session_owners?: undefined })) | null> {
  const conversation = await findOwnableConversation(ctx, authUserId, sessionId);
  if (!conversation) return null;
  const short_id = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  const owners = await listOwnerInfos(ctx, conversation._id);
  const team = await teamOwnerInfo(ctx, conversation._id);
  if (await ownersModelOn(ctx, conversation)) {
    return { short_id, conversation_id: conversation._id, team, ...(await ownersModelRead(ctx, authUserId, conversation, owners, !!opts.origin)) };
  }
  if (owners.length === 0 && !team) {
    const starter = await humanStarterUser(ctx, conversation);
    if (starter) owners.push(starterInfo(conversation, starter));
  }
  return { short_id, conversation_id: conversation._id, owners, team };
}

async function ownersModelRead(ctx: { db: any }, authUserId: Id<"users">, conversation: any, people: OwnerInfo[], origin: boolean): Promise<OwnersModelRead & { owners: OwnerInfo[] }> {
  const facts = await sessionOwnerFactsOf(ctx, conversation);
  const o = ownersOf(facts);
  const starter = o.implicitStarter ? await ctx.db.get(o.implicitStarter) : null;
  const implicit_starter = starter ? { ...starterInfo(conversation, starter), implicit: true as const } : null;
  const roleDoc = o.role ? await ctx.db.get(o.role) : null;
  const parent = o.parentSession ? await ctx.db.get(o.parentSession) : null;
  // A session the viewer cannot read is named by its id alone.
  const titleFor = async (c: any) => {
    const access = await checkConversationAccess(ctx, authUserId, c);
    return access === "owner" || access === "team" ? c.title ?? null : null;
  };
  return {
    session_owners: true,
    owners: implicit_starter ? [...people, implicit_starter] : people,
    people,
    role: roleDoc ? { role_id: String(roleDoc._id), short_id: roleDoc.short_id ?? null, handle: roleDoc.handle, name: roleDoc.name } : null,
    parent_session: o.parentSession
      ? { conversation_id: o.parentSession, short_id: parent?.short_id ?? o.parentSession.slice(0, 7), title: parent ? await titleFor(parent) : null }
      : null,
    ...(origin ? await originRead(ctx, authUserId, conversation, facts, o.role, titleFor) : {}),
    implicit_starter,
    starter_id: facts.starter,
    role_started: !!facts.role_started,
    can_edit: mayEditOwners(facts, String(authUserId)),
    owners_changed_at: conversation.owners_changed_at ?? null,
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
    return performListOwners(ctx, authUserId, args.session_id, { origin: true });
  },
});

// The owners of many sessions at once, for the faces on inbox cards: an inbox
// row carries no owner list (lib/inboxOwners), so the cards on screen read
// them here in one query, by conversation id (a direct read each). Each id
// goes through the same access chokepoint as listOwners
// (findOwnableConversation); one the caller cannot read is left out, never an
// error. At most LIST_OWNERS_FOR_CAP ids are read; the rest are left out the
// same way, so a caller asks for what is on screen. A bad token throws, as
// listOwners does.
export const LIST_OWNERS_FOR_CAP = 60;

export async function performListOwnersFor(ctx: { db: any }, authUserId: Id<"users">, conversationIds: ReadonlyArray<Id<"conversations"> | string>) {
  const ids = [...new Set(conversationIds.map(String))].slice(0, LIST_OWNERS_FOR_CAP);
  const reads = await Promise.all(ids.map((id) => performListOwners(ctx, authUserId, id).catch(() => null)));
  const out: Record<string, NonNullable<Awaited<ReturnType<typeof performListOwners>>>> = {};
  for (const read of reads) if (read) out[String(read.conversation_id)] = read;
  return out;
}

export const listOwnersFor = query({
  args: { conversation_ids: v.array(v.id("conversations")), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!authUserId) {
      if (args.api_token) throw new Error("Authentication failed: invalid token or session");
      return {};
    }
    return performListOwnersFor(ctx, authUserId, args.conversation_ids);
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
//   packages/convex/run.sh sessionOwnership:runBackfillSessionOwners '{}'
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
//   packages/convex/run.sh sessionOwnership:runBackfillSessionOwners '{}'
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

// ── The hold a binding gives or takes (org-staffing.md S35) ─────────────────
//
// Scheduled (never awaited) by every site that changes what a session is
// bound to: a task start, a task closed, a plan bound or unbound, a session
// created on a task. lib/orgOwnership holdChangeFor reads the rule; this
// applies it through the one reparent core, so the session and the role are
// told as a takeover tells them, the org log has the row, and the hold is
// stamped `bound` so a later binding may move it again. A release re-homes
// the session under whoever started it (`add` keeps its other owners).
const BOUND_NOTE = "It looks after the work this session is bound to. It reads what you need first and decides what reaches a person.";

export async function applyHoldChange(ctx: { db: any; scheduler?: any }, conversationId: Id<"conversations">): Promise<{ change: HoldChange["kind"]; role?: string }> {
  const c = await ctx.db.get(conversationId);
  // A team session is the team's: no background move files it under a role
  // or hands it to a person (team sessions spec).
  if (c && await isTeamOwnedConversation(ctx, c._id, c)) return { change: "keep" };
  const change = await holdChangeFor(ctx, c);
  // Under the owner model a role owner takes a session from its starter, so a binding never files one no role started.
  const model = change.kind !== "keep" && await ownersModelOn(ctx, c);
  if (change.kind === "keep" || (model && change.kind !== "release" && !c.role_started)) return { change: "keep" };
  const actor = c.owner_user_id ?? c.user_id;
  if (change.kind === "release") {
    // Under the owner model a person target keeps the role, so the release names the role coming off.
    const target: ReparentSessionTarget = model ? { kind: "owners", role: null } : { kind: "user", user_id: actor, mode: "add" };
    await performReparentSession(ctx, actor, { session_id: String(c._id), target, note: `Its work is no longer in @${change.from.handle ?? "the role"}'s area.` });
    return { change: "release", role: change.from.handle };
  }
  await performReparentSession(ctx, actor, { session_id: String(c._id), target: { kind: "role", role_id: String(change.role._id), hold: "bound" }, note: BOUND_NOTE });
  return { change: change.kind, role: change.role.handle };
}

export const reconcileHold = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => applyHoldChange(ctx, args.conversation_id),
});

/** Queue the hold check for a session whose binding just changed. */
export const scheduleHoldCheck = (ctx: { scheduler?: any }, conversationId: any) =>
  ctx.scheduler?.runAfter(0, internal.sessionOwnership.reconcileHold, { conversation_id: conversationId });
