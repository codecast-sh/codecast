import { mutation, query, internalMutation, internalAction } from "./functions";
import { roleRunner } from "./lib/seatPlace";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { checkConversationAccess } from "./privacy";
import { addSessionOwnerRow, removeSessionOwnerRow, listSessionOwnerIds, ownersFactsOf, syncPrimaryOwnerCache, humanStarterUser, restoreOwnerRows, writeDriver, type OwnerRowSnapshot } from "./sessionOwners";
import { isLeave, leaveMovesFirst, listedOwnerIds, pinnedDriverAfterAdd, starterOf } from "@codecast/shared/contracts/sessionOwners";
import {
  assertHumanOwner, avatarOf, driverOf, listOwnerInfos, mayEditOwners, ownerIdsOrStarter, OWNER_CANDIDATE_CAP, resolveOwnableConversation,
  LEAVE_MOVE_REFUSAL, ownerNamed, resolveOwnerRef, resolveOwnerRoleRef, settleLeave, teamMemberDocs, toOwnerInfo, withLeaveRules, type DriverTarget, type OwnerInfo, type OwnerMutationResult, type SessionDriver,
} from "./lib/sessionOwnerRules";
import { notifySessionAssigned, notifySessionOwnershipChanged } from "./sessionAssignmentNotifications";
import { routeUpWaitingSession } from "./agentTasks";
import { requireRole, userCanAdminRole } from "./lib/orgAccess";
import { holdChangeFor, type HoldChange } from "./lib/orgOwnership";
import { resolveActor } from "./lib/actor";
import { reroutePendingDecisionsForConversation } from "./sessionDecisions";
import { movedFields } from "@codecast/shared/contracts/orgChange";
import { findOwnableConversation, personName, roleMayHoldSession, tellSession } from "./lib/sessionTell";
import { performReparentSessionToDevice } from "./devices";
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

// ── The reparent core (org-staffing.md S11) ──────────────────────────────────
// Who a session reports to is one gesture everywhere: the ownership menu
// (take ownership, add an owner, remove one, replace the set), `cast own` /
// `cast disown`, and dragging a session on the org chart all land here. It is
// the ONE place session_owners and conversations.org_role_id change together.
// A role is an owner beside the people: an owners-list target (the ownership
// menu, `cast own`) changes only the person set and keeps the role; a bare
// `user_id` target (the chart's drop on a person, a hold's release) re-homes
// the session under that person and takes the role off. A role target sets
// the one role (replacing any other) and makes it the driver; a `null` role
// takes it off. Every move that changes
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
  // `drop_role` takes the role off as well; it defaults to on for the bare
  // `user_id` form and off for the owners list.
  | { kind: "user"; user_id?: Id<"users">; owners?: string[]; mode?: "set" | "add" | "remove"; drop_role?: boolean }
  // `hold` says why the role holds it (org-staffing.md S35): `bound`, the
  // rule moved it for the work it is bound to, so a binding may move it
  // again; `filed` (default), a person or role put it there, so only a
  // person or role moves it. `role_id: null` removes the role.
  | { kind: "role"; role_id: string | null; hold?: "bound" | "filed" };

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

// The line every reparent delivers (org-staffing.md S11). It says what the
// move changes for the agent: under a role, how to reach it; under a person,
// that their questions now go to them. `note` is written to the agent; a
// `handoff` note was written to the new owner (the ownership menu, `cast own`)
// and is quoted as theirs, so the agent does not read it as its own orders.
export function reportsToLine(to: ReportsTo, opts: { note?: string; handoff?: string } = {}): string {
  const head = to.kind === "role"
    ? `You now report to ${to.name} (@${to.handle}): what you need from a person goes to it first, and \`cast send @${to.handle}\` reaches it.`
    : `You now report to ${to.name}: your questions and decisions go to them.`;
  const note = opts.note?.trim();
  const handoff = opts.handoff?.trim();
  return [head, note, handoff && `Note handed to ${to.name} with this session: "${handoff}"`].filter(Boolean).join(" ");
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

const reportsToKey = (r: ReportsTo | null): string => !r ? "" : r.kind === "role" ? `role:${r.role_id}` : `user:${r.user_id}`;

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
    sender: fromRef ? await findOwnableConversation(ctx, authUserId, fromRef) : null,
    read,
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
  const targetRole = args.target.kind === "role" && args.target.role_id ? known?.batch.role ?? await requireRole(ctx, authUserId, args.target.role_id, "access") : null;
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
  if (targetRole && (conversation.standing_role_id || conversation.anchor_id)) {
    throw new Error("That session is a standing agent's own thread; it cannot be filed under a role");
  }
  // A role's own session is owned by whom the role reports to (S28,
  // sessionOwners.stampSeatOwners), so its owner changes only by moving the
  // role. One writer keeps the chart line and the inbox from disagreeing.
  if (args.target.kind === "user" && conversation.standing_role_id) {
    const seatRole = await ctx.db.get(conversation.standing_role_id);
    throw new Error(`That is @${seatRole?.handle ?? "the role"}'s own session: it belongs to whoever the role reports to. Change who the role reports to instead (cast org reparent @${seatRole?.handle ?? "<role>"} --to <person or @role>, or the role page).`);
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
    const dropRole = args.target.drop_role ?? !!args.target.user_id;
    // Who drives before the change: an owners-list change never moves the
    // wheel to the person it adds, even though the primary owner follows them.
    const factsBefore = dropRole ? null : await ownersFactsOf(ctx, conversation);
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
      // The person who started a session owns it before any row exists. An
      // owners-list add writes that row first, so adding a teammate never
      // takes the session out of its starter's inbox. A run a role started
      // has no starter (shared starterOf), so it gives nobody a row.
      if (mode === "add" && factsBefore && factsBefore.rows.length === 0) {
        const starter = starterOf(factsBefore);
        if (starter && !desiredKeys.has(starter)) await addSessionOwnerRow(ctx, conversation._id, starter as Id<"users">, starter as Id<"users">);
      }
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
    if (added.length > 0) await unhide(ctx, conversation);
    // The session reports to the person this act named: `add` hands it to the
    // added person (a handoff, the chart follows), `set` to the LAST listed —
    // callers put the person the act names at the end of `owners`. A remove
    // leaves the line to whoever remains, oldest first.
    const preferred = mode === "remove" ? undefined : desired[desired.length - 1]?._id;
    await syncPrimaryOwnerCache(ctx, conversation._id, preferred);
    if (factsBefore && mode !== "remove") {
      const pin = pinnedDriverAfterAdd(factsBefore, await ownersFactsOf(ctx, (await ctx.db.get(conversation._id)) ?? conversation));
      if (pin) await writeDriver(ctx, conversation._id, pin);
    }
    // A re-homing under a person (the chart's drop, a release) takes the role
    // off; adding owners from the menu keeps it, since a role is an owner too.
    if (dropRole && mode !== "remove" && desired.length > 0 && roleId) {
      await ctx.db.patch(conversation._id, { org_role_id: undefined, org_role_hold: undefined });
      roleId = undefined;
    }
    owners = mode === "set" ? desired.map(toOwnerInfo) : await listOwnerInfos(ctx, conversation._id);
  } else if (!targetRole) {
    if (roleId) await ctx.db.patch(conversation._id, { org_role_id: undefined, org_role_hold: undefined });
    roleId = undefined;
    owners = await listOwnerInfos(ctx, conversation._id);
  } else {
    if (targetRole.status === "retired") throw new Error("That role is retired");
    // A team role only takes sessions routed to its team; a personal role
    // takes anything its owner may reparent.
    if (targetRole.team_id && (conversation.team_id?.toString() ?? null) !== targetRole.team_id.toString()) {
      throw new Error("That session is not in the role's team");
    }
    // One role at a time, and the role it is filed under drives.
    await ctx.db.patch(conversation._id, { org_role_id: targetRole._id, org_role_hold: args.target.hold ?? "filed", driver_user_id: undefined });
    roleId = targetRole._id;
    owners = await listOwnerInfos(ctx, conversation._id);
  }

  const after = await reportsToOf(ctx, conversation._id, roleId, { read: known?.batch.read });
  const told: { sessions: number; roles: number; deferred?: number } = { sessions: 0, roles: 0 };
  if (after && reportsToKey(after) !== reportsToKey(before)) {
    const how = await tellSession(ctx, authUserId, conversation, reportsToLine(after, { note, handoff }), args.from_session, reportsToKey(after), known?.batch);
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

// Changing who owns a session is for its owners and the account that runs
// it (mayEditOwners), whichever door it comes by; the owners menu Save
// (performApplyOwnersChange) holds the same rule. The callers below exempt
// claiming it yourself and leaving it.
const OWNERS_EDIT_REFUSAL = "Only an owner of the session, or the account that runs it, can change its owners";
async function requireOwnersEdit(ctx: { db: any }, authUserId: Id<"users">, conversation: any): Promise<void> {
  if (!(await mayEditOwners(ctx, authUserId, conversation))) throw new Error(OWNERS_EDIT_REFUSAL);
}

// Replace the owner set wholesale (empty list = disown everyone): `cast
// disown --all` and scripts. A set that leaves the caller out is their leave.
export async function performSetSessionOwners(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owners: string[]; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const named: string[] = [];
  for (const ref of args.owners.map((o) => o.trim()).filter(Boolean)) {
    const user = await resolveOwnerRef(ctx, authUserId, conversation, ref);
    assertHumanOwner(user);
    named.push(String(user._id));
  }
  // Claiming a session nobody owns yet, as its only owner, is a claim.
  const me = String(authUserId);
  const selfClaim = named.length > 0 && named.every((id) => id === me) && (await ownerIdsOrStarter(ctx, conversation)).every((id) => id === me);
  if (!selfClaim) await requireOwnersEdit(ctx, authUserId, conversation);
  return withLeaveRules(ctx, authUserId, args.session_id, () =>
    performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: args.owners, mode: "set" }, handoff: args.note, from_session: args.from_session }));
}

// Add ONE owner without disturbing the others (`cast own`).
export async function performAddSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; note?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const owner = await resolveOwnerRef(ctx, authUserId, conversation, args.owner.trim());
  assertHumanOwner(owner);
  if (String(owner?._id) !== String(authUserId)) await requireOwnersEdit(ctx, authUserId, conversation);
  return performReparentSession(ctx, authUserId, { session_id: args.session_id, target: { kind: "user", owners: [args.owner], mode: "add" }, handoff: args.note, from_session: args.from_session });
}

// Remove ONE owner, leaving the rest (`cast disown`; defaults to self).
// Removing yourself is a leave.
export async function performRemoveSessionOwner(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; owner: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const owner = await resolveOwnerRef(ctx, authUserId, conversation, args.owner.trim());
  if (String(owner?._id) === String(authUserId)) {
    return performLeaveSession(ctx, authUserId, { session_id: String(conversation._id), from_session: args.from_session });
  }
  await requireOwnersEdit(ctx, authUserId, conversation);
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

// Every driver change outside the reparent core (which reroutes as it ends):
// the wheel moves (sessionOwners.writeDriver), and the session's open
// questions follow it; a paused role hears none (sessionDecisions routeFor).
async function setDriver(ctx: { db: any }, conversationId: Id<"conversations">, userId: string | null): Promise<void> {
  if (await writeDriver(ctx, conversationId, userId)) await reroutePendingDecisionsForConversation(ctx, conversationId, Date.now());
}

// Hand the wheel to the filed role or to one of the people who own it. A
// person must already own the session (or be its human starter while nobody
// does); a role must be the one it is filed under.
export async function performSetSessionDriver(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; driver: DriverTarget },
): Promise<{ ok: true; short_id: string; conversation_id: Id<"conversations">; driver: SessionDriver | null }> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const shortId = conversation.short_id ?? conversation._id.toString().slice(0, 7);
  if (!(await mayEditOwners(ctx, authUserId, conversation))) throw new Error("Only an owner of the session, or the account that runs it, can change who drives it");
  if (args.driver.kind === "none") {
    await setDriver(ctx, conversation._id, null);
    const driver = driverOf({ ...conversation, driver_user_id: undefined }, await ownerIdsOrStarter(ctx, conversation));
    return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: driver! };
  }
  if (args.driver.kind === "role") {
    if (!conversation.org_role_id) throw new Error(`Session ${shortId} is not filed under a role, so no role can drive it`);
    await setDriver(ctx, conversation._id, null);
    return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: { kind: "role", role_id: conversation.org_role_id } };
  }
  const ownerIds = await ownerIdsOrStarter(ctx, conversation);
  // The web passes an owner's id; `cast own --drive` passes a person as typed.
  const ref = args.driver.user_id;
  let userId = ownerIds.includes(ref) ? ref : null;
  if (!userId && ref.trim().toLowerCase() !== "me") userId = await ownerNamed(ctx, ownerIds, ref);
  userId ??= String((await resolveOwnerRef(ctx, authUserId, conversation, ref))._id);
  if (!ownerIds.includes(userId)) throw new Error("Only an owner of the session can drive it; add them as an owner first");
  await setDriver(ctx, conversation._id, userId);
  return { ok: true, short_id: shortId, conversation_id: conversation._id, driver: { kind: "user", user_id: userId as Id<"users"> } };
}

// Leave a session: take yourself out of its owners. A session that runs on
// your account moves first, to a machine another account runs (a teammate's
// shared machine or an agent box), in the same transaction, so nobody is left
// owning a session that still bills to someone who left. When nobody else
// owns it, the person whose account now runs it takes a row, so the starter
// rule cannot hand it back to a leaver who started it; refused when there is
// no such person. shared/contracts/sessionOwners applyOwnersChangeTo is the
// same rule, run by the web store before this lands.
export async function performLeaveSession(
  ctx: { db: any; scheduler?: any },
  authUserId: Id<"users">,
  args: { session_id: string; move_to_device_id?: string; from_session?: string },
): Promise<ReparentSessionResult> {
  const conversation = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  const me = String(authUserId);
  if (!(await ownerIdsOrStarter(ctx, conversation)).includes(me)) throw new Error("You are not one of its owners");
  if (!args.move_to_device_id && leaveMovesFirst(await ownersFactsOf(ctx, conversation), me)) throw new Error(LEAVE_MOVE_REFUSAL);
  if (args.move_to_device_id) {
    const moved = await performReparentSessionToDevice(ctx, authUserId, { session_id: String(conversation._id), device_id: args.move_to_device_id });
    if (!moved.cross_user) throw new Error("That machine runs on your account: pick a teammate's or a team machine to leave it");
  }
  const result = await performReparentSession(ctx, authUserId, { session_id: String(conversation._id), target: { kind: "user", owners: [me], mode: "remove" }, from_session: args.from_session });
  await settleLeave(ctx, authUserId, await ctx.db.get(conversation._id));
  return result;
}

// One Save of the owners menu: people added and removed, the role set,
// replaced or taken off (`role` undefined leaves it), and who drives, applied
// in one transaction through the reparent core so each part keeps its tell,
// its notification and its org-log row. Adds land first so a newly added
// person can be made driver; the driver is set last so it wins over the
// role's claim to drive.
export type OwnersChange = {
  add?: string[];
  remove?: string[];
  // Rows put back as they were (an undo of a remove): their order returns,
  // and nobody is told of a handoff again.
  restore?: OwnerRowSnapshot[];
  role?: string | null;
  driver?: DriverTarget;
  // Leave last: after the rest of the change lands.
  leave?: { move_to_device_id?: string };
  note?: string;
};

export async function performApplyOwnersChange(
  ctx: { db: any },
  authUserId: Id<"users">,
  args: { session_id: string; change: OwnersChange; from_session?: string },
): Promise<{ results: ReparentSessionResult[]; driver: SessionDriver | null }> {
  const { change } = args;
  const results: ReparentSessionResult[] = [];
  // A teammate who can see the session may still claim it for themselves.
  const selfClaim = change.add?.length === 1 && change.add[0] === String(authUserId) && !change.remove?.length && !change.restore?.length && change.role === undefined && !change.driver && !change.leave;
  const start = await resolveOwnableConversation(ctx, authUserId, args.session_id);
  if (!selfClaim && !(await mayEditOwners(ctx, authUserId, start))) {
    throw new Error(OWNERS_EDIT_REFUSAL);
  }
  const run = (target: ReparentSessionTarget) => performReparentSession(ctx, authUserId, { session_id: args.session_id, target, handoff: change.note, from_session: args.from_session });
  if (change.add?.length) results.push(await run({ kind: "user", owners: change.add, mode: "add" }));
  if (change.restore?.length) await restoreOwnerRows(ctx, start._id, change.restore);
  if (change.role !== undefined) {
    const role = change.role === null ? null : await resolveOwnerRoleRef(ctx, authUserId, start, change.role);
    const before = await resolveOwnableConversation(ctx, authUserId, args.session_id);
    if (String(before.org_role_id ?? "") !== String(role ?? "")) results.push(await run({ kind: "role", role_id: role }));
  }
  // Taking yourself out is a leave, whichever way the change says it.
  const others = (change.remove ?? []).filter((id) => id !== String(authUserId));
  if (others.length) results.push(await run({ kind: "user", owners: others, mode: "remove" }));
  if (change.driver) await performSetSessionDriver(ctx, authUserId, { session_id: args.session_id, driver: change.driver });
  if (isLeave(change, String(authUserId))) results.push(await performLeaveSession(ctx, authUserId, { session_id: args.session_id, move_to_device_id: change.leave?.move_to_device_id, from_session: args.from_session }));
  // Read by id: after a leave the caller may no longer see it.
  const conversation = await ctx.db.get(start._id);
  return { results, driver: driverOf(conversation, await ownerIdsOrStarter(ctx, conversation)) };
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

const DRIVER_TARGET = v.union(v.object({ kind: v.literal("role") }), v.object({ kind: v.literal("user"), user_id: v.string() }), v.object({ kind: v.literal("none") }));

// Who drives: the filed role, or one of the people who own it.
export const setSessionDriver = mutation({
  args: {
    session_id: SESSION_REF,
    driver: DRIVER_TARGET,
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => performSetSessionDriver(ctx, await requireAuth(ctx, args.api_token), { session_id: args.session_id, driver: args.driver }),
});

// Leave a session, moving it off your account first when it runs there.
export const leaveSession = mutation({
  args: { session_id: SESSION_REF, move_to_device_id: v.optional(v.string()), from_session: v.optional(v.string()), api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const result = await withOrgChange(ctx, authUserId, { kind: "session", door: args.from_session ? "cli" : "chart", gesture: args.from_session ? "command" : "drag" }, () =>
      performLeaveSession(ctx, authUserId, { session_id: args.session_id, move_to_device_id: args.move_to_device_id, from_session: args.from_session }));
    await notifySessionOwnershipChanged(ctx, result.conversation_id, result, authUserId);
    return result;
  },
});

// The owners menu's Save: the whole change in one transaction.
export const applyOwnersChange = mutation({
  args: {
    session_id: SESSION_REF,
    change: v.object({
      add: v.optional(v.array(v.string())),
      remove: v.optional(v.array(v.string())),
      restore: v.optional(v.array(v.object({ user_id: v.string(), added_by: v.string(), added_at: v.number(), seen_at: v.optional(v.number()), note: v.optional(v.string()) }))),
      role: v.optional(v.union(v.string(), v.null())),
      driver: v.optional(DRIVER_TARGET),
      leave: v.optional(v.object({ move_to_device_id: v.optional(v.string()) })),
      note: v.optional(v.string()),
    }),
    from_session: v.optional(v.string()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const authUserId = await requireAuth(ctx, args.api_token);
    const out = await withOrgChange(ctx, authUserId, { kind: "session", door: args.from_session ? "cli" : "chart", gesture: args.from_session ? "command" : "drag" }, () =>
      performApplyOwnersChange(ctx, authUserId, { session_id: args.session_id, change: args.change, from_session: args.from_session }));
    for (const r of out.results) {
      await notifySessionAssigned(ctx, r.conversation_id, r.added, authUserId, args.change.note?.trim());
      await notifySessionOwnershipChanged(ctx, r.conversation_id, r, authUserId);
    }
    const last = out.results[out.results.length - 1];
    return { told: out.results.reduce((t, r) => ({ sessions: t.sessions + r.told.sessions, roles: t.roles + r.told.roles, deferred: (t.deferred ?? 0) + (r.told.deferred ?? 0) }), { sessions: 0, roles: 0, deferred: 0 }), reports_to: last?.reports_to ?? null, short_id: last?.short_id ?? null, driver: out.driver };
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
  owner_ids: string[];
  role: OwnerRole | null;
  role_id: string | null;
  driver: SessionDriver | null;
  driver_user_id: string | null;
  runner: OwnerRunner | null;
  author_id: string | null;
  bots: string[];
  role_started: boolean;
  can_edit: boolean;
} | null> {
  const conversation = await findOwnableConversation(ctx, authUserId, sessionId);
  if (!conversation) return null;
  const facts = await ownersFactsOf(ctx, conversation);
  const owners = await listOwnerInfos(ctx, conversation._id);
  const starterId = owners.length === 0 ? starterOf(facts) : null;
  if (starterId) {
    const starter = await ctx.db.get(starterId as Id<"users">);
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
        // No row: the starter owns it by the starter rule, not by a row.
        implicit: true,
      });
    }
  }
  const roleDoc = conversation.org_role_id ? await ctx.db.get(conversation.org_role_id) : null;
  const role: OwnerRole | null = roleDoc ? {
    role_id: roleDoc._id,
    short_id: roleDoc.short_id,
    handle: roleDoc.handle,
    name: roleDoc.name,
    avatar: roleDoc.avatar ?? null,
    hold: conversation.org_role_hold ?? "filed",
  } : null;
  const runnerDoc = await ctx.db.get(conversation.user_id);
  const runner: OwnerRunner | null = runnerDoc ? {
    ...toOwnerInfo(runnerDoc),
    image: avatarOf(runnerDoc),
    is_bot: !!runnerDoc.is_bot,
  } : null;
  return {
    short_id: conversation.short_id ?? conversation._id.toString().slice(0, 7),
    conversation_id: conversation._id,
    owners,
    owner_ids: listedOwnerIds(facts),
    role,
    role_id: role ? String(role.role_id) : null,
    driver: driverOf(roleDoc ? conversation : { ...conversation, org_role_id: undefined }, owners.map((o) => o.user_id)),
    driver_user_id: conversation.driver_user_id ? String(conversation.driver_user_id) : null,
    runner,
    author_id: facts.author_id,
    bots: facts.bots,
    role_started: facts.role_started,
    can_edit: String(conversation.user_id) === String(authUserId) || owners.some((o) => o.user_id === String(authUserId)),
  };
}

// The role owner as the owners menu draws it: its face and how it holds the
// session. At most one per session (conversations.org_role_id).
export type OwnerRole = {
  role_id: Id<"org_roles">;
  short_id: string;
  handle: string;
  name: string;
  avatar: string | null;
  hold: "bound" | "filed";
};

// The account that runs the session: always shown, marked as the runner,
// whether or not it is also an owner.
export type OwnerRunner = OwnerInfo & { is_bot: boolean };

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
  const change = await holdChangeFor(ctx, c);
  if (change.kind === "keep") return { change: "keep" };
  const actor = c.owner_user_id ?? c.user_id;
  if (change.kind === "release") {
    await performReparentSession(ctx, actor, { session_id: String(c._id), target: { kind: "user", user_id: actor, mode: "add" }, note: `Its work is no longer in @${change.from.handle ?? "the role"}'s area.` });
    // With no role left, nobody is paused: the driver clears.
    const after = await ctx.db.get(conversationId);
    if (after && !after.org_role_id && after.driver_user_id) await setDriver(ctx, conversationId, null);
    return { change: "release", role: change.from.handle };
  }
  await performReparentSession(ctx, actor, { session_id: String(c._id), target: { kind: "role", role_id: String(change.role._id), hold: "bound" }, note: BOUND_NOTE });
  // A binding is implicit: the person who started the session keeps driving
  // it (org-roles-run-work.md R1). Deliberate filing (the owners menu, the
  // chart, a scope takeover) never comes here, so the role drives those.
  if (!c.role_started) {
    const person = await humanStarterUser(ctx, c);
    if (person) await setDriver(ctx, conversationId, String(person._id));
  }
  return { change: change.kind, role: change.role.handle };
}

export const reconcileHold = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => applyHoldChange(ctx, args.conversation_id),
});

/** Queue the hold check for a session whose binding just changed. */
export const scheduleHoldCheck = (ctx: { scheduler?: any }, conversationId: any) =>
  ctx.scheduler?.runAfter(0, internal.sessionOwnership.reconcileHold, { conversation_id: conversationId });
