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
import { mutation, query } from "./functions";
import { Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { isTeamMember, requireTeamMembership } from "./lib/access";
import { commitUrl, normalizeRepository, shortSha } from "./lib/gitRefs";
import { recordExternalEvent } from "./externalEvents";
import { resolveTeamForRepository } from "./githubWebhooks";
import { parseOwnerRepo } from "@codecast/shared/contracts";
import { adderOf, latestLiveDeploy, recordDeployMarker, recordDevPush, targetPushes } from "./deploys";
import { sameSha } from "./deployCarries";
import { devPushedOver } from "./deployTargetsState";
import { normalizeDeployTarget, type AddedBy } from "@codecast/shared/contracts/deploys";

const SURFACE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** Names a push may report it added or dropped, and names one lookup may ask about. */
const NAMES_MAX = 500;
/** How far back through a target's deploys, and through its dev pushes, a name's adder is looked for. */
const ADDED_BY_SCAN = 200;

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
  const team = await findDeployTeam(ctx, userId, repository);
  if (team) return team;
  throw new Error(`None of your teams has ${repository} connected (GitHub App or a published checkout); pass --team <name|id>.`);
}

/** deployTeamFor, answering null when none of the caller's teams works on the repository. */
export async function findDeployTeam(
  ctx: { db: any },
  userId: Id<"users">,
  repository: string,
): Promise<Id<"teams"> | null> {
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
  return null;
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
    // Files under the surface's sources that went out uncommitted with the sha.
    dirty: v.optional(v.number()),
    // The deploy (dp-N) this mark finishes: a deploy codecast asked for, whose path now says what went out.
    deploy: v.optional(v.string()),
    // The hostname of the machine that pushed.
    machine: v.optional(v.string()),
    // Which push path sent it. A dev watcher's push is recorded as a dev push, not a deploy (deploys.recordDevPush).
    via: v.optional(v.union(v.literal("deploy.sh"), v.literal("dev watcher"))),
    // Names the push put on the surface and took off it (`fn:`, `http:`, `index:`, `table:`); deploys.ts caps them. Both
    // are sent, possibly empty, exactly when the push's diff ran, and both left out when it did not.
    adds: v.optional(v.array(v.string())),
    drops: v.optional(v.array(v.string())),
    // How long before this call the push's diff read prod (ms, by the pusher's clock): a deploy keeping a name proves it
    // committed only for pushes before then. An age, not a time, so the pusher's clock never meets the server's.
    changes_read_age_ms: v.optional(v.number()),
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
    const user = await ctx.db.get(userId);
    const startedBy = { kind: "person" as const, name: user?.name ?? user?.github_username ?? "someone", user_id: userId };

    // A dev watcher's push is not a deploy: a dev push, and nothing else (no event, no deploy, no trigger).
    if (args.via === "dev watcher") {
      // The watcher pushes once as it starts: a committed tree whose diff found nothing, at the sha of the clean deploy
      // the target runs with no dev push on top, changed nothing, and is not recorded.
      if (!args.dirty && Array.isArray(args.adds) && Array.isArray(args.drops) && !args.adds.length && !args.drops.length) {
        const live = await latestLiveDeploy(ctx, `team:${teamId}`, surface, repository);
        if (live && !live.dirty && sameSha(live.sha, sha) && !(await devPushedOver(ctx, live))) {
          return { ok: true as const, dev_push: false as const, noop: true as const, event_id: null, team_id: teamId, repository, surface, sha, version: version ?? null, deploy: null };
        }
      }
      await recordDevPush(ctx, {
        workspace: `team:${teamId}`,
        team_id: teamId,
        target: surface,
        repository,
        sha,
        ...(args.machine?.trim() ? { machine: args.machine.trim() } : {}),
        started_by: startedBy,
        ...(args.dirty ? { dirty: args.dirty } : {}),
        ...(args.adds ? { adds: args.adds } : {}),
        ...(args.drops ? { drops: args.drops } : {}),
        at: Date.now(),
      });
      return { ok: true as const, dev_push: true as const, event_id: null, team_id: teamId, repository, surface, sha, version: version ?? null, deploy: null };
    }

    // The surface already runs this sha (a retried deploy.sh, a redeploy of
    // the same commit): one marker. A rollback to an earlier sha is a change
    // of what runs, so it gets a marker of its own.
    const previous = await latestDeploy(ctx, teamId, repository, surface);
    const live = await latestLiveDeploy(ctx, `team:${teamId}`, surface, repository);
    // A deploy of the same commit with uncommitted files is a different deploy, and one that changed what runs is news.
    // So is a clean deploy of a sha whose live deploy went out dirty: the tree it ran was not the sha's. So is one of a
    // sha the target no longer runs (a workflow run rolled it back since this repository's last marker), and one over a
    // dev push: it put the committed tree back.
    if (previous?.sha === sha && !args.deploy && !args.dirty && !args.adds?.length && !args.drops?.length
      && (!live || (!live.dirty && sameSha(live.sha, sha) && !(await devPushedOver(ctx, live))))) {
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
    // The marker is a deploy object too (deploys.md DP1): it finishes the
    // line's deploy on this surface, or records one of its own.
    const deploy = await recordDeployMarker(ctx, {
      workspace: `team:${teamId}`,
      team_id: teamId,
      target: surface,
      sha,
      ...(version ? { version } : {}),
      repository,
      source: "cast ship mark",
      push: true,
      event_id: eventId,
      ...(args.dirty ? { dirty: args.dirty } : {}),
      ...(args.deploy ? { deploy: args.deploy } : {}),
      ...(args.machine?.trim() ? { machine: args.machine.trim() } : {}),
      ...(args.via ? { pushed_via: args.via } : {}),
      // Sent exactly when the push's diff ran, empty or not: a deploy whose diff ran is evidence of what its tree held.
      ...(args.adds ? { adds: args.adds } : {}),
      ...(args.drops ? { drops: args.drops } : {}),
      ...(args.changes_read_age_ms != null ? { changes_read_at: now - Math.max(0, args.changes_read_age_ms) } : {}),
      started_by: startedBy,
      at: now,
    });
    return { ok: true as const, dev_push: false as const, event_id: eventId, team_id: teamId, repository, surface, sha, version: version ?? null, deploy };
  },
});

/**
 * For each name, the push of the repository's surface active last (among its
 * latest ADDED_BY_SCAN deploys and dev pushes) whose adds hold it: who put it
 * there, from which machine and path, and the deploy that showed it committed
 * (deploys.adderOf). Names no push added are left out.
 */
export const addedBy = query({
  args: {
    api_token: v.optional(v.string()),
    repository: v.string(),
    surface: v.string(),
    names: v.array(v.string()),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args): Promise<{ found: AddedBy[] }> => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const repository = parseOwnerRepo(args.repository);
    if (!repository) throw new Error(`"${args.repository}" is not an owner/name repository.`);
    const surface = args.surface.trim().toLowerCase();
    if (!SURFACE.test(surface)) throw new Error(`"${args.surface}" is not a surface name (lowercase letters, digits and dashes).`);
    if (args.names.length > NAMES_MAX) throw new Error(`Ask about at most ${NAMES_MAX} names at once.`);
    const target = normalizeDeployTarget(surface);
    if (!target) return { found: [] };

    if (args.team_id) await requireTeamMembership(ctx, userId, args.team_id);
    const teamId = args.team_id ?? (await deployTeamFor(ctx, userId, repository));
    const pushes = await targetPushes(ctx, `team:${teamId}`, target, normalizeRepository(repository), ADDED_BY_SCAN);
    const found: AddedBy[] = [];
    for (const name of new Set(args.names)) {
      const hit = adderOf(pushes, name);
      if (!hit) continue;
      const { adder } = hit;
      found.push({
        name,
        deploy: adder.kind === "deploy" ? adder.row.short_id : null,
        dev_push: adder.kind === "dev_push",
        by: adder.row.started_by?.name ?? null,
        machine: adder.row.machine ?? null,
        via: adder.kind === "deploy" ? adder.row.pushed_via ?? null : "dev watcher",
        at: adder.at,
        dirty: adder.row.dirty ?? 0,
        ...(hit.committed_in ? { committed_in: hit.committed_in.short_id } : {}),
      });
    }
    return { found };
  },
});
