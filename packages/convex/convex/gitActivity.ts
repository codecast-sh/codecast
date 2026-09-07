// Local git activity: what a checkout's reflog says happened, as team activity.
//
// The daemon tails each live checkout's reflog (cli gitActivity.ts) and posts
// what moved: commits, amends, checkouts, merges, pulls, rebases, resets,
// cherry-picks, reverts, and pushes seen on the remote-tracking branch. Each
// becomes an external_events row with source "git", so the team feed, the
// repository index and the session's own timeline carry it the same way they
// carry a GitHub push — and a commit also becomes a commits row, the same row a
// webhook would write later. The dedupe key for a commit is the one the
// webhook uses, so a commit seen locally and then pushed is one event.
//
// Who may see it is the directory team mapping's answer for the checkout path,
// exactly as for the rows the publish pass writes: a path whose sessions are
// shared with a team publishes its activity to that team, a private path
// publishes nothing.
//
// Attribution to a session: the daemon names one when a single live session
// sits in the checkout; otherwise the sha is matched to the session whose
// transcript printed it (file_changes, the same rule the webhook uses), and a
// commit that arrives before its transcript line is back-filled from
// messages.materializeFileChanges when the line lands.

import { v } from "convex/values";
import { mutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { getAuthenticatedUserId } from "./pendingMessages";
import { resolveCreationPrivacy } from "./privacy";
import { recordExternalEvent } from "./externalEvents";
import { resolveTaskLinksFromText, normalizeRepository } from "./lib/gitRefs";
import { conversationForCommit } from "./githubWebhooks";
import { upsertLocalCommit } from "./repos";

const KINDS = ["commit", "amend", "checkout", "merge", "pull", "rebase", "reset", "cherry_pick", "revert", "push"] as const;
type Kind = (typeof KINDS)[number];

const commitFields = v.object({
  sha: v.string(),
  message: v.string(),
  author_name: v.string(),
  author_email: v.string(),
  timestamp: v.number(),
  files_changed: v.number(),
  insertions: v.number(),
  deletions: v.number(),
  branch: v.optional(v.string()),
});

const event = v.object({
  kind: v.union(...KINDS.map((k) => v.literal(k))),
  old_sha: v.string(),
  new_sha: v.string(),
  at: v.number(),
  actor_name: v.string(),
  actor_email: v.string(),
  ref: v.optional(v.string()),
  from_ref: v.optional(v.string()),
  to_ref: v.optional(v.string()),
  message: v.string(),
  commit: v.optional(commitFields),
  /** The one live session in the checkout, when the daemon can say so. */
  conversation_id: v.optional(v.string()),
  /** How many commits a push carried (old..new), when the daemon counted. */
  commits_count: v.optional(v.number()),
});

const short = (sha: string) => sha.slice(0, 7);

/** The one line the feed shows for an event. */
export function localEventTitle(e: { kind: Kind; message: string; ref?: string; from_ref?: string; to_ref?: string; new_sha: string; branch?: string; commits_count?: number }): string {
  const subject = e.message.split("\n")[0].trim();
  switch (e.kind) {
    case "commit":
    case "cherry_pick":
    case "revert":
      return subject.slice(0, 200);
    case "amend":
      return `amended ${short(e.new_sha)}${subject ? `: ${subject}` : ""}`.slice(0, 200);
    case "checkout":
      return e.to_ref ? `switched to ${e.to_ref}${e.from_ref && e.from_ref !== e.to_ref ? ` from ${e.from_ref}` : ""}` : `checked out ${short(e.new_sha)}`;
    case "merge":
      return `merged ${e.ref ?? short(e.new_sha)}${e.branch ? ` into ${e.branch}` : ""}`;
    case "pull":
      return `pulled${e.branch ? ` ${e.branch}` : ""} to ${short(e.new_sha)}`;
    case "rebase":
      return `rebased${e.branch ? ` ${e.branch}` : ""} onto ${short(e.new_sha)}`;
    case "reset":
      return `reset${e.branch ? ` ${e.branch}` : ""} to ${e.ref ?? short(e.new_sha)}`;
    case "push":
      return `pushed ${e.ref ?? "a branch"}${e.commits_count ? ` (${e.commits_count} commit${e.commits_count === 1 ? "" : "s"})` : ""}`;
  }
}

export const recordLocal = mutation({
  args: {
    api_token: v.optional(v.string()),
    root: v.string(),
    repository: v.string(),
    remote_url: v.optional(v.string()),
    /** The branch checked out when the events happened, for the titles. */
    branch: v.optional(v.string()),
    events: v.array(event),
  },
  handler: async (ctx, args): Promise<{ published: boolean; reason?: "private"; recorded?: number }> => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Not authenticated");
    const privacy = await resolveCreationPrivacy(ctx, userId, args.root);
    if (!privacy.team_id || privacy.is_private) return { published: false, reason: "private" };
    const teamId = privacy.team_id;
    const repository = normalizeRepository(args.repository);
    const user = await ctx.db.get(userId);
    const actor = { actor_user_id: userId, actor_login: user?.github_username ?? undefined, actor_avatar_url: user?.github_avatar_url ?? undefined };

    let recorded = 0;
    for (const e of args.events) {
      const branch = e.commit?.branch ?? (e.kind === "push" ? e.ref : args.branch);
      let commitId: Id<"commits"> | undefined;
      let conversationId: Id<"conversations"> | undefined;
      if (e.commit) {
        const row = await upsertLocalCommit(ctx, {
          userId, teamId, repository,
          commit: { ...e.commit, branch: e.commit.branch ?? args.branch },
          claimedConversationId: e.conversation_id,
        });
        commitId = row.commit_id;
        conversationId = row.conversation_id;
      }
      if (!conversationId && e.conversation_id) {
        const id = ctx.db.normalizeId("conversations", e.conversation_id);
        const conv = id ? await ctx.db.get(id) : null;
        if (id && conv && conv.user_id === userId) conversationId = id;
      }
      // The transcript that printed this sha names the session, the way the
      // webhook resolves it; a commit whose line has not synced yet is
      // back-filled when it does (linkLocalCommitToConversation).
      if (!conversationId && e.commit) conversationId = await conversationForCommit(ctx, e.new_sha, branch);
      if (conversationId && commitId) {
        const row = await ctx.db.get(commitId);
        if (row && !row.conversation_id) await ctx.db.patch(commitId, { conversation_id: conversationId });
      }
      const links = e.commit ? await resolveTaskLinksFromText(ctx, e.commit.message, branch) : { task_ids: [], plan_ids: [], project_ids: [] };
      await recordExternalEvent(ctx, {
        source: "git",
        team_id: teamId,
        repository,
        kind: e.kind,
        ...actor,
        title: localEventTitle({ ...e, branch }),
        sha: e.new_sha,
        branch,
        commit_id: commitId,
        conversation_id: conversationId,
        task_ids: links.task_ids,
        plan_ids: links.plan_ids,
        project_ids: links.project_ids,
        meta: {
          from_sha: e.old_sha,
          from_ref: e.from_ref,
          to_ref: e.to_ref,
          ref: e.ref,
          commits_count: e.commits_count,
          ...(e.commit ? { additions: e.commit.insertions, deletions: e.commit.deletions, files_changed: e.commit.files_changed } : {}),
        },
        // A commit's key is the webhook's, so the push that follows folds into
        // this event instead of announcing the same commit twice.
        dedupe_key: e.kind === "commit" ? `commit:${e.new_sha}` : `git:${e.kind}:${repository}:${e.new_sha}:${e.at}`,
        created_at: e.at,
      });
      recorded++;
    }
    return { published: true, recorded };
  },
});

/**
 * A transcript just printed a commit hash: the commit row and event that
 * arrived from the reflog before this line synced now learn their session.
 * Called from messages.materializeFileChanges with the short hash git printed.
 */
export async function linkLocalCommitToConversation(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  shortSha: string,
): Promise<void> {
  const prefix = shortSha.toLowerCase();
  const candidates = await ctx.db
    .query("commits")
    .withIndex("by_sha", (q: any) => q.gte("sha", prefix).lt("sha", prefix + "\uffff"))
    .take(5);
  const conversation = await ctx.db.get(conversationId);
  for (const row of candidates) {
    if (!row.sha.startsWith(prefix) || row.conversation_id) continue;
    // The session's own team is the row's team when both are known; a same
    // prefix in another team's repository is someone else's commit.
    if (conversation?.team_id && row.team_id && conversation.team_id !== row.team_id) continue;
    await ctx.db.patch(row._id, { conversation_id: conversationId });
    const evt = await ctx.db
      .query("external_events")
      .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", `commit:${row.sha}`))
      .first();
    if (evt && !evt.conversation_id) await ctx.db.patch(evt._id, { conversation_id: conversationId });
  }
}
