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
import { canTeamMemberAccess, isTeamMember, teamVisibleConvTeam } from "../privacy";
import { forbidden, notFound } from "./auth";

// Re-exported so callers that want the membership primitive can reach it through
// the access layer too (canAccessDoc uses it directly).
export { isTeamMember };

type AccessCtx = { db: any };

// ── Owner-or-workspace: tasks, docs, plans, projects ──
// One rule: the owner always has access; anyone else has access iff the row's
// stored ACCESS key (`workspace`) names a team they belong to. Task assignment
// is also an explicit grant. team_id is ROUTING and is never consulted here —
// see the workspace-key section below.

export async function canAccessTask(
  ctx: AccessCtx,
  userId: Id<"users">,
  task: any,
): Promise<boolean> {
  if (String(task.user_id) === String(userId)) return true;
  if (task.assignee && String(task.assignee) === String(userId)) return true;
  return await workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, task));
}

export async function canAccessProject(
  ctx: AccessCtx,
  userId: Id<"users">,
  project: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): Promise<boolean> {
  if (String(project.user_id) === String(userId)) return true;
  return await workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, project));
}


export async function canAccessPullRequest(
  ctx: AccessCtx,
  userId: Id<"users">,
  pullRequest: { team_id: Id<"teams"> },
): Promise<boolean> {
  return await isTeamMember(ctx, userId, pullRequest.team_id);
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

export async function requireTeamAdmin(
  ctx: AccessCtx,
  userId: Id<"users">,
  teamId: Id<"teams">,
): Promise<any> {
  const membership = await requireTeamMembership(ctx, userId, teamId);
  if (membership.role !== "admin") forbidden("Forbidden: team admin required");
  return membership;
}

export type AuthorizedWorkspace =
  | { type: "personal"; userId: Id<"users"> }
  | { type: "team"; teamId: Id<"teams"> };

/**
 * The conversation a record inherits workspace visibility from, if any.
 * This is THE canonical linkage rule — teamScopeSweep and the workspace
 * compute both use it. Explicit creation links win over association links.
 * Note `created_from_conversation_id`: the PLAN spelling of the same edge —
 * omitting it made plans silently skip inheritance entirely.
 */
export function linkedConversationId(record: any): string | undefined {
  if (record.created_from_conversation) return String(record.created_from_conversation);
  if (record.created_from_conversation_id) return String(record.created_from_conversation_id);
  if (record.conversation_id) return String(record.conversation_id);
  if (record.related_conversation_ids?.[0]) return String(record.related_conversation_ids[0]);
  if (record.conversation_ids?.[0]) return String(record.conversation_ids[0]);
  return undefined;
}

// ── Stored workspace key (the ACCESS axis) ──────────────────────────────────
//
// One stored value per row answers "who may read this": `team:<teamId>` or
// `user:<userId>`. It is INDEPENDENT state, not a projection of team_id:
//   • team_id stays ROUTING (which team's surfaces/feeds/notifications the row
//     shows in) and no access path may consult it.
//   • workspace is ACCESS and no routing path may consult it.
// The split is what makes "routed to team T but readable only by its owner"
// expressible (team_id: T, workspace: user:<owner>) — a product requirement,
// not a migration convenience.
//
// The key is written at WRITE time by computeWorkspaceKey (below) and
// recomputed ONLY when a linked conversation's visibility changes
// (recomputeWorkspaceForConversation). Reads are a single equality against
// the viewer's active workspace key. The format is a discriminated string so
// a future `restricted:<ref>` variant (subset sharing, session_owners-style
// join table behind it) is additive; parseWorkspaceKey returns null for
// unknown variants so every reader fails CLOSED on them.

export type WorkspaceKey = string;

/** The one constructor for a workspace key. */
export function workspaceKey(ws: AuthorizedWorkspace): WorkspaceKey {
  return ws.type === "team" ? `team:${ws.teamId}` : `user:${ws.userId}`;
}

/** Null for unknown/absent variants — callers must treat null as NO access. */
export function parseWorkspaceKey(key: string | null | undefined): AuthorizedWorkspace | null {
  if (!key) return null;
  if (key.startsWith("team:")) return { type: "team", teamId: key.slice(5) as Id<"teams"> };
  if (key.startsWith("user:")) return { type: "personal", userId: key.slice(5) as Id<"users"> };
  return null;
}

/**
 * WRITE-time compute of a row's workspace key from today's effective-access
 * rules. Pure: the caller supplies the linked conversation row (or null).
 * A linked conversation decides: team-visible → its team, otherwise the row is
 * personal TO ITS OWNER (user_id — never the caller running the compute).
 * Without a link, the raw team tag decides. This is the ONLY place the access
 * axis may read team_id — it is the writer, not a reader.
 */
export function computeWorkspaceKey(
  record: { user_id: Id<"users">; team_id?: Id<"teams"> },
  linkedConv:
    | { team_id?: Id<"teams">; is_private?: boolean; auto_shared?: boolean; team_visibility?: string }
    | null
    | undefined,
): WorkspaceKey {
  if (linkedConv) {
    const teamId = teamVisibleConvTeam(linkedConv);
    return teamId ? `team:${teamId}` : `user:${record.user_id}`;
  }
  return record.team_id ? `team:${record.team_id}` : `user:${record.user_id}`;
}

/** computeWorkspaceKey with the linked conversation fetched from the db. */
export async function computeWorkspaceKeyDb(ctx: AccessCtx, record: any): Promise<WorkspaceKey> {
  const cid = linkedConversationId(record);
  const conv = cid ? await ctx.db.get(cid) : null;
  return computeWorkspaceKey(record, conv);
}

/**
 * The stored key when present, else the lazy compute — migration scaffolding
 * for rows minted before the backfill. Once the backfill has run, the stored
 * branch is the only one taken.
 */
export async function resolveWorkspaceKey(ctx: AccessCtx, record: any): Promise<WorkspaceKey> {
  if (typeof record.workspace === "string" && record.workspace) return record.workspace;
  return computeWorkspaceKeyDb(ctx, record);
}

/**
 * Does this user belong to the workspace the key names? The ONE access
 * predicate for key-carrying rows: personal keys match only that user; team
 * keys require membership; unknown variants (future `restricted:`) and absent
 * keys grant NOTHING here — fail closed.
 */
export async function workspaceGrantsAccess(
  ctx: AccessCtx,
  userId: Id<"users">,
  key: WorkspaceKey | null | undefined,
): Promise<boolean> {
  const ws = parseWorkspaceKey(key);
  if (!ws) return false;
  if (ws.type === "personal") return String(ws.userId) === String(userId);
  return await isTeamMember(ctx, userId, ws.teamId);
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
  await ctx.db.patch(conversation._id, updates);
  const after = { ...conversation, ...updates };
  return recomputeWorkspaceForConversation(ctx, after);
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
  for (const table of ["tasks", "plans", "docs"]) {
    gather((await ctx.db.query(table)
      .withIndex("by_user_id", (q: any) => q.eq("user_id", conv.user_id))
      .take(4000))
      .filter((row: any) => linkedConversationId(row) === convId));
  }

  let updated = 0;
  for (const row of rows) {
    if (linkedConversationId(row) !== convId) continue;
    const key = computeWorkspaceKey(row, conv);
    if (row.workspace !== key) {
      await ctx.db.patch(row._id, { workspace: key });
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
  if (String(doc.user_id) === String(userId)) return true;
  return await workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, doc));
}

export async function canAccessPlan(
  ctx: AccessCtx,
  userId: Id<"users">,
  plan: any,
): Promise<boolean> {
  if (String(plan.user_id) === String(userId)) return true;
  return await workspaceGrantsAccess(ctx, userId, await resolveWorkspaceKey(ctx, plan));
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
    user_id: Id<"users">;
    team_id?: Id<"teams">;
    is_private: boolean;
    team_visibility?: string;
    share_token?: string;
  },
): Promise<boolean> {
  if (conversation.user_id.toString() === userId.toString()) return true;
  return await canTeamMemberAccess(ctx, userId, conversation);
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
