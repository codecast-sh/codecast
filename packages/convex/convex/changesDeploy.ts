// Deploy markers for the Changes page (docs/proposals/changes-page.md 7.3).
//
// GitHub sees tags and pushes, never a deploy, so a surface that ships on its
// own clock (Convex, through packages/convex/deploy.sh) says so itself:
// `cast ship mark --surface backend --sha <HEAD>` posts here, and the marker
// lands as an `external_events` row of kind `deploy` for the repository's
// team, where the team event stream and the live strip both read it.
//
// The marker records whether or not the team has Changes turned on. It is a
// fact about the repository, like a commit, and a deploy left unrecorded while
// the flag is off could never be backfilled: the live strip would read "no
// signal yet" for a surface that shipped.

import { v } from "convex/values";
import { mutation } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { isTeamMember, requireTeamMembership } from "./lib/access";
import { commitUrl, normalizeRepository, shortSha } from "./lib/gitRefs";
import { recordExternalEvent } from "./externalEvents";
import { resolveTeamForRepository } from "./githubWebhooks";
import { parseOwnerRepo } from "@codecast/shared/contracts";

const SURFACE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/**
 * The team a repository's deploy belongs to, among the caller's teams. The
 * GitHub installation's team routes the repository's commits, so it wins when
 * the caller is in it; otherwise the one team whose members publish a checkout
 * of it (repo_sources). Two such teams is a question only the caller can
 * answer, so it asks for --team rather than picking.
 */
export async function deployTeamFor(
  ctx: { db: any },
  userId: Id<"users">,
  repository: string,
): Promise<Id<"teams">> {
  const installed = await resolveTeamForRepository(ctx, repository);
  if (installed && (await isTeamMember(ctx, userId, installed))) return installed;
  const sources = await ctx.db
    .query("repo_sources")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .take(100);
  const teams: Id<"teams">[] = [];
  for (const id of new Set<Id<"teams">>(sources.map((s: any) => s.team_id))) {
    if (await isTeamMember(ctx, userId, id)) teams.push(id);
  }
  if (teams.length === 1) return teams[0];
  if (teams.length > 1) throw new Error(`More than one of your teams works on ${repository}; pass --team <name|id>.`);
  throw new Error(`None of your teams has ${repository} connected (GitHub App or a published checkout); pass --team <name|id>.`);
}

// How far back through a repository's events the previous marker is looked
// for. Past it a repeat mark writes a second row for the same sha, which reads
// the same on the strip.
const DEPLOY_SCAN = 200;

/** The newest deploy marker for a surface of a repository in a team, if any. */
export async function latestDeploy(
  ctx: { db: any },
  teamId: Id<"teams">,
  repository: string,
  surface: string,
): Promise<{ _id: Id<"external_events">; sha?: string; created_at: number } | null> {
  const recent = await ctx.db
    .query("external_events")
    .withIndex("by_repository_created", (q: any) => q.eq("repository", normalizeRepository(repository)))
    .order("desc")
    .take(DEPLOY_SCAN);
  return (
    recent.find(
      (e: any) => e.kind === "deploy" && String(e.team_id) === String(teamId) && e.meta?.surface === surface,
    ) ?? null
  );
}

export const markDeploy = mutation({
  args: {
    api_token: v.optional(v.string()),
    repository: v.string(),
    surface: v.string(),
    sha: v.string(),
    version: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const repository = parseOwnerRepo(args.repository);
    if (!repository) throw new Error(`"${args.repository}" is not an owner/name repository.`);
    const surface = args.surface.trim().toLowerCase();
    if (!SURFACE.test(surface)) throw new Error(`"${args.surface}" is not a surface name (lowercase letters, digits and dashes).`);
    const sha = args.sha.trim().toLowerCase();
    if (!SHA.test(sha)) throw new Error(`"${args.sha}" is not a commit sha.`);
    const version = args.version?.trim().slice(0, 64) || undefined;

    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    const teamId = args.team_id ?? (await deployTeamFor(ctx, userId, repository));

    // The surface already runs this sha (a retried deploy.sh, a redeploy of
    // the same commit): one marker. A rollback to an earlier sha is a change
    // of what runs, so it gets a marker of its own.
    const previous = await latestDeploy(ctx, teamId, repository, surface);
    if (previous?.sha === sha) {
      return { ok: true as const, event_id: previous._id, team_id: teamId, repository, surface, sha, version: version ?? null };
    }

    const now = Date.now();
    const eventId = await recordExternalEvent(ctx, {
      source: "codecast",
      team_id: teamId,
      repository,
      kind: "deploy",
      actor_user_id: userId,
      title: `${surface}${version ? ` ${version}` : ""} at ${shortSha(sha)}`,
      url: commitUrl(repository, sha),
      sha,
      meta: { surface, version },
      dedupe_key: `deploy:${teamId}:${repository}:${surface}:${sha}:${now}`,
      created_at: now,
    });
    return { ok: true as const, event_id: eventId, team_id: teamId, repository, surface, sha, version: version ?? null };
  },
});
