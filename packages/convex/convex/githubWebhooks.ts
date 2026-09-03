// GitHub webhook ingestion.
//
// One route stores every delivery (http.ts), and this file turns deliveries
// into codecast state: pull request rows that mirror what GitHub knows, review
// and check history, commits linked back to the sessions that wrote them, one
// git_event per thing that happened, and a wake for the session shepherding the
// pull request.
//
// Three rules hold the whole file together:
//   • Every processor patches a pull request through prShepherd.patchPullRequest,
//     so the folded fields (checks_state, shepherd_state, the session card's
//     pr_status) can never disagree with the raw ones.
//   • Every processor records its event through gitEvents.recordGitEvent with a
//     dedupe key, so a redelivery costs nothing.
//   • Every stored delivery ends up processed, whether or not anything handled
//     it. An unhandled row left unprocessed sits in the by_processed index
//     forever and every catch-up sweep pays for it again.

import { v } from "convex/values";
import { internalMutation, internalAction, internalQuery } from "./functions";
import { internal, api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { teamVisibleConvTeam } from "./privacy";
import { recordPRMergedActivity } from "./pull_requests";
import { recordExternalEvent } from "./externalEvents";
import {
  patchPullRequest,
  firePrTrigger as fireTrigger,
  recomputeReviewDecision,
  wakeShepherd,
  ensureShepherdTask,
  closeOutShepherd,
  refreshConversationPrStatus,
} from "./prShepherd";
import {
  type CheckEntry,
  commitUrl,
  extractTaskShortIds,
  prUrl,
  resolveTaskLinks,
  normalizeRepository,
  resolveTaskLinksFromText,
  shortSha,
} from "./lib/gitRefs";

const MERGE_STATE_DELAY_MS = 15 * 1000;
// A finished check changes whether GitHub will let the branch merge, but it
// recomputes mergeable_state lazily: until something asks, the PR reads
// "unstable" and `cast pr show` disagrees with itself. Asking shortly after the
// checks settle is what closes that gap.
const CHECK_MERGE_STATE_DELAY_MS = 10 * 1000;

// Event kinds some processor consumes. A delivery of any other kind is stored
// for the record and marked processed on the spot.
const HANDLED_EVENT_TYPES = new Set([
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "push",
  "check_run",
  "check_suite",
  "status",
  "issues",
  "issue_comment",
  "pull_request_review_thread",
]);

// GitHub reports a conclusion on every finished check; only these mean the
// check did not stand in the way.
const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

function isFailingCheck(entry: { status: string; conclusion?: string }): boolean {
  return entry.status === "completed" && !!entry.conclusion && !PASSING_CONCLUSIONS.has(entry.conclusion);
}

function actorFrom(payload: any): { actor_login?: string; actor_avatar_url?: string } {
  const sender = payload?.sender ?? payload?.comment?.user ?? payload?.review?.user;
  return { actor_login: sender?.login, actor_avatar_url: sender?.avatar_url };
}

/**
 * The team a repository's activity routes to: the team that installed the App
 * on its owner account. Routing only — it grants nobody access on its own.
 */
export async function resolveTeamForRepository(
  ctx: { db: any },
  repository: string,
): Promise<Id<"teams"> | null> {
  const [owner] = repository.split("/");
  const installation = await ctx.db
    .query("github_app_installations")
    .withIndex("by_account_login", (q: any) => q.eq("account_login", owner))
    .first();
  return installation?.team_id ?? null;
}

async function prByNumber(ctx: { db: any }, repository: string, number: number) {
  return await ctx.db
    .query("pull_requests")
    .withIndex("by_repository_number", (q: any) => q.eq("repository", repository).eq("number", number))
    .first();
}

/**
 * The pull requests a check or a commit status belongs to.
 *
 * GitHub names the pull requests on a check_run when it can, but leaves the
 * list empty for forks and for checks on a branch with no PR yet. head_sha is
 * the fallback, and a sha that matches nothing simply has no PR to update.
 */
async function prsForSha(
  ctx: { db: any },
  repository: string,
  prRefs: Array<{ number: number }> | undefined,
  headSha: string | undefined,
): Promise<Doc<"pull_requests">[]> {
  const found: Doc<"pull_requests">[] = [];
  for (const ref of prRefs ?? []) {
    const pr = await prByNumber(ctx, repository, ref.number);
    if (pr) found.push(pr);
  }
  if (found.length) return found;
  if (!headSha) return [];

  const all: Doc<"pull_requests">[] = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .collect();
  return all.filter((pr) => pr.state === "open" && pr.head_sha === headSha);
}

/**
 * An entry we invented from a check_suite because no per-run detail arrived.
 * The prefix is written by processCheckSuiteEvent and read only here.
 */
function isSyntheticSuite(entry: CheckEntry): boolean {
  return !!entry.external_id?.startsWith("suite:");
}

/**
 * Replace a check by NAME.
 *
 * GitHub issues a fresh check_run id every time a check re-runs, so keying on
 * that id files the re-run as a SECOND check and leaves the old failure
 * standing beside it. checks_state would then read failure forever, never
 * return to success, and the green wake would be unreachable. The name is the
 * stable identity across re-runs, and matrix legs already carry distinct names
 * ("test (ubuntu)"). The id stays on the entry as metadata.
 *
 * Real detail also evicts any synthetic suite entry, which only ever stood in
 * for per-run detail that had not arrived yet.
 */
function upsertCheck(existing: CheckEntry[] | undefined, entry: CheckEntry): CheckEntry[] {
  const incomingIsReal = !isSyntheticSuite(entry);
  const rest = (existing ?? []).filter(
    (c) => c.name !== entry.name && !(incomingIsReal && isSyntheticSuite(c)),
  );
  return [...rest, entry];
}

export const storeWebhookEvent = internalMutation({
  args: {
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_delivery_id", (q) => q.eq("delivery_id", args.delivery_id))
      .first();

    if (existing) {
      return { success: true, duplicate: true };
    }

    const handled = HANDLED_EVENT_TYPES.has(args.event_type);
    const eventId = await ctx.db.insert("github_webhook_events", {
      delivery_id: args.delivery_id,
      event_type: args.event_type,
      action: args.action,
      payload: args.payload,
      processed: !handled,
      created_at: Date.now(),
    });

    let payload: any = null;
    try {
      payload = JSON.parse(args.payload);
    } catch {}
    const repository: string | undefined = normalizeRepository(payload?.repository?.full_name);
    const prNumber: number | undefined = payload?.pull_request?.number ?? payload?.issue?.number;

    if (args.event_type === "pull_request") {
      if (args.action === "opened") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPROpenedEvent, { event_id: eventId });
      } else if (args.action === "synchronize") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPRSynchronizeEvent, { event_id: eventId });
      } else if (args.action === "closed") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPRClosedEvent, { event_id: eventId });
      } else {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPRMetaEvent, { event_id: eventId });
      }
    } else if (args.event_type === "push") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPushEvent, { event_id: eventId });
    } else if (args.event_type === "pull_request_review") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processReviewEvent, { event_id: eventId });
    } else if (args.event_type === "pull_request_review_comment") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processReviewCommentEvent, { event_id: eventId });
    } else if (args.event_type === "check_run") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processCheckRunEvent, { event_id: eventId });
    } else if (args.event_type === "check_suite") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processCheckSuiteEvent, { event_id: eventId });
    } else if (args.event_type === "status") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processStatusEvent, { event_id: eventId });
    } else if (args.event_type === "pull_request_review_thread") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processReviewThreadEvent, { event_id: eventId });
    }

    // Issue sync (docs/architecture/issue-sync.md S6). Deliberately its own
    // statement rather than another arm of the chain above: that chain is the
    // pull-request pipeline, and an issue is a task's twin, not a PR event.
    //
    // GitHub sends PR comments as `issue_comment` too, told apart only by
    // `issue.pull_request` being present. Those belong to the review pipeline
    // (handleIssueCommentCreated), so only a comment on a REAL issue is handed
    // to issue sync. Both consumers see the same row, so issueSync's handler
    // must not assume it is the one that flips `processed`.
    if (args.event_type === "issues") {
      void ctx.scheduler.runAfter(0, internal.issueSync.onGithubIssue, { event_id: eventId });
    } else if (args.event_type === "issue_comment" && payload?.issue && !payload.issue.pull_request) {
      void ctx.scheduler.runAfter(0, internal.issueSync.onGithubIssueComment, { event_id: eventId });
    }

    // The raw GitHub shorthands ("pull_request" + action), kept working for
    // triggers armed before the derived names existed. The team comes from the
    // installation that sent the delivery, so these are scoped like the derived
    // events; a repository we have no installation for resolves to nothing and
    // matches as it always did.
    void ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
      event_type: args.event_type,
      action: args.action,
      repository,
      pr_number: prNumber,
      team_id: repository ? ((await resolveTeamForRepository(ctx, repository)) ?? undefined) : undefined,
    });

    return { success: true, duplicate: false };
  },
});

// ── Pull requests ──

export const processPROpenedEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string; comment_posted?: boolean; files_synced?: boolean }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const pr = payload.pull_request;
    const repository = payload.repository;

    const repositoryFullName: string = normalizeRepository(repository.full_name);
    const prNumber: number = pr.number;
    const headRef: string = pr.head.ref;

    const result = await ctx.runMutation(internal.githubWebhooks.matchPRToConversation, {
      event_id: args.event_id,
      repository: repositoryFullName,
      pr_number: prNumber,
      head_ref: headRef,
      base_ref: pr.base?.ref,
      github_pr_id: pr.id,
      title: pr.title,
      body: pr.body || "",
      author_username: pr.user.login,
      author_avatar_url: pr.user.avatar_url,
      head_sha: pr.head?.sha,
      base_sha: pr.base?.sha,
      draft: !!pr.draft,
      requested_reviewers: (pr.requested_reviewers ?? []).map((r: any) => r.login),
      created_at: new Date(pr.created_at).getTime(),
      updated_at: new Date(pr.updated_at).getTime(),
    });

    let filesSynced = false;
    if (result.pr_id) {
      let token = result.github_access_token;

      const installation = result.team_id ? await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, {
        repository: repositoryFullName,
        team_id: result.team_id,
      }) : null;

      if (installation) {
        try {
          const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
            installation_id: installation.installation_id,
          });
          token = tokenResult.token;
        } catch (error) {
          console.error("Failed to get installation token, falling back to user token:", error);
        }
      }

      if (token) {
        try {
          const filesData = await ctx.runAction(internal.githubApi.getPRFiles, {
            repository: repositoryFullName,
            pr_number: prNumber,
            github_access_token: token,
          });

          await ctx.runMutation(internal.pull_requests.updatePRFiles, {
            pr_id: result.pr_id,
            files: filesData.files,
            additions: filesData.additions,
            deletions: filesData.deletions,
            changed_files: filesData.changed_files,
            commits_count: filesData.commits_count,
            base_ref: filesData.base_ref,
          });
          filesSynced = true;
        } catch (error) {
          console.error("Failed to fetch PR files:", error);
        }
      }
    }

    if (result.matched_conversation_id && result.pr_id) {
      const postResult: { posted: boolean; reason?: string } = await ctx.runMutation(internal.githubWebhooks.postPRCommentIfNeeded, {
        pr_id: result.pr_id,
        conversation_id: result.matched_conversation_id,
        repository: repositoryFullName,
        pr_number: prNumber,
      });

      return { success: true, comment_posted: postResult.posted, files_synced: filesSynced };
    }

    return { success: true, comment_posted: false, files_synced: filesSynced };
  },
});

export const processPRSynchronizeEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const pr = payload.pull_request;
    const repositoryFullName: string = normalizeRepository(payload.repository.full_name);
    const prNumber: number = pr.number;
    const githubPrId: number = pr.id;

    const prData = await ctx.runQuery(internal.githubWebhooks.getPRByGithubId, {
      github_pr_id: githubPrId,
    });

    if (!prData) {
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: "PR not found in database" };
    }

    // A new head commit invalidates every check that ran on the old one, so the
    // check list resets here rather than lingering green over new code.
    await ctx.runMutation(internal.githubWebhooks.applyPRSynchronize, {
      pr_id: prData._id,
      head_sha: pr.head?.sha,
      base_sha: pr.base?.sha,
      draft: !!pr.draft,
      actor_login: payload.sender?.login,
      actor_avatar_url: payload.sender?.avatar_url,
    });

    let token: string | null = null;

    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, {
      repository: repositoryFullName,
      team_id: prData.team_id as Id<"teams">,
    });

    if (installation) {
      try {
        const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
          installation_id: installation.installation_id,
        });
        token = tokenResult.token;
      } catch (error) {
        console.error("Failed to get installation token:", error);
      }
    }

    if (!token) {
      token = await ctx.runQuery(internal.githubWebhooks.getTokenForPR, {
        pr_id: prData._id,
      });
    }

    if (!token) {
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: "No GitHub token available" };
    }

    try {
      const filesData = await ctx.runAction(internal.githubApi.getPRFiles, {
        repository: repositoryFullName,
        pr_number: prNumber,
        github_access_token: token,
      });

      await ctx.runMutation(internal.pull_requests.updatePRFiles, {
        pr_id: prData._id,
        files: filesData.files,
        additions: filesData.additions,
        deletions: filesData.deletions,
        changed_files: filesData.changed_files,
        commits_count: filesData.commits_count,
        base_ref: filesData.base_ref,
      });

      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: true };
    } catch (error) {
      console.error("Failed to sync PR files on synchronize:", error);
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: `Error: ${error}` };
    }
  },
});

export const applyPRSynchronize = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    actor_login: v.optional(v.string()),
    actor_avatar_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await patchPullRequest(ctx, args.pr_id, {
      head_sha: args.head_sha,
      base_sha: args.base_sha,
      draft: args.draft,
      checks: [],
    });
    if (!result) return { ok: false };
    const pr = result.pr;

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: pr.team_id,
      repository: pr.repository,
      kind: "pr_synchronize",
      actor_login: args.actor_login,
      actor_avatar_url: args.actor_avatar_url,
      title: `PR #${pr.number} updated to ${shortSha(args.head_sha)}`,
      url: prUrl(pr.repository, pr.number),
      sha: args.head_sha,
      branch: pr.head_ref,
      pr_id: pr._id,
      pr_number: pr.number,
      conversation_id: pr.shepherd_conversation_id,
      task_ids: pr.task_ids,
      meta: { head_ref: pr.head_ref, base_ref: pr.base_ref },
      dedupe_key: `pr_synchronize:${pr._id}:${args.head_sha ?? ""}`,
    });

    await fireTrigger(ctx, "pr_synchronize", pr);
    // GitHub recomputes mergeability lazily after a push, so ask a little later.
    await ctx.scheduler.runAfter(MERGE_STATE_DELAY_MS, internal.prShepherd.refreshMergeState, {
      pr_id: pr._id,
      attempt: 0,
    });
    return { ok: true };
  },
});

export const processPRClosedEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false, reason: "Event not found" };

    const payload = JSON.parse(event.payload) as any;
    const prPayload = payload.pull_request;
    const merged: boolean = !!prPayload.merged;
    const mergedAt: string | null = prPayload.merged_at;
    const closedAt: string | null = prPayload.closed_at;

    const existing = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", prPayload.id))
      .first();

    if (!existing) {
      await ctx.db.patch(args.event_id, { processed: true });
      return { success: false, reason: "PR not found in database" };
    }

    const result = await patchPullRequest(ctx, existing._id, {
      state: merged ? "merged" : "closed",
      merged_at: mergedAt ? new Date(mergedAt).getTime() : undefined,
      closed_at: closedAt ? new Date(closedAt).getTime() : Date.now(),
    });
    if (!result) {
      await ctx.db.patch(args.event_id, { processed: true });
      return { success: false, reason: "PR vanished" };
    }
    const pr = result.pr;

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: pr.team_id,
      repository: pr.repository,
      kind: merged ? "pr_merged" : "pr_closed",
      ...actorFrom(payload),
      title: merged
        ? `Merged PR #${pr.number}: ${pr.title}`
        : `Closed PR #${pr.number}: ${pr.title}`,
      url: prUrl(pr.repository, pr.number),
      sha: pr.head_sha,
      branch: pr.head_ref,
      pr_id: pr._id,
      pr_number: pr.number,
      conversation_id: pr.shepherd_conversation_id,
      task_ids: pr.task_ids,
      plan_ids: undefined,
      meta: { pr_state: merged ? "merged" : "closed", base_ref: pr.base_ref, head_ref: pr.head_ref },
      dedupe_key: `pr_${merged ? "merged" : "closed"}:${pr._id}`,
    });

    await recordPRMergedActivity(ctx, pr, existing.state, pr.state);
    await fireTrigger(ctx, merged ? "pr_merged" : "pr_closed", pr);
    await closeOutShepherd(ctx, pr, merged ? "merged" : "closed");

    await ctx.db.patch(args.event_id, { processed: true });
    return { success: true };
  },
});

/**
 * Everything else a pull request can do: reopened, edited, marked ready or
 * back to draft, reviewers requested or withdrawn. None of it needs a call to
 * GitHub, so it is one mutation.
 */
export const processPRMetaEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const prPayload = payload.pull_request;
    if (!prPayload) return { success: false };

    const existing = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", prPayload.id))
      .first();
    if (!existing) return { success: false, reason: "PR not found in database" };

    const action = event.action ?? "";
    const requested = (prPayload.requested_reviewers ?? []).map((r: any) => r.login);
    const links = await resolveTaskLinksFromText(ctx, prPayload.title, prPayload.body, prPayload.head?.ref);

    const patch: Record<string, any> = {
      title: prPayload.title,
      body: prPayload.body ?? "",
      draft: !!prPayload.draft,
      head_sha: prPayload.head?.sha,
      base_sha: prPayload.base?.sha,
      base_ref: prPayload.base?.ref,
      requested_reviewers: requested,
      task_ids: links.task_ids.length ? links.task_ids : existing.task_ids,
    };
    if (action === "reopened") {
      patch.state = "open";
      patch.closed_at = undefined;
    }

    const result = await patchPullRequest(ctx, existing._id, patch);
    if (!result) return { success: false };
    const pr = result.pr;

    const kind =
      action === "reopened" ? "pr_reopened"
      : action === "ready_for_review" ? "pr_ready_for_review"
      : action === "converted_to_draft" ? "pr_draft"
      : action === "review_requested" || action === "review_request_removed" ? "pr_review_requested"
      : "pr_edited";

    const requestedLogin = prPayload.requested_reviewer?.login ?? prPayload.requested_team?.name;
    const title =
      action === "reopened" ? `Reopened PR #${pr.number}: ${pr.title}`
      : action === "ready_for_review" ? `PR #${pr.number} is ready for review`
      : action === "converted_to_draft" ? `PR #${pr.number} went back to draft`
      : action === "review_requested" ? `Review requested from ${requestedLogin ?? "a reviewer"} on PR #${pr.number}`
      : action === "review_request_removed" ? `Review request withdrawn on PR #${pr.number}`
      : `PR #${pr.number} edited`;

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: pr.team_id,
      repository: pr.repository,
      kind,
      ...actorFrom(payload),
      title,
      url: prUrl(pr.repository, pr.number),
      sha: pr.head_sha,
      branch: pr.head_ref,
      pr_id: pr._id,
      pr_number: pr.number,
      conversation_id: pr.shepherd_conversation_id,
      task_ids: pr.task_ids,
      plan_ids: links.plan_ids,
      project_ids: links.project_ids,
      meta: { pr_state: pr.state, head_ref: pr.head_ref, base_ref: pr.base_ref },
      dedupe_key: `pr_meta:${pr._id}:${action}:${event.delivery_id}`,
    });

    if (action === "reopened") await fireTrigger(ctx, "pr_opened", pr);
    if (action === "ready_for_review") await fireTrigger(ctx, "pr_ready", pr);
    if (action === "review_requested") {
      await fireTrigger(ctx, "pr_review_requested", pr);
      await wakeShepherd(ctx, pr._id, "review_requested", requestedLogin ? `requested from ${requestedLogin}` : undefined);
    }

    return { success: true };
  },
});

// ── Reviews ──

// GitHub's review states, mapped onto the four this schema stores. A dismissed
// review has been withdrawn, so it lands as "commented": present in the history,
// counted by nothing.
function mapReviewState(state: string | undefined): "approved" | "changes_requested" | "commented" {
  const normalized = (state ?? "").toLowerCase();
  if (normalized === "approved") return "approved";
  if (normalized === "changes_requested") return "changes_requested";
  return "commented";
}

export const processReviewEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const review = payload.review;
    const prPayload = payload.pull_request;
    if (!review || !prPayload) return { success: false };

    const repository: string = normalizeRepository(payload.repository?.full_name ?? prPayload.base?.repo?.full_name);
    const pr = await prByNumber(ctx, repository, prPayload.number);
    if (!pr) return { success: false, reason: "PR not found in database" };

    const state = mapReviewState(review.state);
    const author: string = review.user?.login ?? "someone";
    const submittedAt = review.submitted_at ? new Date(review.submitted_at).getTime() : Date.now();

    const existing = await ctx.db
      .query("reviews")
      .withIndex("by_github_review_id", (q) => q.eq("github_review_id", review.id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        state,
        body: review.body ?? undefined,
        submitted_at: submittedAt,
        commit_sha: review.commit_id,
        html_url: review.html_url,
      });
    } else {
      await ctx.db.insert("reviews", {
        pull_request_id: pr._id,
        author_github_username: author,
        github_review_id: review.id,
        commit_sha: review.commit_id,
        html_url: review.html_url,
        state,
        body: review.body ?? undefined,
        submitted_at: submittedAt,
      });
    }

    const decision = await recomputeReviewDecision(ctx, pr);
    const result = await patchPullRequest(ctx, pr._id, { review_decision: decision });
    if (!result) return { success: false };
    const updated = result.pr;

    const stateWords =
      state === "approved" ? "approved"
      : state === "changes_requested" ? "requested changes"
      : "commented";

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: updated.team_id,
      repository: updated.repository,
      kind: "pr_review",
      actor_login: author,
      actor_avatar_url: review.user?.avatar_url,
      title: `Review: ${stateWords} by ${author} on PR #${updated.number}`,
      summary: review.body ? String(review.body).slice(0, 400) : undefined,
      url: review.html_url ?? prUrl(updated.repository, updated.number),
      sha: review.commit_id,
      branch: updated.head_ref,
      pr_id: updated._id,
      pr_number: updated.number,
      conversation_id: updated.shepherd_conversation_id,
      task_ids: updated.task_ids,
      meta: { review_state: state },
      dedupe_key: `pr_review:${updated._id}:${review.id}:${event.action ?? "submitted"}`,
    });

    await fireTrigger(ctx, "pr_review", updated);
    if (state === "approved") await fireTrigger(ctx, "pr_approved", updated);
    if (state === "changes_requested") await fireTrigger(ctx, "pr_changes_requested", updated);

    // A bare "commented" review with no body says nothing the agent can act on.
    const worthWaking = state !== "commented" || !!review.body;
    if (worthWaking && event.action !== "dismissed") {
      await wakeShepherd(
        ctx,
        updated._id,
        state === "changes_requested" ? "changes_requested" : "review_submitted",
        `${author} ${stateWords}`,
      );
    }

    return { success: true };
  },
});

// ── Review comments ──

/**
 * Take one inbound review comment into the code comment table.
 *
 * Shared by the immediate processor and the catch-up sweep, so both paths
 * produce the same rows, the same event and the same wake. Idempotent: a
 * comment we already hold (including one codecast itself posted, which stores
 * its GitHub id at mirror time) is skipped.
 */
async function ingestReviewComment(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;
  const pullRequest = payload.pull_request;
  if (!comment || !pullRequest) return false;

  // The legacy marker, from before mirrored comments stored their GitHub id.
  if (comment.body?.includes("codecast_comment_id:")) return false;

  const repository: string = normalizeRepository(payload.repository?.full_name ?? pullRequest.base?.repo?.full_name);
  const pr = await prByNumber(ctx, repository, pullRequest.number);
  if (!pr) return false;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();
  if (existing) return false;

  const rangeEnd: number | undefined = comment.line ?? comment.original_line;
  const rangeStart: number | undefined = comment.start_line ?? comment.original_start_line;

  const commentId = await ctx.db.insert("review_comments", {
    pull_request_id: pr._id,
    repository,
    ref: comment.commit_id ?? pr.head_sha,
    github_comment_id: comment.id,
    github_review_id: comment.pull_request_review_id ?? undefined,
    github_in_reply_to_id: comment.in_reply_to_id ?? undefined,
    html_url: comment.html_url,
    file_path: comment.path,
    // One convention in both directions: line_number is where the range starts,
    // line_end where it ends. GitHub reports the opposite way round, naming the
    // END `line` and only adding `start_line` for a range, so a range used to
    // be stored with both ends set to the end.
    line_number: rangeStart ?? rangeEnd,
    line_end: rangeStart != null ? rangeEnd : undefined,
    side: comment.side,
    content: comment.body,
    resolved: false,
    created_at: new Date(comment.created_at).getTime(),
    updated_at: new Date(comment.updated_at).getTime(),
    author_github_username: comment.user?.login,
    author_kind: "github" as const,
    author_avatar_url: comment.user?.avatar_url,
    conversation_id: pr.shepherd_conversation_id,
    codecast_origin: false,
  });

  const author = comment.user?.login ?? "someone";
  const anchor = rangeStart ?? rangeEnd;
  const span = rangeStart != null && rangeEnd !== rangeStart ? `-${rangeEnd}` : "";
  const where = comment.path ? `${comment.path}${anchor ? `:${anchor}${span}` : ""}` : "the pull request";

  await recordExternalEvent(ctx, {
    source: "github",
    team_id: pr.team_id,
    repository,
    kind: "pr_review_comment",
    actor_login: author,
    actor_avatar_url: comment.user?.avatar_url,
    title: `${author} commented on ${where} in PR #${pr.number}`,
    summary: String(comment.body ?? "").slice(0, 400),
    url: comment.html_url,
    sha: comment.commit_id ?? pr.head_sha,
    branch: pr.head_ref,
    pr_id: pr._id,
    pr_number: pr.number,
    comment_id: commentId,
    conversation_id: pr.shepherd_conversation_id,
    task_ids: pr.task_ids,
    meta: { file_path: comment.path, line_number: anchor, line_end: rangeStart != null ? rangeEnd : undefined },
    dedupe_key: `pr_review_comment:${comment.id}`,
  });

  await wakeShepherd(ctx, pr._id, "review_comment_created", `${author} on ${where}`);
  return true;
}

export const processReviewCommentEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };

    const payload = JSON.parse(event.payload) as any;
    let handled = false;
    if (event.action === "created") handled = await ingestReviewComment(ctx, payload);
    else if (event.action === "edited") handled = await handleReviewCommentEdited(ctx, payload);
    else if (event.action === "deleted") handled = await handleReviewCommentDeleted(ctx, payload);

    await ctx.db.patch(args.event_id, { processed: true });
    return { success: true, handled };
  },
});

/**
 * A review thread was resolved or unresolved on GitHub.
 *
 * Resolution is the only part of a review conversation that lives purely in
 * GitHub's UI: nothing about a comment changes when someone clicks "Resolve".
 * Without this event a thread the reviewer already closed stays outstanding
 * here forever, and every later wake keeps asking the shepherd to answer it.
 *
 * The payload carries the whole thread, so every comment in it is marked at
 * once rather than inferring resolution from the one that happened to be last.
 */
export const processReviewThreadEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const action: string = event.action ?? payload.action;
    if (action !== "resolved" && action !== "unresolved") return { success: true, skipped: true };

    const resolved = action === "resolved";
    const resolvedAt = resolved ? Date.now() : undefined;

    let marked = 0;
    for (const comment of payload.thread?.comments ?? []) {
      if (comment?.id == null) continue;
      const row = await ctx.db
        .query("review_comments")
        .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
        .first();
      if (!row) continue;
      await ctx.db.patch(row._id, { resolved, resolved_at: resolvedAt });
      marked++;
    }

    return { success: true, resolved, marked };
  },
});

// ── Checks and commit statuses ──

/**
 * Fold one check result into a pull request and act on what changed.
 *
 * A failure is worth saying out loud every time it happens, because each one is
 * a new thing to fix. Green is worth saying only on the way back from red or
 * from waiting: a repository whose checks pass all day should not wake anybody.
 */
async function applyCheckToPR(
  ctx: any,
  pr: Doc<"pull_requests">,
  entry: CheckEntry,
  actor: { actor_login?: string; actor_avatar_url?: string },
): Promise<void> {
  const before = pr.checks_state;
  const result = await patchPullRequest(ctx, pr._id, { checks: upsertCheck(pr.checks, entry) });
  if (!result) return;
  const updated = result.pr;

  // Once the checks have settled either way, ask GitHub to recompute whether the
  // branch merges. Deliberately gated on the FOLDED state rather than on this
  // one entry: a twenty leg matrix would otherwise queue twenty refreshes, and
  // every one of them spends two API calls to learn the same thing.
  if (entry.status === "completed" && updated.checks_state !== "pending") {
    await ctx.scheduler?.runAfter(CHECK_MERGE_STATE_DELAY_MS, internal.prShepherd.refreshMergeState, {
      pr_id: updated._id,
      attempt: 0,
    });
  }

  if (isFailingCheck(entry)) {
    await recordExternalEvent(ctx, {
      source: "github",
      team_id: updated.team_id,
      repository: updated.repository,
      kind: "pr_check",
      ...actor,
      title: `CI failed: ${entry.name}`,
      url: entry.url,
      sha: updated.head_sha,
      branch: updated.head_ref,
      pr_id: updated._id,
      pr_number: updated.number,
      conversation_id: updated.shepherd_conversation_id,
      task_ids: updated.task_ids,
      meta: { check_name: entry.name, status: entry.status, conclusion: entry.conclusion },
      dedupe_key: `pr_check:${updated._id}:${entry.external_id ?? entry.name}:${updated.head_sha ?? ""}:${entry.conclusion}`,
    });
    await fireTrigger(ctx, "pr_check_failed", updated);
    await wakeShepherd(ctx, updated._id, "check_failed", `${entry.name} ${entry.conclusion}`);
    return;
  }

  if (updated.checks_state === "success" && before !== "success") {
    await recordExternalEvent(ctx, {
      source: "github",
      team_id: updated.team_id,
      repository: updated.repository,
      kind: "pr_check",
      ...actor,
      title: `CI passed on PR #${updated.number}`,
      url: prUrl(updated.repository, updated.number),
      sha: updated.head_sha,
      branch: updated.head_ref,
      pr_id: updated._id,
      pr_number: updated.number,
      conversation_id: updated.shepherd_conversation_id,
      task_ids: updated.task_ids,
      meta: { status: "completed", conclusion: "success" },
      dedupe_key: `pr_checks_green:${updated._id}:${updated.head_sha ?? ""}`,
    });
    await fireTrigger(ctx, "pr_checks_green", updated);
    await wakeShepherd(ctx, updated._id, "checks_green");
  }
}

export const processCheckRunEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const run = payload.check_run;
    const repository: string | undefined = normalizeRepository(payload.repository?.full_name);
    if (!run || !repository) return { success: false };

    const prs = await prsForSha(ctx, repository, run.pull_requests, run.head_sha);
    if (prs.length === 0) return { success: true, prs: 0, reason: "no PR for this head" };

    const entry: CheckEntry = {
      name: run.name,
      status: run.status,
      conclusion: run.conclusion ?? undefined,
      url: run.html_url ?? run.details_url,
      updated_at: Date.now(),
      external_id: String(run.id),
    };

    for (const pr of prs) {
      await applyCheckToPR(ctx, pr, entry, actorFrom(payload));
    }
    return { success: true, prs: prs.length };
  },
});

/**
 * A finished check suite, used only when no individual check_run reached us
 * (a provider that reports suites alone). With per-run detail in hand the suite
 * would say the same thing twice, so it stands aside.
 */
export const processCheckSuiteEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const suite = payload.check_suite;
    const repository: string | undefined = normalizeRepository(payload.repository?.full_name);
    if (!suite || !repository || suite.status !== "completed") return { success: true, skipped: true };

    const prs = await prsForSha(ctx, repository, suite.pull_requests, suite.head_sha);
    let applied = 0;
    for (const pr of prs) {
      // A PR's checks belong to its current head (synchronize clears them), so a
      // suite for an older head is stale and must not speak for the new one.
      if (suite.head_sha && pr.head_sha && suite.head_sha !== pr.head_sha) continue;
      // Webhook order is not guaranteed. Standing aside means standing aside for
      // REAL per-run detail, whether it arrived before this suite or after: a
      // previous synthetic entry of our own is no reason to stay quiet.
      if ((pr.checks ?? []).some((c) => !isSyntheticSuite(c))) continue;
      const entry: CheckEntry = {
        name: suite.app?.name ? `${suite.app.name} checks` : "checks",
        status: "completed",
        conclusion: suite.conclusion ?? undefined,
        url: prUrl(repository, pr.number),
        updated_at: Date.now(),
        external_id: `suite:${suite.id}`,
      };
      await applyCheckToPR(ctx, pr, entry, actorFrom(payload));
      applied++;
    }
    return { success: true, prs: applied };
  },
});

export const processStatusEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const repository: string | undefined = normalizeRepository(payload.repository?.full_name);
    const sha: string | undefined = payload.sha;
    const context: string | undefined = payload.context;
    if (!repository || !sha || !context) return { success: false };

    const state: string = payload.state;
    const entry: CheckEntry = {
      name: context,
      status: state === "pending" ? "in_progress" : "completed",
      conclusion: state === "pending" ? undefined : state === "success" ? "success" : "failure",
      url: payload.target_url ?? undefined,
      updated_at: Date.now(),
      external_id: `status:${context}`,
    };

    const prs = await prsForSha(ctx, repository, undefined, sha);
    for (const pr of prs) {
      await applyCheckToPR(ctx, pr, entry, actorFrom(payload));
    }
    return { success: true, prs: prs.length };
  },
});

// ── Pushes and commits ──

/**
 * The session that wrote a commit.
 *
 * Sessions record every edit they make (file_changes), and a commit made from a
 * session stores a short hash there. Stored hashes are prefixes, so every stored
 * prefix of a full sha sorts inside [first seven chars, full sha] — the same
 * range scan `cast blame` uses. When no edit row names the sha, a branch that
 * exactly one session is sitting on is good enough evidence; two sessions on the
 * same branch is not, so the commit stays unattributed.
 */
async function conversationForCommit(
  ctx: { db: any },
  sha: string,
  branch: string | undefined,
): Promise<Id<"conversations"> | undefined> {
  const prefix = sha.slice(0, 7);
  const candidates = await ctx.db
    .query("file_changes")
    .withIndex("by_commit_hash", (q: any) => q.gte("commit_hash", prefix).lte("commit_hash", sha))
    .take(50);
  const match = candidates.find((row: any) => row.commit_hash && sha.startsWith(row.commit_hash));
  if (match) return match.conversation_id;

  if (!branch) return undefined;
  const onBranch = await ctx.db
    .query("conversations")
    .withIndex("by_git_branch", (q: any) => q.eq("git_branch", branch))
    .take(5);
  return onBranch.length === 1 ? onBranch[0]._id : undefined;
}

export const processPushEvent = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string; commits_created?: number }> => {
    const event = await ctx.db.get(args.event_id);
    if (!event) return { success: false, reason: "Event not found" };
    await ctx.db.patch(args.event_id, { processed: true });

    const payload = JSON.parse(event.payload) as any;
    const repository: string = normalizeRepository(payload.repository?.full_name);
    const commits: any[] = payload.commits ?? [];
    const ref: string = payload.ref ?? "";

    if (!repository || commits.length === 0) {
      return { success: true, reason: "No commits in push event", commits_created: 0 };
    }
    if (!ref.startsWith("refs/heads/")) {
      return { success: true, reason: "Not a branch push", commits_created: 0 };
    }

    const branch = ref.replace("refs/heads/", "");
    const teamId = await resolveTeamForRepository(ctx, repository);
    if (!teamId) return { success: true, reason: "No installation for this repository", commits_created: 0 };

    const pusher: string | undefined = payload.pusher?.name ?? payload.sender?.login;
    const pusherAvatar: string | undefined = payload.sender?.avatar_url;
    const branchLinks = await resolveTaskLinks(ctx, extractTaskShortIds(branch));

    let created = 0;
    let firstConversation: Id<"conversations"> | undefined;
    for (const commit of commits) {
      const sha: string = commit.id;
      const message: string = commit.message ?? "";
      const added = commit.added?.length ?? 0;
      const removed = commit.removed?.length ?? 0;
      const modified = commit.modified?.length ?? 0;

      const links = await resolveTaskLinksFromText(ctx, message, branch);
      const conversationId = await conversationForCommit(ctx, sha, branch);
      if (!firstConversation) firstConversation = conversationId;

      const existing = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q: any) => q.eq("sha", sha))
        .first();

      let commitId: Id<"commits">;
      if (existing) {
        commitId = existing._id;
        await ctx.db.patch(existing._id, {
          team_id: existing.team_id ?? teamId,
          branch: existing.branch ?? branch,
          author_login: existing.author_login ?? commit.author?.username,
          author_avatar_url: existing.author_avatar_url ?? pusherAvatar,
          conversation_id: existing.conversation_id ?? conversationId,
          task_ids: existing.task_ids?.length ? existing.task_ids : links.task_ids,
        });
      } else {
        commitId = await ctx.db.insert("commits", {
          sha,
          message,
          author_name: commit.author?.name || commit.author?.username || "Unknown",
          author_email: commit.author?.email || "",
          timestamp: commit.timestamp ? new Date(commit.timestamp).getTime() : Date.now(),
          files_changed: added + removed + modified,
          insertions: added + modified,
          deletions: removed,
          repository,
          team_id: teamId,
          branch,
          author_login: commit.author?.username,
          author_avatar_url: pusherAvatar,
          conversation_id: conversationId,
          task_ids: links.task_ids.length ? links.task_ids : undefined,
        });
        created++;
      }

      await recordExternalEvent(ctx, {
        source: "github",
        team_id: teamId,
        repository,
        kind: "commit",
        actor_login: commit.author?.username ?? pusher,
        actor_avatar_url: pusherAvatar,
        title: message.split("\n")[0].slice(0, 200),
        url: commitUrl(repository, sha),
        sha,
        branch,
        commit_id: commitId,
        conversation_id: conversationId,
        task_ids: links.task_ids,
        plan_ids: links.plan_ids,
        project_ids: links.project_ids,
        meta: { additions: added + modified, deletions: removed, files_changed: added + removed + modified },
        dedupe_key: `commit:${sha}`,
      });
    }

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: teamId,
      repository,
      kind: "push",
      actor_login: pusher,
      actor_avatar_url: pusherAvatar,
      title: `Pushed ${commits.length} commit${commits.length === 1 ? "" : "s"} to ${branch}`,
      summary: commits[0]?.message?.split("\n")[0]?.slice(0, 200),
      url: payload.compare ?? commitUrl(repository, payload.after ?? commits[commits.length - 1].id),
      sha: payload.after,
      branch,
      conversation_id: firstConversation,
      task_ids: branchLinks.task_ids,
      plan_ids: branchLinks.plan_ids,
      project_ids: branchLinks.project_ids,
      meta: { commit_count: commits.length },
      dedupe_key: `push:${repository}:${branch}:${payload.after ?? commits[commits.length - 1].id}`,
    });

    // A push to a base branch leaves every PR aimed at it a little further
    // behind, and GitHub says nothing about that. Ask again shortly.
    const openPRs: Doc<"pull_requests">[] = await ctx.db
      .query("pull_requests")
      .withIndex("by_repository", (q: any) => q.eq("repository", repository))
      .collect();
    for (const pr of openPRs) {
      if (pr.state !== "open" || pr.base_ref !== branch) continue;
      await ctx.scheduler.runAfter(MERGE_STATE_DELAY_MS, internal.prShepherd.refreshMergeState, {
        pr_id: pr._id,
        attempt: 0,
      });
    }

    return { success: true, commits_created: created };
  },
});

// ── Shared queries and the PR row's first write ──

export const getWebhookEvent = internalQuery({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.event_id);
  },
});

export const getPRByGithubId = internalQuery({
  args: {
    github_pr_id: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();
  },
});

export const getTokenForPR = internalQuery({
  args: {
    pr_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || pr.linked_session_ids.length === 0) {
      return null;
    }

    for (const sessionId of pr.linked_session_ids) {
      const conversation = await ctx.db.get(sessionId);
      if (conversation) {
        const user = await ctx.db.get(conversation.user_id);
        if (user?.github_access_token) {
          return user.github_access_token;
        }
      }
    }

    const teamMembers = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("team_id"), pr.team_id))
      .collect();

    for (const member of teamMembers) {
      if (member.github_access_token) {
        return member.github_access_token;
      }
    }

    return null;
  },
});

// getInstallationForRepository used to live here: a team-scoped lookup with a
// `by_account_login` fallback that ignored team_id and returned the first match
// from ANY team. Both callers below always know their team, so the fallback
// could only ever fire to hand a webhook another tenant's credential.
//
// It is gone. `githubApp.getInstallationForRepoInTeam` answers the same question
// with no fallback — one predicate, one definition of "covers this repo", and a
// null when nothing in the team matches. Both callers already handle null.

export const markEventProcessed = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.event_id, { processed: true });
  },
});

/**
 * Clear stored deliveries nothing will ever handle.
 *
 * Every unprocessed row is scanned by the catch-up sweep on every tick, so a
 * kind with no processor turns into permanent work. New deliveries of those
 * kinds are marked processed at insert; this drains the ones already stored.
 */
export const markUnhandledProcessed = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .take(args.limit ?? 200);

    let marked = 0;
    for (const event of events) {
      if (HANDLED_EVENT_TYPES.has(event.event_type)) continue;
      await ctx.db.patch(event._id, { processed: true });
      marked++;
    }
    return { marked, scanned: events.length };
  },
});

// A branch name alone is weak evidence when it is the name every repository
// uses. Binding a shepherd needs better than that.
const COMMON_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

/**
 * The session that should shepherd this pull request.
 *
 * The branch scan is global, so a session on `main` in an unrelated repository
 * can appear. A session whose git remote names this repository is real
 * evidence and wins; without one, only an unusual branch name is trusted.
 */
function chooseShepherdConversation(
  conversations: Doc<"conversations">[],
  repository: string,
  headRef: string,
): Doc<"conversations"> | undefined {
  const repoName = repository.split("/")[1] ?? repository;
  const byRepo = conversations.filter(
    (c) => c.git_remote_url && (c.git_remote_url.includes(repository) || c.git_remote_url.includes(repoName)),
  );
  const pool = byRepo.length ? byRepo : COMMON_BRANCHES.has(headRef) ? [] : conversations;
  return [...pool].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
}

export const matchPRToConversation = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
    repository: v.string(),
    pr_number: v.number(),
    head_ref: v.string(),
    base_ref: v.optional(v.string()),
    github_pr_id: v.number(),
    title: v.string(),
    body: v.string(),
    author_username: v.string(),
    author_avatar_url: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    requested_reviewers: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_git_branch", (q) => q.eq("git_branch", args.head_ref))
      .take(50);

    // This is a GLOBAL branch-name scan, so conversations[0] could be any user's
    // private session that happens to sit on a branch like `main`. Its ROUTING
    // team_id must not become the PR's team — only a team-visible session may
    // donate one. The repo installation (below) is the authoritative fallback.
    let teamId: Id<"teams"> | undefined;
    for (const conv of conversations) {
      const visibleTeam = teamVisibleConvTeam(conv);
      if (visibleTeam) { teamId = visibleTeam; break; }
    }

    if (!teamId) {
      teamId = (await resolveTeamForRepository(ctx, args.repository)) ?? undefined;
    }

    if (!teamId) {
      await ctx.db.patch(args.event_id, { processed: true });
      return { matched_conversation_id: null, pr_id: null, github_access_token: null, team_id: null };
    }

    let githubAccessToken: string | null = null;
    for (const conversation of conversations) {
      const user = await ctx.db.get(conversation.user_id);
      if (user?.github_access_token) {
        githubAccessToken = user.github_access_token;
        break;
      }
    }

    if (!githubAccessToken) {
      const teamMembers = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("team_id"), teamId))
        .take(20);

      for (const member of teamMembers) {
        if (member.github_access_token) {
          githubAccessToken = member.github_access_token;
          break;
        }
      }
    }

    const links = await resolveTaskLinksFromText(ctx, args.title, args.body, args.head_ref);
    const shepherd = chooseShepherdConversation(conversations, args.repository, args.head_ref);

    const fields = {
      team_id: teamId,
      github_pr_id: args.github_pr_id,
      repository: args.repository,
      number: args.pr_number,
      title: args.title,
      body: args.body,
      state: "open" as const,
      author_github_username: args.author_username,
      author_avatar_url: args.author_avatar_url,
      head_ref: args.head_ref,
      base_ref: args.base_ref,
      head_sha: args.head_sha,
      base_sha: args.base_sha,
      draft: args.draft,
      requested_reviewers: args.requested_reviewers,
      task_ids: links.task_ids.length ? links.task_ids : undefined,
      linked_session_ids: conversations.map((c) => c._id),
      updated_at: args.updated_at,
    };

    // GitHub redelivers, and a reopened pull request arrives as `opened` again.
    const existing = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();

    let prId: Id<"pull_requests">;
    if (existing) {
      prId = existing._id;
      await ctx.db.patch(prId, {
        ...fields,
        shepherd_conversation_id: existing.shepherd_conversation_id ?? shepherd?._id,
        shepherd_enabled: existing.shepherd_enabled ?? !!shepherd,
      });
    } else {
      prId = await ctx.db.insert("pull_requests", {
        ...fields,
        pr_comment_posted: false,
        created_at: args.created_at,
        shepherd_conversation_id: shepherd?._id,
        shepherd_enabled: !!shepherd,
        shepherd_wake_count: 0,
      });
    }

    const result = await patchPullRequest(ctx, prId, {});
    const pr = result!.pr;

    if (pr.shepherd_conversation_id && pr.shepherd_enabled) {
      await ensureShepherdTask(ctx, pr);
      await refreshConversationPrStatus(ctx, pr.shepherd_conversation_id);
    }

    await recordExternalEvent(ctx, {
      source: "github",
      team_id: teamId,
      repository: args.repository,
      kind: "pr_opened",
      actor_login: args.author_username,
      actor_avatar_url: args.author_avatar_url,
      title: `Opened PR #${args.pr_number}: ${args.title}`,
      summary: args.body ? args.body.slice(0, 400) : undefined,
      url: prUrl(args.repository, args.pr_number),
      sha: args.head_sha,
      branch: args.head_ref,
      pr_id: prId,
      pr_number: args.pr_number,
      conversation_id: pr.shepherd_conversation_id,
      task_ids: links.task_ids,
      plan_ids: links.plan_ids,
      project_ids: links.project_ids,
      meta: { pr_state: "open", head_ref: args.head_ref, base_ref: args.base_ref },
      dedupe_key: `pr_opened:${prId}`,
    });

    await fireTrigger(ctx, "pr_opened", pr);
    await ctx.scheduler.runAfter(MERGE_STATE_DELAY_MS, internal.prShepherd.refreshMergeState, {
      pr_id: prId,
      attempt: 0,
    });

    await ctx.db.patch(args.event_id, { processed: true });

    return {
      matched_conversation_id: shepherd?._id ?? conversations[0]?._id ?? null,
      pr_id: prId,
      github_access_token: githubAccessToken,
      team_id: teamId,
    };
  },
});

export const postPRCommentIfNeeded = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    conversation_id: v.id("conversations"),
    repository: v.string(),
    pr_number: v.number(),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || pr.pr_comment_posted) {
      return { posted: false, reason: "Already posted or PR not found" };
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return { posted: false, reason: "Conversation not found" };
    }

    const user = await ctx.db.get(conversation.user_id);
    if (!user?.github_access_token) {
      return { posted: false, reason: "No GitHub access token available" };
    }

    if (user.pr_auto_comment_enabled === false) {
      return { posted: false, reason: "Auto-commenting disabled in user settings" };
    }

    const conversationUrl = `https://codecast.sh/conversation/${args.conversation_id}`;
    const commentBody = `## 🎙️ Codecast Conversation\n\n**${conversation.title || "Untitled Conversation"}**\n\nThis PR was created during a Codecast session.\n\n[View full conversation →](${conversationUrl})`;

    try {
      void ctx.scheduler.runAfter(0, api.githubApi.postPRComment, {
        repository: args.repository,
        pr_number: args.pr_number,
        comment_body: commentBody,
        github_access_token: user.github_access_token,
      });

      await ctx.db.patch(args.pr_id, {
        pr_comment_posted: true,
      });

      return { posted: true };
    } catch (error) {
      console.error("Failed to post PR comment:", error);
      return { posted: false, reason: `Error: ${error}` };
    }
  },
});

/**
 * Catch-up sweep for stored deliveries the immediate processors missed (a
 * scheduler drop, a deploy mid-flight) and for the kinds that only ever ran
 * here. Review comments go through the same ingest function as the immediate
 * path, so both produce identical rows, events and wakes.
 */
export const processCommentWebhooks = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const events = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .take(limit);

    const results = [];

    for (const event of events) {
      try {
        // Nothing consumes this kind, and leaving it unprocessed makes every
        // later sweep re-read it.
        if (!HANDLED_EVENT_TYPES.has(event.event_type)) {
          await ctx.db.patch(event._id, { processed: true });
          results.push({ event_id: event._id, status: "unhandled" });
          continue;
        }

        const payload = JSON.parse(event.payload);
        let processed = false;

        if (event.event_type === "pull_request_review_comment" && event.action === "created") {
          processed = await ingestReviewComment(ctx, payload);
        } else if (event.event_type === "pull_request_review_comment" && event.action === "edited") {
          processed = await handleReviewCommentEdited(ctx, payload);
        } else if (event.event_type === "pull_request_review_comment" && event.action === "deleted") {
          processed = await handleReviewCommentDeleted(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "created") {
          processed = await handleIssueCommentCreated(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "edited") {
          processed = await handleIssueCommentEdited(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "deleted") {
          processed = await handleIssueCommentDeleted(ctx, payload);
        }

        if (processed) {
          await ctx.db.patch(event._id, { processed: true });
          results.push({ event_id: event._id, status: "processed" });
        } else {
          results.push({ event_id: event._id, status: "skipped" });
        }
      } catch (error) {
        results.push({
          event_id: event._id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { processed: results.length, results };
  },
});

async function handleReviewCommentEdited(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.patch(existing._id, {
    content: comment.body,
    updated_at: new Date(comment.updated_at).getTime(),
  });

  return true;
}

async function handleReviewCommentDeleted(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.delete(existing._id);

  return true;
}

async function handleIssueCommentCreated(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;
  const issue = payload.issue;

  if (!issue.pull_request) {
    return false;
  }

  if (comment.body?.includes("codecast_comment_id:")) {
    return false;
  }

  const repository = normalizeRepository(payload.repository.full_name);
  const prNumber = issue.number;

  const pr = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .filter((q: any) => q.eq(q.field("number"), prNumber))
    .first();

  if (!pr) {
    return false;
  }

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (existing) {
    return false;
  }

  await ctx.db.insert("review_comments", {
    pull_request_id: pr._id,
    github_comment_id: comment.id,
    content: comment.body,
    resolved: false,
    created_at: new Date(comment.created_at).getTime(),
    updated_at: new Date(comment.updated_at).getTime(),
    author_github_username: comment.user.login,
    codecast_origin: false,
  });

  return true;
}

async function handleIssueCommentEdited(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.patch(existing._id, {
    content: comment.body,
    updated_at: new Date(comment.updated_at).getTime(),
  });

  return true;
}

async function handleIssueCommentDeleted(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.delete(existing._id);

  return true;
}
