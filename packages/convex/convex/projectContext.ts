// The project a session works in, as the session reads it at start
// (docs/architecture/session-projects.md SP6): the charter, the instructions,
// the memory (its pinned docs the reader may open) and its main session.
// org.where carries it so the per-session launch read brings it; forSession
// serves it alone, for the CLI and the hook that restores it after compaction.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { canAccessDoc, canAccessProject } from "./lib/access";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";
import { effectiveSessionProjectId, projectDefaultSessionId } from "./sessionProjects";
import { memoryGist, PROJECT_MEMORY_SHOWN, type ProjectContext } from "@codecast/shared/contracts/projectContext";

type Ctx = { db: any };

/** How many pinned docs are read: the shown ones and enough beyond to count. */
const MEMORY_SCAN = 60;

/** The project's context as `userId` may read it, for `conv` (or no session). Null when unreadable. */
export async function computeProjectContext(ctx: Ctx, userId: Id<"users">, project: Doc<"projects"> | null, conv: any | null): Promise<ProjectContext | null> {
  if (!project || !(await canAccessProject(ctx as any, userId, project))) return null;
  const memory: ProjectContext["memory"] = [];
  let more = 0;
  // Only the pinned docs, through their index: the project's other docs are never read.
  const pinned = await ctx.db.query("docs").withIndex("by_project_pinned", (q: any) => q.eq("project_id", project._id).eq("pinned", true)).order("desc").take(MEMORY_SCAN);
  for (const d of pinned) {
    if (d.archived_at) continue;
    if (!(await canAccessDoc(ctx as any, userId, d))) continue;
    if (memory.length < PROJECT_MEMORY_SHOWN) memory.push({ id: String(d._id), title: d.title ?? "", gist: memoryGist(d.content ?? "", d.title ?? "") });
    else more++;
  }
  const mainId = await projectDefaultSessionId(ctx as any, project);
  const main: any = mainId ? await ctx.db.get(mainId) : null;
  return {
    id: String(project._id),
    short_id: project.short_id ?? null,
    title: project.title,
    goal: project.goal?.trim() || null,
    success_metrics: project.success_metrics ?? [],
    instructions: project.instructions?.trim() || null,
    memory,
    memory_more: more,
    main_session: main ? { short_id: main.short_id ?? null, title: main.title ?? null } : null,
    is_main: !!(main && conv && String(main._id) === String(conv._id)),
  };
}

/** The project a session works in (SP1's rule), when the reader may open it.
 *  The one reading behind both org.where and forSession. */
export async function sessionProject(ctx: Ctx, userId: Id<"users">, conv: any | null): Promise<Doc<"projects"> | null> {
  if (!conv) return null;
  const id = await effectiveSessionProjectId(ctx as any, conv);
  const project: Doc<"projects"> | null = id ? await ctx.db.get(id) : null;
  return project && (await canAccessProject(ctx as any, userId, project)) ? project : null;
}

/** One session's project context (its derived project), or a named project's. */
export const forSession = query({
  args: {
    api_token: v.string(),
    /** Any reference to the caller's own session. */
    session: v.optional(v.string()),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<ProjectContext | null> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const conv: any = args.session
      ? await findConversationByAnyRefWhere(ctx as any, args.session, (c: any) => String(c.user_id) === String(auth.userId))
      : null;
    const named = args.project_id ? ctx.db.normalizeId("projects", args.project_id) : null;
    const project = named ? await ctx.db.get(named) : await sessionProject(ctx, auth.userId, conv);
    return computeProjectContext(ctx, auth.userId, project, conv);
  },
});
