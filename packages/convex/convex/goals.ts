// The goals brief (docs/architecture/the-line-end-to-end.md LE5): the rows
// `cast goals` renders for the ground node. Active initiatives with their
// metrics and scoreboard, and the charter of every live project that has one
// or that an active initiative carries. The rendering is
// shared/contracts/goalsBrief; this only gathers, in one workspace.
import { v } from "convex/values";
import type { GoalsBrief, GoalsBriefProject } from "@codecast/shared/contracts/goalsBrief";
import { query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext, scopedFetch } from "./data";
import { readWorkspaceInitiatives } from "./lib/roleInitiatives";
import { ownerLabel } from "./initiatives";

const LIVE_PROJECT = new Set(["active", "planning"]);

const hasCharter = (p: any) => !!(p.goal?.trim() || p.success_metrics?.length || p.non_goals?.length || p.risks?.length);

/** `cast goals`: the workspace's goals, raw rows the CLI renders. */
export const brief = query({
  args: {
    api_token: v.string(),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<GoalsBrief> => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
    const ws = db.workspace;
    const teamId = ws.type === "team" ? ws.teamId : undefined;
    const [initiativeRows, { records: projectRows }, team] = await Promise.all([
      readWorkspaceInitiatives(ctx, db.workspaceKey),
      scopedFetch(ctx, "projects", { userId: auth.userId, workspace: ws.type, teamId }),
      teamId ? ctx.db.get(teamId) : null,
    ]);
    const active = initiativeRows.filter((r: any) => r.status === "active");
    const projectsById = new Map(projectRows.map((p: any) => [String(p._id), p]));
    const projectRef = (p: any) => p.short_id ?? String(p._id);
    const carried = new Set(active.flatMap((r: any) => r.project_ids.map(String)));

    const initiatives = await Promise.all(active.map(async (r: any) => ({
      short_id: r.short_id,
      title: r.title,
      priority: r.priority,
      owner: await ownerLabel(ctx, r.owner),
      target_date: r.target_date,
      health: r.health,
      description: r.description,
      metrics: r.metrics ?? [],
      scoreboard: r.scoreboard,
      project_short_ids: r.project_ids.map((id: any) => projectsById.get(String(id))).filter(Boolean).map(projectRef),
    })));

    const roleIds = [...new Set(projectRows.map((p: any) => p.owner_role_id).filter(Boolean).map(String))];
    const roles = new Map(await Promise.all(roleIds.map(async (id) => [id, await ctx.db.get(id as any)] as const)));
    const projects: GoalsBriefProject[] = projectRows
      .filter((p: any) => LIVE_PROJECT.has(p.status) && (hasCharter(p) || carried.has(String(p._id))))
      .map((p: any) => {
        const role: any = p.owner_role_id ? roles.get(String(p.owner_role_id)) : null;
        return {
          short_id: projectRef(p),
          title: p.title,
          status: p.status,
          goal: p.goal,
          success_metrics: p.success_metrics,
          non_goals: p.non_goals,
          risks: p.risks,
          priority: p.priority,
          owner_role: role?.handle ? `@${role.handle}` : undefined,
        };
      });

    return { workspace: db.workspaceKey, workspace_name: (team as any)?.name, initiatives, projects };
  },
});
