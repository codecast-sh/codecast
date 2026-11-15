// Sessions in projects (docs/architecture/session-projects.md). The rule that
// decides a session's project lives in shared/contracts/sessionProject; this
// file feeds it from the database and holds the one write: a person putting a
// session in a project, or taking it out.

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "./functions";
import { canOwnerOrTeamAccess } from "./privacy";
import { canAccessProject } from "./lib/access";
import { getAuthenticatedUserId } from "./pendingMessages";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import {
  SESSION_PROJECT_MAX_DEPTH,
  projectParentIdOf,
  sessionProjectId,
} from "@codecast/shared/contracts/sessionProject";

// Only the database: the dispatch side effects hand a narrower ctx than a
// whole query or mutation.
type Ctx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Rows one reader has already loaded: pass one cache to many calls and a
 *  parent, task or plan shared by several sessions is read once. */
export type SessionProjectCache = {
  sessions: Map<string, Doc<"conversations"> | null>;
  taskProjects: Map<string, string | null>;
  taskPlans: Map<string, string | null>;
  planProjects: Map<string, string | null>;
};
export const sessionProjectCache = (): SessionProjectCache => ({ sessions: new Map(), taskProjects: new Map(), taskPlans: new Map(), planProjects: new Map() });

/** The project a stored session works in: loads its parent chain and the tasks
 *  and plans the chain is bound to, then applies the shared rule. */
export async function effectiveSessionProjectId(ctx: Ctx, conv: Doc<"conversations">, cache: SessionProjectCache = sessionProjectCache()): Promise<Id<"projects"> | null> {
  const { sessions, taskProjects, taskPlans, planProjects } = cache;
  const loadPlan = async (planId: Id<"plans">) => {
    if (planProjects.has(planId.toString())) return;
    const plan = await ctx.db.get(planId);
    planProjects.set(planId.toString(), plan?.project_id?.toString() ?? null);
  };
  const seen = new Set<string>();
  let cur: Doc<"conversations"> | null = conv;
  while (cur && !seen.has(cur._id.toString()) && seen.size < SESSION_PROJECT_MAX_DEPTH) {
    seen.add(cur._id.toString());
    sessions.set(cur._id.toString(), cur);
    if (cur.project_id) break;
    if (cur.active_task_id && !taskProjects.has(cur.active_task_id.toString())) {
      const task = await ctx.db.get(cur.active_task_id);
      taskProjects.set(cur.active_task_id.toString(), task?.project_id?.toString() ?? null);
      taskPlans.set(cur.active_task_id.toString(), task?.plan_id?.toString() ?? null);
      if (task && !task.project_id && task.plan_id) await loadPlan(task.plan_id);
    }
    if (cur.active_plan_id) await loadPlan(cur.active_plan_id);
    const parentId = projectParentIdOf(cur);
    const parentKey = parentId ? ctx.db.normalizeId("conversations", parentId) : null;
    if (!parentKey) break;
    if (!sessions.has(parentKey.toString())) sessions.set(parentKey.toString(), await ctx.db.get(parentKey));
    cur = sessions.get(parentKey.toString()) ?? null;
  }
  const id = sessionProjectId(conv, {
    session: (sid) => sessions.get(sid),
    taskProject: (tid) => taskProjects.get(tid),
    taskPlan: (tid) => taskPlans.get(tid),
    planProject: (pid) => planProjects.get(pid),
  });
  return id ? ctx.db.normalizeId("projects", id) : null;
}

/** The project a new session is born in, when its creator names one they can
 *  read; an unreadable or unknown project is dropped, never trusted. */
export async function readableProject(ctx: Ctx, userId: Id<"users">, ref: string | undefined | null): Promise<Doc<"projects"> | null> {
  const id = ref ? ctx.db.normalizeId("projects", ref) : null;
  const project = id ? await ctx.db.get(id) : null;
  return project && (await canAccessProject(ctx, userId, project)) ? project : null;
}

/** A project's default session (pl-994 step 2): the standing session of its
 *  lead role when the lead is seated, else the canonical session the project
 *  was first talked to in. Null until one of them exists. */
export async function projectDefaultSessionId(ctx: Ctx, project: Doc<"projects">): Promise<Id<"conversations"> | null> {
  const role = project.owner_role_id ? await ctx.db.get(project.owner_role_id) : null;
  const seat = role?.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  if (role && role.status !== "retired" && seat?.conversation_id && seat.status !== "decommissioned") return seat.conversation_id;
  if (project.default_session_id) {
    if (await ctx.db.get(project.default_session_id)) return project.default_session_id;
  }
  return null;
}

/** Record a session created from the project's own composer as its canonical
 *  session, when the project has no default session yet. */
export async function claimProjectDefaultSession(ctx: Pick<MutationCtx, "db">, projectId: Id<"projects">, conversationId: Id<"conversations">): Promise<void> {
  const project = await ctx.db.get(projectId);
  if (!project || (await projectDefaultSessionId(ctx, project))) return;
  await ctx.db.patch(projectId, { default_session_id: conversationId });
}

/** Put a session in a project, or take it out with null. Its workers follow,
 *  since they derive theirs from it. Either side the caller cannot see is
 *  refused: a session they could not open, a project they could not read. */
export const setSessionProject = mutation({
  args: {
    // Any reference to the session: its id, short id or agent session uuid.
    session: v.string(),
    project_id: v.union(v.id("projects"), v.null()),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed: invalid token or session");
    const conversation = (await findConversationByAnyRefWhere(ctx as any, args.session, (c) =>
      canOwnerOrTeamAccess(ctx, userId, c as any))) as Doc<"conversations"> | null;
    if (!conversation) throw new Error("Session not found");
    if (args.project_id) {
      const project = await ctx.db.get(args.project_id);
      if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error("Project not found");
    }
    const next = args.project_id ?? undefined;
    if (conversation.project_id !== next) await ctx.db.patch(conversation._id, { project_id: next });
    return {
      conversation_id: conversation._id,
      short_id: conversation.short_id ?? null,
      project_id: await effectiveSessionProjectId(ctx, { ...conversation, project_id: next }),
    };
  },
});
