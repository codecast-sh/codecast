// Centralized owner-or-team access layer for Convex functions.
//
// Wave-1 strangler-fig seed: the canonical home for "can this user touch this
// entity" checks. The task/doc/plan helpers moved here from their old files
// (tasks.ts, docs.ts, plans.ts), which now re-export them so every existing
// caller keeps working unchanged. The conversation sibling follows the same
// owner-or-team shape but routes through privacy.ts because conversation access
// is materially more nuanced than tasks/docs/plans (see below).

import { Doc, Id } from "../_generated/dataModel";
import { findConversationBySessionReference } from "../conversationSessionLookup";
import { canOwnerOrTeamAccess, isTeamMember, teamVisibleConvTeam } from "../privacy";
import { forbidden, notFound } from "./auth";
import { roleDropForVisibility } from "../sessionOwnership";
import {
  accessStampFor,
  accessStampFromDoc,
  authorizedFor,
  computeWorkspaceKey,
  computeWorkspaceKeyDb,
  heldKeysFor,
  linkedConversationId,
  parseWorkspaceKey,
  resolveWorkspaceKey,
  workspaceGrantsAccess,
  workspaceKey,
  type AccessStamp,
  type AuthorizedWorkspace,
  type WorkspaceKey,
} from "./accessKeys";
// The keys and their evaluators are one layer to every caller.
export * from "./accessKeys";

// Re-exported so callers that want the membership primitive can reach it through
// the access layer too (canAccessDoc uses it directly).
export { isTeamMember };

type AccessCtx = { db: any };

// ── Owner-or-workspace: tasks, docs, plans, projects ──
// One rule: the owner always has access; anyone else has access iff the row's
// stored ACCESS key (`workspace`) names a team they belong to. Task assignment
// is also an explicit grant. team_id is ROUTING and is never consulted here —
// see the workspace-key section below.

// Ctx-bound evaluator with the same rule as authorizedFor, short-circuiting on
// owner/grant before touching memberships. A property test pins the two
// evaluators to each other (syncLog.test.ts).
async function authorizedForCtx(ctx: AccessCtx, stamp: AccessStamp | null, userId: Id<"users">): Promise<boolean> {
  if (!stamp?.access_owner) return false;
  const uid = String(userId);
  if (stamp.access_owner === uid) return true;
  if (stamp.access_grants?.includes(uid)) return true;
  return await workspaceGrantsAccess(ctx, userId, stamp.access_key);
}

export async function canAccessTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  return authorizedForCtx(ctx, await accessStampFor(ctx, "tasks", task), userId);
}

export async function canAccessProject(
  ctx: AccessCtx,
  userId: Id<"users">,
  project: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): Promise<boolean> {
  return authorizedForCtx(ctx, await accessStampFor(ctx, "projects", project), userId);
}

// An initiative's update has no rule of its own: callers pass the PARENT
// initiative, so an update can never be readable where its initiative is not.
export async function canAccessInitiative(
  ctx: AccessCtx,
  userId: Id<"users">,
  initiative: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): Promise<boolean> {
  return authorizedForCtx(ctx, await accessStampFor(ctx, "initiatives", initiative), userId);
}

/**
 * List-channel visibility for a row read off a TEAM routing index (webList and
 * webListPaginated team branches): the same stamp rule, with a sync fast path
 * for rows carrying their stored key so a 300-row page costs no reads. Rows
 * minted before the backfill fall back to the async check. This is what keeps
 * the bootstrap floor and the sync log's projection in agreement on a task with
 * team_id T but workspace user:<owner> (private inside a team).
 */
export async function visibleInTeamList(
  ctx: AccessCtx,
  userId: Id<"users">,
  table: string,
  row: any,
  teamId: Id<"teams"> | string,
): Promise<boolean> {
  const stamp = accessStampFromDoc(table, row);
  if (stamp?.access_key) {
    return authorizedFor(stamp, String(userId), new Set([`user:${String(userId)}`, `team:${String(teamId)}`]));
  }
  return authorizedForCtx(ctx, await accessStampFor(ctx, table, row), userId);
}


export async function canAccessPullRequest(
  ctx: AccessCtx,
  userId: Id<"users">,
  pullRequest: { team_id: Id<"teams"> },
): Promise<boolean> {
  return await isTeamMember(ctx, userId, pullRequest.team_id);
}

/**
 * A commit is readable through whichever provenance it has.
 *
 * A commit written from a session transcript carries conversation_id, and the
 * session decides who may read it. A commit that arrived by webhook or backfill
 * has no session, so it falls back to the team the GitHub App is installed for.
 * Neither path is a guess: the row records which one applies, and a commit with
 * neither is readable by nobody.
 */
export async function canAccessCommit(
  ctx: AccessCtx & { db: any },
  userId: Id<"users">,
  commit: { conversation_id?: Id<"conversations">; team_id?: Id<"teams"> },
): Promise<boolean> {
  if (commit.conversation_id) {
    const conversation = await ctx.db.get(commit.conversation_id);
    if (conversation && (await canAccessConversation(ctx, userId, conversation))) return true;
  }
  return commit.team_id ? await isTeamMember(ctx, userId, commit.team_id) : false;
}

/** Resolve the membership row or fail closed for an explicitly requested team. */
export async function requireTeamMembership(
  ctx: AccessCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<any> {
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
  if (!membership) forbidden("Forbidden: team membership required");
  return membership;
}

/**
 * The team a user is working in right now: the team they are looking at
 * (`active_team_id`), else their home team, counted only with a live
 * membership row behind it. The user row keeps pointing at a team after
 * membership lapses (routing ≠ visibility), so the pointer alone proves
 * nothing. Null when the user is in no team they belong to.
 */
export async function activeTeamMembershipFor(
  ctx: AccessCtx,
  userId: Id<"users">,
): Promise<{ teamId: Id<"teams">; membership: any } | null> {
  const user = await ctx.db.get(userId);
  const teamId = (user?.active_team_id ?? user?.team_id) as Id<"teams"> | undefined;
  if (!teamId) return null;
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId))
    .first();
  return membership ? { teamId, membership } : null;
}

export async function requireTeamAdmin(
  ctx: AccessCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<any> {
  const membership = await requireTeamMembership(ctx, userId, teamId);
  if (membership.role !== "admin") forbidden("Forbidden: team admin required");
  return membership;
}

/**
 * Patch a conversation's visibility fields AND propagate the resulting access
 * key to linked work items in one call. Every visibility-changing write
 * (share, unshare, lock private, late path restamp, reparent) MUST go through
 * here — a raw ctx.db.patch of is_private / team_visibility / team_id /
 * auto_shared leaves linked tasks/plans/docs with a stale stored key.
 * Returns the number of work items rewritten.
 */
export async function patchConversationVisibility(
  ctx: AccessCtx,
  conversation: {
    _id: Id<"conversations">;
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
  updates: Record<string, any>,
): Promise<number> {
  // A team role may hold only a session its team can see: a session that
  // stops being visible leaves the role, and its escalation, in this same
  // patch (org-roles-run-work.md R1, revised). A static import: the Convex
  // runtime refuses a dynamic import() ("dynamic module import unsupported"),
  // which took every share, unshare and lock-private write down with it on
  // 2026-09-22. The graph cycles (ownership → functions → changeLog → here)
  // and that is fine under ESM because nothing on the cycle reads a binding
  // at module load; convex/moduleLoad.test.ts imports every entry to prove it.
  // A static import. The Convex runtime refuses a dynamic import() ("dynamic
  // module import unsupported"), which took every share, unshare, lock-private
  // and retroactive directory share down with it from 2026-09-22. The graph
  // cycles (ownership → functions → changeLog → accessKeys, never back here),
  // and convex/moduleLoad.test.ts imports every entry to keep it that way.
  const drop = await roleDropForVisibility(ctx, { ...conversation, ...updates });
  await ctx.db.patch(conversation._id, drop ? { ...updates, ...drop.patch } : updates);
  if (drop) await drop.tell();
  const after = { ...conversation, ...updates };
  return recomputeWorkspaceForConversation(ctx, after);
}

// The owner scan below reads up to 12k rows and does not depend on the
// conversation, so one execution scans each owner once. A folder rule backfill
// patches 32 sessions per batch; scanning per session read past the 100 MB
// function limit and the whole backfill failed without a trace. Keyed on the
// execution's db so nothing outlives the mutation that read it.
const ownerScans = new WeakMap<object, Map<string, Promise<any[]>>>();

function ownerLinkedRows(ctx: AccessCtx, userId: Id<"users">): Promise<any[]> {
  let scans = ownerScans.get(ctx.db);
  if (!scans) ownerScans.set(ctx.db, (scans = new Map()));
  let scan = scans.get(String(userId));
  if (!scan) {
    scan = Promise.all(
      ["tasks", "plans", "docs"].map((table) =>
        ctx.db.query(table as any).withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).take(4000),
      ),
    ).then((tables) => tables.flat());
    scans.set(String(userId), scan);
  }
  return scan;
}

/**
 * THE propagation hook: rewrite the stored workspace key of every work item
 * linked to this conversation, after its visibility changed (share, unshare,
 * lock private, late path restamp, fork/reparent inheritance changes). Call it
 * AFTER patching the conversation, passing the POST-patch row.
 *
 * Coverage: direct links come off the reverse indexes; array-only links
 * (conversation_ids / related_conversation_ids) ride the owner scan, since
 * work items link their creator's own conversation. Rows outside both nets
 * (someone else's row linking this conversation via an array) are caught by
 * the workspace reconciler sweep.
 */
export async function recomputeWorkspaceForConversation(
  ctx: AccessCtx,
  conv: {
    _id: Id<"conversations">;
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
): Promise<number> {
  const convId = String(conv._id);
  const seen = new Set<string>();
  const rows: any[] = [];
  const gather = (batch: any[]) => {
    for (const row of batch) {
      const id = String(row._id);
      if (!seen.has(id)) { seen.add(id); rows.push(row); }
    }
  };

  gather(await ctx.db.query("tasks")
    .withIndex("by_created_from_conversation", (q: any) => q.eq("created_from_conversation", conv._id))
    .collect());
  gather(await ctx.db.query("plans")
    .withIndex("by_created_from_conversation_id", (q: any) => q.eq("created_from_conversation_id", conv._id))
    .collect());
  gather(await ctx.db.query("docs")
    .withIndex("by_conversation_id", (q: any) => q.eq("conversation_id", conv._id))
    .collect());
  gather((await ownerLinkedRows(ctx, conv.user_id)).filter((row: any) => linkedConversationId(row) === convId));

  let updated = 0;
  for (const row of rows) {
    if (linkedConversationId(row) !== convId) continue;
    const key = computeWorkspaceKey(row, conv);
    if (row.workspace !== key) {
      await ctx.db.patch(row._id, { workspace: key });
      // The row may be the owner scan's cached copy; keep it true for a later
      // recompute in this execution.
      row.workspace = key;
      updated++;
    }
  }
  return updated;
}

/**
 * The team a record's ACCESS key names, or undefined when it is personal.
 * Thin view over resolveWorkspaceKey for callers that still think in
 * "effective team" terms; new code should compare workspace keys directly.
 */
export async function effectiveTeamForResource(
  ctx: AccessCtx,
  record: { team_id?: Id<"teams">; workspace?: string },
): Promise<Id<"teams"> | undefined> {
  const ws = parseWorkspaceKey(await resolveWorkspaceKey(ctx, record));
  return ws?.type === "team" ? ws.teamId : undefined;
}

/**
 * The workspace a resource lives in for CONTAINMENT (parent/child, plan/task,
 * project/task joins). Stored access key when present; for legacy rows the
 * raw tag, which the backfill makes identical for unlinked rows.
 */
export function workspaceForResource(
  resource: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): AuthorizedWorkspace {
  const stored = parseWorkspaceKey(resource.workspace);
  if (stored) return stored;
  return resource.team_id
    ? { type: "team", teamId: resource.team_id }
    : { type: "personal", userId: resource.user_id };
}

/** Conversation team_id is routing; only a team-visible conversation is team-scoped. */
export function workspaceForConversation(
  conversation: {
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private?: boolean;
    auto_shared?: boolean;
    team_visibility?: string;
  },
): AuthorizedWorkspace {
  const teamId = teamVisibleConvTeam(conversation);
  return teamId
    ? { type: "team", teamId }
    : { type: "personal", userId: conversation.user_id };
}

export function workspacesMatch(
  left: AuthorizedWorkspace,
  right: AuthorizedWorkspace,
): boolean {
  return left.type === "team" && right.type === "team"
    ? String(left.teamId) === String(right.teamId)
    : left.type === "personal" && right.type === "personal"
      ? String(left.userId) === String(right.userId)
      : false;
}

export function requireWorkspaceMatch(
  left: AuthorizedWorkspace,
  right: AuthorizedWorkspace,
  label: string,
): void {
  if (!workspacesMatch(left, right)) {
    forbidden(`Forbidden: ${label} belongs to another workspace`);
  }
}

export function isSameWorkspace(
  resource: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
  workspace: AuthorizedWorkspace,
): boolean {
  return workspacesMatch(workspaceForResource(resource), workspace);
}

/** Relationships may only join resources inside the same authorization domain. */
export function requireSameWorkspace(
  resource: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
  workspace: AuthorizedWorkspace,
  label: string,
): void {
  if (!isSameWorkspace(resource, workspace)) {
    forbidden(`Forbidden: ${label} belongs to another workspace`);
  }
}

export async function requireAccessibleTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  taskId: Id<"tasks">,
): Promise<any> {
  const task = await ctx.db.get(taskId);
  if (!task || !(await canAccessTask(ctx, userId, task))) notFound("Task not found");
  return task;
}

export async function requireAccessiblePlan(
  ctx: AccessCtx,
  userId: Id<"users">,
  planId: Id<"plans">,
): Promise<any> {
  const plan = await ctx.db.get(planId);
  if (!plan || !(await canAccessPlan(ctx, userId, plan))) notFound("Plan not found");
  return plan;
}

export async function requireAccessibleProject(
  ctx: AccessCtx,
  userId: Id<"users">,
  projectId: Id<"projects">,
): Promise<any> {
  const project = await ctx.db.get(projectId);
  if (!project || !(await canAccessProject(ctx, userId, project))) notFound("Project not found");
  return project;
}

export async function requireAccessibleInitiative(
  ctx: AccessCtx,
  userId: Id<"users">,
  initiativeId: Id<"initiatives">,
): Promise<any> {
  const initiative = await ctx.db.get(initiativeId);
  if (!initiative || !(await canAccessInitiative(ctx, userId, initiative))) notFound("Initiative not found");
  return initiative;
}

export async function requireAccessibleDoc(
  ctx: AccessCtx,
  userId: Id<"users">,
  docId: Id<"docs">,
): Promise<any> {
  const doc = await ctx.db.get(docId);
  if (!doc || !(await canAccessDoc(ctx, userId, doc))) notFound("Doc not found");
  return doc;
}

export async function requireAccessibleConversation(
  ctx: AccessCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<any> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
    notFound("Conversation not found");
  }
  return conversation;
}

export async function requireAccessiblePullRequest(
  ctx: AccessCtx,
  userId: Id<"users">,
  pullRequestId: Id<"pull_requests">,
): Promise<any> {
  const pullRequest = await ctx.db.get(pullRequestId);
  if (!pullRequest || !(await canAccessPullRequest(ctx, userId, pullRequest))) {
    notFound("Pull request not found");
  }
  return pullRequest;
}

export async function canAccessDoc(
  ctx: AccessCtx,
  userId: Id<"users">,
  doc: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): Promise<boolean> {
  return authorizedForCtx(ctx, await accessStampFor(ctx, "docs", doc), userId);
}

export async function canAccessPlan(
  ctx: AccessCtx,
  userId: Id<"users">,
  plan: any,
): Promise<boolean> {
  return authorizedForCtx(ctx, await accessStampFor(ctx, "plans", plan), userId);
}

// ── Owner-or-team: conversations (faithful, NOT oversimplified) ──
// Conversations do NOT use the plain owner-or-team rule above. team_id is
// routing — it's stamped even on private conversations — so "team member" alone
// is not enough. A teammate gets access only when the conversation is actually
// team-visible (is_private:false or a team_visibility override, AND the owner
// hasn't opted out of sharing). This is exactly the rule every conversation
// caller already enforces (comments.ts, messages.ts): `isOwner ||
// canTeamMemberAccess`. We route through privacy.ts so there is one source of
// truth for that nuance. The `shared`/share_token guest path is deliberately
// out of scope — it is a separate, unauthenticated access concern.
export async function canAccessConversation(
  ctx: AccessCtx,
  userId: Id<"users">,
  conversation: {
    _id?: Id<"conversations">;
    user_id: Id<"users">;
    owner_user_id?: Id<"users">;
    team_id?: Id<"teams">;
    is_private: boolean;
    team_visibility?: string;
    share_token?: string;
  },
): Promise<boolean> {
  return await canOwnerOrTeamAccess(ctx, userId, conversation);
}

// A CLI call names "this session" by its agent session uuid. The row's stored
// session_id can lag the live uuid — the daemon's rebind at link/resume time
// can lose (stranded task-run stub, cross-machine handover) — while the
// managed_sessions link the daemon also writes stays current. Resolve through
// both, then gate on conversation access. Returns null on miss or denial and
// never throws: for most callers the session is enrichment (a comment
// back-link, a team stamp) and a stale reference must never reject the write
// it rides on — those callers drop the link and keep the write. Callers whose
// whole point is the link (plan bind) throw on null themselves.
export async function resolveSessionConversation(
  ctx: AccessCtx,
  userId: Id<"users">,
  sessionRef: string,
): Promise<Doc<"conversations"> | null> {
  const direct = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionRef))
    .first();
  if (direct && (await canAccessConversation(ctx, userId, direct))) return direct;
  // Owner-scoped resolution, including the managed_sessions fallback.
  return await findConversationBySessionReference(ctx, sessionRef, userId);
}
