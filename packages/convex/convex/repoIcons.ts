// A repository's face on the Deploys page: a drawing in the role icon
// language, made by the same generator from the repository's name and stored
// per workspace in repo_icons. Modeled on sessionIcons.ts, but the server asks:
// every deploy recorded into a personal workspace asks for its repository's
// face (deploys.recordDeployMarker), the server draws once, and an ask inside the retry window
// after a failed drawing does nothing.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { modelCost } from "./lib/anthropic";
import { roleIconValidator } from "./lib/roleIconValidator";
import { ICON_MODEL, generateRoleIcon, type IconBrief } from "./lib/roleIconGenerator";
import { parseOwnerRepo } from "@codecast/shared/contracts";
import { SESSION_ICON_RETRY_MS, isRoleIcon, pickRoleIconAccent, type RoleIcon, type RoleIconAccent } from "@codecast/shared/contracts/roleIcon";
import { ROLE_ICON_EXAMPLES } from "@codecast/shared/contracts/roleIconExamples";
import { deploymentAsk } from "./roleIcons";

type Ctx = { db: any; scheduler: any };

/** How long an ask holds off the next one: the session icon's window. */
export const REPO_ICON_RETRY_MS = SESSION_ICON_RETRY_MS;

export type RepoIconRow = { _id: string; workspace: string; repository: string; accent: RoleIconAccent | null; icon: RoleIcon | null };

/** The name a repository's face is drawn from: the part after `owner/`. */
export const repoName = (repository: string) => repository.split("/").pop() || repository;

const rowsOf = (ctx: { db: any }, workspace: string): Promise<any[]> =>
  ctx.db.query("repo_icons").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", workspace)).take(500);

const accentOf = (row: any): RoleIconAccent | null => row?.accent ?? (isRoleIcon(row?.icon) ? row.icon.accent : null);

/**
 * Whether the workspace already works on the repository: a deploy of it, a
 * run on one of its pull requests, or a checkout of it there. A face asks only
 * for those, so nobody spends a drawing on an arbitrary name.
 */
async function workspaceHasRepository(ctx: { db: any }, workspace: string, repository: string): Promise<boolean> {
  const inWorkspace = (q: any) => q.eq(q.field("workspace"), workspace);
  if (await ctx.db.query("checkouts").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", workspace).eq("repository", repository)).first()) return true;
  if (await ctx.db.query("deploys").withIndex("by_repository_created", (q: any) => q.eq("repository", repository)).filter(inWorkspace).first()) return true;
  return !!(await ctx.db.query("workflow_runs").withIndex("by_pr", (q: any) => q.eq("pr.repository", repository)).filter(inWorkspace).first());
}

/** Every repository face in a workspace the caller may read. */
export const forWorkspace = query({
  args: { api_token: v.optional(v.string()), workspace: v.string() },
  handler: async (ctx, args): Promise<RepoIconRow[]> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId || !(await workspaceGrantsAccess(ctx, userId, args.workspace as any))) return [];
    const rows = await rowsOf(ctx, args.workspace);
    return rows.map((r) => ({ _id: String(r._id), workspace: r.workspace, repository: r.repository, accent: accentOf(r), icon: isRoleIcon(r.icon) ? r.icon : null }));
  },
});

/** Whether a drawing was scheduled. */
export async function performRequestRepoIcon(ctx: Ctx, userId: Id<"users">, workspace: string, repository: string, now = Date.now()): Promise<boolean> {
  const repo = parseOwnerRepo(repository);
  if (!repo || !(await workspaceGrantsAccess(ctx as any, userId, workspace as any))) return false;
  const row: any = await ctx.db.query("repo_icons").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", workspace).eq("repository", repo)).first();
  if (isRoleIcon(row?.icon)) return false;
  if (row?.requested_at && now - row.requested_at < REPO_ICON_RETRY_MS) return false;
  if (!row && !(await workspaceHasRepository(ctx, workspace, repo))) return false;
  // The color is settled at the first ask, the one the workspace's other faces use least.
  const others = row ? [] : await rowsOf(ctx, workspace);
  const accent = accentOf(row) ?? pickRoleIconAccent(others.map(accentOf).filter((a): a is RoleIconAccent => !!a), repo);
  const id = row ? row._id : await ctx.db.insert("repo_icons", { workspace, repository: repo, accent, requested_at: now });
  if (row) await ctx.db.patch(id, { accent, requested_at: now });
  await ctx.scheduler.runAfter(0, internal.repoIcons.drawRepoIcon, { id });
  return true;
}

/** The brief for a repository: its name, kept clear of the workspace's other repository faces. */
export const repoIconBrief = internalQuery({
  args: { id: v.id("repo_icons") },
  handler: async (ctx, args): Promise<(IconBrief & { workspace: string }) | null> => {
    const row: any = await ctx.db.get(args.id);
    if (!row || isRoleIcon(row.icon)) return null;
    const name = repoName(row.repository);
    const siblings = (await rowsOf(ctx, row.workspace)).filter((r) => String(r._id) !== String(row._id) && isRoleIcon(r.icon));
    return {
      workspace: row.workspace,
      role_id: String(row._id),
      title: name,
      handle: name,
      charter: `A software project named ${name}.`,
      siblings: siblings.map((r) => ({ title: repoName(r.repository), icon: r.icon })),
      examples: ROLE_ICON_EXAMPLES,
      accent: accentOf(row) ?? pickRoleIconAccent(siblings.map((r) => r.icon.accent), row.repository),
    };
  },
});

export const drawRepoIcon = internalAction({
  args: { id: v.id("repo_icons") },
  handler: async (ctx, args): Promise<void> => {
    if (!process.env.ANTHROPIC_API_KEY) return;
    const brief: (IconBrief & { workspace: string }) | null = await ctx.runQuery(internal.repoIcons.repoIconBrief, args);
    if (!brief) return;
    const scratch: Id<"_storage">[] = [];
    try {
      // A repository's name is its workspace's words (lib/vendorGuard).
      const result = await generateRoleIcon(brief, deploymentAsk(ctx, scratch, { ctx, scope: { workspace: brief.workspace } }));
      console.log(`repo icon for ${brief.title}: ${result.ok ? `"${result.icon.concept}"` : "none"}, ${result.calls} calls, $${modelCost(ICON_MODEL, result.usage).toFixed(3)}`);
      if (result.ok) await ctx.runMutation(internal.repoIcons.saveRepoIcon, { id: args.id, icon: result.icon });
      else console.error(`repo icon for ${brief.title}: ${result.reason}`);
    } catch (err) {
      console.error(`repo icon for ${brief.title} failed:`, err);
    } finally {
      for (const id of scratch) await ctx.storage.delete(id).catch(() => {});
    }
  },
});

export const saveRepoIcon = internalMutation({
  args: { id: v.id("repo_icons"), icon: roleIconValidator },
  handler: async (ctx, args): Promise<void> => {
    const row: any = await ctx.db.get(args.id);
    // The drawing wears the row's settled color.
    if (row && !isRoleIcon(row.icon) && isRoleIcon(args.icon)) await ctx.db.patch(row._id, { icon: { ...args.icon, accent: row.accent ?? args.icon.accent } });
  },
});
