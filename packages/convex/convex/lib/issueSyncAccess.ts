// Issue sync's connection and delivery checks, and its Linear label lookup:
// which installation or connection serves a source, and whether one reaches a
// container. Split from issueSync.ts (line ratchet). Helpers only: this module
// defines no Convex functions.
import type { Id } from "../_generated/dataModel";
import * as linearApi from "../linearApi";
import { repositoryOwner } from "./gitRefs";
import { installationCoversRepo, installationOwner, routingTeamForInstallation } from "../githubApp";
import { connectionForWork } from "../oauthConnectors";

/** The fields of a source row these checks read. */
type SourceKeys = { user_id: Id<"users">; team_id?: Id<"teams">; workspace: string };

/**
 * Does the GitHub installation that sent a delivery serve this source? A
 * source row is keyed by repository name alone, so without this any workspace
 * that registered the name would receive the repository's issues. The
 * delivery must come from an installation whose team is the source's
 * workspace, or from the personal installation of the person who added the
 * source (their grant follows them into every workspace they work in).
 */
export async function githubDeliveryServesSource(ctx: any, source: SourceKeys, payload: any, repo: string): Promise<boolean> {
  const installationId = payload?.installation?.id;
  if (typeof installationId !== "number") return false;
  const installation = await ctx.db
    .query("github_app_installations")
    .withIndex("by_installation_id", (q: any) => q.eq("installation_id", installationId))
    .first();
  if (!installation) return false;
  const owner = installationOwner(installation);
  if (owner && String(owner) === String(source.user_id)) return true;
  let team: Id<"teams"> | undefined;
  try {
    team = await routingTeamForInstallation(ctx, installation, repo);
  } catch {
    return false;
  }
  return !!team && source.workspace === `team:${String(team)}`;
}

/**
 * Does a Linear delivery come from the Linear organization this source's
 * connection is for? Refused when the source has no connection, or when both
 * sides name an organization and they differ.
 */
export async function linearDeliveryServesSource(ctx: any, source: SourceKeys, payload: any): Promise<boolean> {
  const connection = await connectionForWork(ctx, "linear", { team_id: source.team_id, user_id: source.user_id });
  if (!connection) return false;
  const org = payload?.organizationId;
  if (typeof org === "string" && org && typeof connection.account_id === "string" && connection.account_id) {
    return org === connection.account_id;
  }
  return true;
}

/** Does a connection of `teamId`, or the caller's own, reach this container? (addSourceFor) */
export async function connectionReaches(
  ctx: any,
  provider: string,
  teamId: Id<"teams"> | undefined,
  userId: Id<"users">,
  externalId: string,
): Promise<boolean> {
  if (provider === "linear") return !!(await connectionForWork(ctx, "linear", { team_id: teamId, user_id: userId }));
  const installs: any[] = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", repositoryOwner(externalId)))
    .collect();
  for (const row of installs) {
    if (!installationCoversRepo(row, externalId)) continue;
    const owner = installationOwner(row);
    if (owner && String(owner) === String(userId)) return true;
    if (!teamId) continue;
    let team: Id<"teams"> | undefined;
    try {
      team = await routingTeamForInstallation(ctx, row, externalId);
    } catch {
      continue;
    }
    if (team && String(team) === String(teamId)) return true;
  }
  return false;
}

/** Does `userId` hold a personal connection that can reach this container? */
export async function hasPersonalConnection(
  ctx: any,
  provider: string,
  userId: Id<"users">,
  externalId: string,
): Promise<boolean> {
  if (provider === "linear") return !!(await connectionForWork(ctx, "linear", { user_id: userId }));
  const installs = await ctx.db
    .query("github_app_installations")
    .withIndex("by_scope_user", (q: any) => q.eq("scope_user_id", userId))
    .collect();
  return installs.some((row: any) => installationCoversRepo(row, externalId));
}

/**
 * Label names -> Linear label ids, creating the ones neither the team nor the
 * workspace has.
 *
 * Creation is the one write the app actor may lack: Linear lets a workspace
 * forbid apps from minting team labels ("You are not allowed to create labels
 * in this team"). Such a label is reported in `refused`, not thrown — the
 * push still carries every label that exists, and the title, state and the
 * rest of the write, so one unknown label cannot park the whole task.
 */
export async function resolveLinearLabelIds(
  token: string,
  teamId: string,
  names: string[],
): Promise<{ ids: string[]; refused: string[] }> {
  if (names.length === 0) return { ids: [], refused: [] };
  const existing = await linearApi.fetchLabels(token, teamId);
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  const refused: string[] = [];
  for (const name of names) {
    const hit = byName.get(name.toLowerCase());
    if (hit) {
      ids.push(hit);
      continue;
    }
    try {
      const created = await linearApi.createLabel(token, teamId, name);
      byName.set(name.toLowerCase(), created.id);
      ids.push(created.id);
    } catch (error) {
      if (!(error instanceof linearApi.LinearGraphqlError) || !error.forbidden) throw error;
      refused.push(name);
    }
  }
  return { ids, refused };
}
