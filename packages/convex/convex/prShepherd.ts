// The PR shepherd.
//
// A pull request that a session opened stays that session's job until it
// merges. The shepherd is how: one standing trigger per pull request, woken
// with a prompt rebuilt from the pull request's current state every time
// something happens to it — a review, a failing check, a base branch that moved
// on, a merge.
//
// The prompt is always rebuilt, never appended to. A wake that arrives while
// the agent is mid-run therefore cannot deliver a stale picture: the retry
// below waits for the run to finish and then builds the prompt from whatever
// is true by then.

import { v } from "convex/values";
import { internalMutation, internalQuery, internalAction, mutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { canAccessConversation, canAccessPullRequest } from "./lib/access";
import { insertTask, refreshArmedTriggerKind } from "./agentTasks";
import { recordExternalEvent } from "./externalEvents";
import { foldChecksState, foldShepherdState, prUrl, shortSha } from "./lib/gitRefs";

const SHEPHERD_MAX_RUNTIME_MS = 30 * 60 * 1000;
const WAKE_RETRY_MS = 20 * 1000;
const MAX_WAKE_RETRIES = 5;
const MERGE_STATE_RETRY_MS = 15 * 1000;
const MAX_MERGE_STATE_ATTEMPTS = 4;
const RETIRE_RETRY_MS = 5 * 60 * 1000;
const MAX_RETIRE_ATTEMPTS = 12;

const GITHUB_API_BASE = "https://api.github.com";

type Ctx = { db: any; scheduler?: any };
type PR = Doc<"pull_requests">;

// ── Folding PR state ──

/**
 * The one writer for a pull request row that keeps its folded fields honest.
 *
 * Every webhook processor patches through here, so `checks_state` always agrees
 * with `checks`, `shepherd_state` always agrees with the whole row, and the
 * session card's `pr_status` is refreshed in the same breath. Returns the row
 * as it now stands, plus what the folded state was before, so a caller can tell
 * a real transition from a repeat.
 */
/**
 * Fire a derived pull request trigger.
 *
 * Standing triggers are armed on names like "pr_check_failed" rather than the
 * raw GitHub event kinds, so a task can wait for the thing that matters instead
 * of decoding webhook payloads. Every derived event is about exactly one pull
 * request, so the repository and number always ride along and a trigger that
 * names a pr_number only fires for that one.
 */
export async function firePrTrigger(
  ctx: { scheduler: { runAfter: (ms: number, fn: any, args: any) => Promise<any> } },
  eventType: string,
  pr: Doc<"pull_requests">,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
    event_type: eventType,
    repository: pr.repository,
    pr_number: pr.number,
    team_id: pr.team_id,
  });
}

export async function patchPullRequest(
  ctx: Ctx,
  prId: Id<"pull_requests">,
  updates: Record<string, any>,
): Promise<{ pr: PR; previousState: string | undefined; stateChanged: boolean } | null> {
  const before = await ctx.db.get(prId);
  if (!before) return null;

  const patch: Record<string, any> = { ...updates };
  const merged: any = { ...before, ...patch };
  if ("checks" in patch) {
    merged.checks_state = foldChecksState(merged.checks);
    patch.checks_state = merged.checks_state;
  }

  const previousState = before.shepherd_state;
  const state = foldShepherdState(merged);
  if (state !== previousState) {
    patch.shepherd_state = state;
    patch.shepherd_state_at = Date.now();
  }
  patch.updated_at = patch.updated_at ?? Date.now();

  await ctx.db.patch(prId, patch);
  const after = (await ctx.db.get(prId)) as PR;

  if (after.shepherd_conversation_id) {
    await refreshConversationPrStatus(ctx, after.shepherd_conversation_id);
  }

  return { pr: after, previousState, stateChanged: state !== previousState };
}

/**
 * The reviewers' verdict, recomputed from the latest review each reviewer left.
 *
 * A "commented" review says nothing about whether the PR may land, and a
 * dismissed one has been withdrawn, so neither counts. One outstanding request
 * for changes outranks any number of approvals.
 */
export async function recomputeReviewDecision(ctx: Ctx, pr: PR): Promise<string> {
  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
    .collect();

  const latest = new Map<string, any>();
  for (const review of reviews) {
    if (review.state !== "approved" && review.state !== "changes_requested") continue;
    const who = review.author_github_username ?? String(review.reviewer_user_id ?? "");
    if (!who) continue;
    const prior = latest.get(who);
    if (!prior || (review.submitted_at ?? 0) >= (prior.submitted_at ?? 0)) latest.set(who, review);
  }

  const verdicts = [...latest.values()].map((r) => r.state);
  if (verdicts.includes("changes_requested")) return "changes_requested";
  if (verdicts.includes("approved")) return "approved";
  if ((pr.requested_reviewers ?? []).length > 0) return "review_required";
  return "none";
}

/**
 * Mirror the pull request a session shepherds onto its conversation row, so the
 * inbox card and the thread panel can show it without a second query. An open
 * PR wins over a merged one; when the session shepherds nothing, the field is
 * cleared rather than left describing a PR that closed last week.
 */
export async function refreshConversationPrStatus(
  ctx: Ctx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) return;

  const prs: PR[] = await ctx.db
    .query("pull_requests")
    .withIndex("by_shepherd_conversation", (q: any) => q.eq("shepherd_conversation_id", conversationId))
    .collect();

  const open = prs.filter((pr) => pr.state === "open").sort((a, b) => b.updated_at - a.updated_at);
  const rest = prs.sort((a, b) => b.updated_at - a.updated_at);
  const chosen = open[0] ?? rest[0];

  if (!chosen) {
    if (conversation.pr_status) await ctx.db.patch(conversationId, { pr_status: undefined });
    return;
  }

  const next = {
    pr_id: chosen._id,
    repository: chosen.repository,
    number: chosen.number,
    title: chosen.title,
    state: chosen.shepherd_state ?? foldShepherdState(chosen),
    at: Date.now(),
  };
  const current = conversation.pr_status;
  const same =
    current &&
    String(current.pr_id) === String(next.pr_id) &&
    current.state === next.state &&
    current.title === next.title;
  if (same) return;

  await ctx.db.patch(conversationId, { pr_status: next });
}

// ── The wake prompt ──

export type ReviewLine = {
  author: string;
  state: string;
  body?: string;
  url?: string;
};

export type CommentLine = {
  author: string;
  file_path?: string;
  line_number?: number;
  content: string;
  url?: string;
};

export type WakePromptInput = {
  pr: {
    number: number;
    title: string;
    repository: string;
    state?: string;
    head_ref?: string;
    base_ref?: string;
    head_sha?: string;
    draft?: boolean;
    behind_by?: number;
    mergeable?: boolean | null;
    mergeable_state?: string;
    review_decision?: string;
    requested_reviewers?: string[];
    checks?: Array<{ name: string; status: string; conclusion?: string; url?: string }>;
    shepherd_state?: string;
  };
  reviews?: ReviewLine[];
  comments?: CommentLine[];
  tasks?: Array<{ short_id: string; title: string }>;
  reason: string;
  detail?: string;
};

/** Plain English for each wake reason, so the agent reads a sentence not a key. */
const REASON_TEXT: Record<string, string> = {
  bound: "you were put in charge of this pull request",
  review_comment_created: "a reviewer left a comment on the code",
  review_submitted: "a reviewer submitted a review",
  review_requested: "a review was requested",
  check_failed: "a check failed",
  checks_green: "the checks went green",
  behind: "the base branch moved ahead of this one",
  conflict: "the branch no longer merges cleanly",
  ready: "the branch merges cleanly again",
  synchronize: "new commits were pushed to the branch",
  opened: "the pull request was opened",
  merged: "the pull request merged",
  closed: "the pull request was closed without merging",
};

function truncate(text: string, max: number): string {
  const clean = (text ?? "").trim().replace(/\s+/g, " ");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * The whole briefing the shepherd agent reads on a wake: where the PR stands,
 * what is outstanding, and what it is expected to do about it.
 *
 * Pure, so the content is testable without a database, and rebuilt on every
 * wake so it can never describe a state the PR has already left.
 */
export function buildWakePrompt(input: WakePromptInput): string {
  const { pr } = input;
  const url = prUrl(pr.repository, pr.number);
  const state = pr.shepherd_state ?? foldShepherdState(pr);
  const lines: string[] = [];

  lines.push(`# Shepherding ${pr.repository} PR #${pr.number}: ${pr.title}`);
  lines.push("");
  lines.push(url);
  const branch = pr.head_ref && pr.base_ref ? `${pr.head_ref} into ${pr.base_ref}` : pr.head_ref ?? "";
  const head = pr.head_sha ? ` at ${shortSha(pr.head_sha)}` : "";
  if (branch) lines.push(`${branch}${head}${pr.draft ? " (draft)" : ""}`);
  lines.push(`State: ${state}`);
  lines.push(`Woken because ${REASON_TEXT[input.reason] ?? input.reason}${input.detail ? `: ${input.detail}` : "."}`);

  const failing = (pr.checks ?? []).filter(
    (c) => c.status === "completed" && c.conclusion && !["success", "neutral", "skipped"].includes(c.conclusion),
  );
  if (failing.length) {
    lines.push("");
    lines.push("## Failing checks");
    for (const check of failing.slice(0, 12)) {
      lines.push(`- ${check.name}: ${check.conclusion}${check.url ? ` — ${check.url}` : ""}`);
    }
  }

  const comments = input.comments ?? [];
  if (comments.length) {
    lines.push("");
    lines.push("## Unresolved review comments");
    for (const comment of comments.slice(0, 25)) {
      const where = comment.file_path
        ? ` on ${comment.file_path}${comment.line_number ? `:${comment.line_number}` : ""}`
        : "";
      lines.push(`- ${comment.author}${where}: ${truncate(comment.content, 400)}${comment.url ? ` — ${comment.url}` : ""}`);
    }
  }

  const reviews = input.reviews ?? [];
  if (reviews.length) {
    lines.push("");
    lines.push("## Reviews");
    for (const review of reviews.slice(0, 15)) {
      const body = review.body ? `: ${truncate(review.body, 300)}` : "";
      lines.push(`- ${review.author} ${review.state}${body}`);
    }
  }

  const decision = pr.review_decision && pr.review_decision !== "none" ? pr.review_decision : null;
  const requested = pr.requested_reviewers ?? [];
  if (decision || requested.length) {
    lines.push("");
    if (decision) lines.push(`Review decision: ${decision}.`);
    if (requested.length) lines.push(`Requested reviewers: ${requested.join(", ")}.`);
  }

  if ((pr.behind_by ?? 0) > 0 || pr.mergeable === false || pr.mergeable_state === "dirty") {
    lines.push("");
    lines.push("## Merge state");
    if ((pr.behind_by ?? 0) > 0) {
      lines.push(`${pr.behind_by} commit${pr.behind_by === 1 ? "" : "s"} behind ${pr.base_ref ?? "the base branch"}.`);
    }
    if (pr.mergeable === false || pr.mergeable_state === "dirty") {
      lines.push("The branch does not merge cleanly.");
    } else if (pr.mergeable_state) {
      lines.push(`GitHub reports mergeable_state ${pr.mergeable_state}.`);
    }
  }

  const tasks = input.tasks ?? [];
  if (tasks.length) {
    lines.push("");
    lines.push("## Linked work");
    for (const task of tasks.slice(0, 10)) lines.push(`- ${task.short_id} ${task.title}`);
  }

  lines.push("");
  lines.push("## Your job");
  if (input.reason === "merged") {
    lines.push("This pull request has merged, so close the work out: mark the linked tasks done,");
    lines.push("say what shipped, and end with `cast state --status done`.");
  } else if (input.reason === "closed") {
    lines.push("This pull request was closed without merging. Say what happened and what remains,");
    lines.push("then end with `cast state --status done` unless something still needs a person.");
  } else {
    lines.push("You own this pull request until it merges. Deal with everything outstanding above,");
    lines.push("in one pass: fix the failing checks, answer the review comments, and push to the same");
    lines.push("branch. When you have addressed a reviewer's point, say so on GitHub in reply to");
    lines.push("their comment (`gh` or `cast pr comment`) so the thread shows the resolution rather");
    lines.push("than going quiet. If the branch is behind, bring it up to date; if it conflicts,");
    lines.push("resolve the conflicts yourself. Do not merge the pull request unless a human asked");
    lines.push("you to. Keep `cast state` current so the card says where the PR actually stands.");
  }

  return lines.join("\n");
}

// ── The standing trigger ──

/**
 * The pull request's standing trigger, created on first need.
 *
 * It is an event trigger with nothing that fires it automatically: `wake` below
 * is the only thing that ever sets its run_at. The event filter exists so the
 * row is addressable and so a person can see, in their trigger list, which pull
 * request it belongs to.
 */
export async function ensureShepherdTask(ctx: Ctx, pr: PR): Promise<Id<"agent_tasks"> | null> {
  if (!pr.shepherd_conversation_id) return null;

  if (pr.shepherd_task_id) {
    const existing = await ctx.db.get(pr.shepherd_task_id);
    if (existing && existing.status !== "completed" && existing.status !== "failed") {
      return pr.shepherd_task_id;
    }
  }

  const conversation = await ctx.db.get(pr.shepherd_conversation_id);
  if (!conversation) return null;

  const { id } = await insertTask(ctx as any, conversation.user_id, {
    title: `Shepherd PR #${pr.number}`,
    prompt: buildWakePrompt({ pr, reason: "bound" }),
    originating_conversation_id: String(pr.shepherd_conversation_id),
    project_path: conversation.project_path,
    schedule_type: "event",
    event_filter: { event_type: "pr_shepherd", repository: pr.repository, pr_number: pr.number },
    mode: "apply",
    max_runtime_ms: SHEPHERD_MAX_RUNTIME_MS,
  });

  await ctx.db.patch(pr._id, { shepherd_task_id: id });
  return id;
}

/** Stand the trigger down. Used when the PR ends and when a person turns it off. */
export async function retireShepherdTask(ctx: Ctx, pr: PR): Promise<void> {
  if (!pr.shepherd_task_id) return;
  const task = await ctx.db.get(pr.shepherd_task_id);
  if (!task || task.status === "completed") return;
  await ctx.db.patch(task._id, { status: "completed", run_at: undefined });
  if (task.originating_conversation_id) {
    await refreshArmedTriggerKind(ctx as any, task.originating_conversation_id);
  }
}

/** What the agent still has to answer for: unresolved comments and real reviews. */
async function gatherWakeContext(ctx: Ctx, pr: PR) {
  const comments = await ctx.db
    .query("review_comments")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
    .collect();

  const reviews = await ctx.db
    .query("reviews")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
    .collect();

  const tasks: Array<{ short_id: string; title: string }> = [];
  for (const taskId of pr.task_ids ?? []) {
    const task = await ctx.db.get(taskId);
    if (task) tasks.push({ short_id: task.short_id, title: task.title });
  }

  return {
    comments: comments
      .filter((c: any) => !c.resolved && !c.resolved_at && !c.codecast_origin)
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .map((c: any) => ({
        author: c.author_github_username ?? "someone",
        file_path: c.file_path,
        line_number: c.line_number,
        content: c.content,
        url: c.html_url,
      })),
    reviews: reviews
      .sort((a: any, b: any) => (a.submitted_at ?? 0) - (b.submitted_at ?? 0))
      .map((r: any) => ({
        author: r.author_github_username ?? "a reviewer",
        state: r.state,
        body: r.body,
        url: r.html_url,
      })),
    tasks,
  };
}

/**
 * Hand the shepherd a fresh briefing and let it run.
 *
 * A trigger that is mid-run cannot be re-prompted without losing the run, so
 * the wake retries a few times instead. Rebuilding the prompt on the retry is
 * the point: what lands is what is true when the agent is free, not what was
 * true when the webhook arrived.
 */
export async function wakeShepherd(
  ctx: Ctx,
  prId: Id<"pull_requests">,
  reason: string,
  detail?: string,
  attempt = 0,
): Promise<{ woken: boolean; reason?: string }> {
  const pr = (await ctx.db.get(prId)) as PR | null;
  if (!pr) return { woken: false, reason: "no_pr" };
  if (!pr.shepherd_enabled || !pr.shepherd_conversation_id) return { woken: false, reason: "disabled" };

  const taskId = await ensureShepherdTask(ctx, pr);
  if (!taskId) return { woken: false, reason: "no_task" };

  const task = await ctx.db.get(taskId);
  if (!task) return { woken: false, reason: "no_task" };

  if (task.status === "running") {
    if (attempt >= MAX_WAKE_RETRIES) return { woken: false, reason: "still_running" };
    await ctx.scheduler?.runAfter(WAKE_RETRY_MS, internal.prShepherd.wake, {
      pr_id: prId,
      reason,
      detail,
      attempt: attempt + 1,
    });
    return { woken: false, reason: "retry_scheduled" };
  }

  const context = await gatherWakeContext(ctx, pr);
  const prompt = buildWakePrompt({ pr, ...context, reason, detail });

  await ctx.db.patch(taskId, {
    prompt,
    status: "scheduled",
    run_at: Date.now(),
  });

  await ctx.db.patch(prId, {
    shepherd_last_wake_at: Date.now(),
    shepherd_last_wake_reason: reason,
    shepherd_wake_count: (pr.shepherd_wake_count ?? 0) + 1,
  });

  await refreshConversationPrStatus(ctx, pr.shepherd_conversation_id);
  return { woken: true };
}

export const wake = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    reason: v.string(),
    detail: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    return await wakeShepherd(ctx, args.pr_id, args.reason, args.detail, args.attempt ?? 0);
  },
});

/**
 * Stand the trigger down after the final run has had its chance.
 *
 * Called on a delay from the merge/close wake so the agent still gets to close
 * the work out; it waits again rather than cutting a run short.
 */
export const retire = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ retired: boolean }> => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr?.shepherd_task_id) return { retired: false };
    const task = await ctx.db.get(pr.shepherd_task_id);
    if (!task || task.status === "completed") return { retired: false };

    const attempt = args.attempt ?? 0;
    if (task.status === "running" && attempt < MAX_RETIRE_ATTEMPTS) {
      await ctx.scheduler.runAfter(RETIRE_RETRY_MS, internal.prShepherd.retire, {
        pr_id: args.pr_id,
        attempt: attempt + 1,
      });
      return { retired: false };
    }

    await retireShepherdTask(ctx, pr);
    return { retired: true };
  },
});

/** Bind a pull request to the session that will shepherd it. */
export async function bindShepherd(
  ctx: Ctx,
  pr: PR,
  conversationId: Id<"conversations"> | undefined,
  enabled: boolean,
): Promise<void> {
  const patch: Record<string, any> = { shepherd_enabled: enabled };
  if (conversationId) patch.shepherd_conversation_id = conversationId;
  await ctx.db.patch(pr._id, patch);

  const updated = (await ctx.db.get(pr._id)) as PR;
  if (enabled && updated.shepherd_conversation_id) {
    await ensureShepherdTask(ctx, updated);
  } else {
    await retireShepherdTask(ctx, updated);
  }
  if (updated.shepherd_conversation_id) {
    await refreshConversationPrStatus(ctx, updated.shepherd_conversation_id);
  }
}

export const bindPRToConversation = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    conversation_id: v.id("conversations"),
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr) return { ok: false };
    await bindShepherd(ctx, pr, args.conversation_id, args.enabled ?? true);
    return { ok: true };
  },
});

export const setShepherd = mutation({
  args: {
    pr_id: v.id("pull_requests"),
    conversation_id: v.optional(v.id("conversations")),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) throw new Error("Pull request not found");

    if (args.conversation_id) {
      const conversation = await ctx.db.get(args.conversation_id);
      if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
        throw new Error("Conversation not found");
      }
    }

    await bindShepherd(ctx, pr, args.conversation_id, args.enabled);
    return { ok: true };
  },
});

export const getPR = internalQuery({
  args: { pr_id: v.id("pull_requests") },
  handler: async (ctx, args) => await ctx.db.get(args.pr_id),
});

// ── Merge state ──
//
// GitHub computes "does this still merge" lazily: the first read after a push
// answers `mergeable: null` and kicks off the computation. So this runs on a
// delay, and re-runs itself a few times while the answer is still null.

export const applyMergeState = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    mergeable: v.optional(v.union(v.boolean(), v.null())),
    mergeable_state: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    requested_reviewers: v.optional(v.array(v.string())),
    behind_by: v.optional(v.number()),
    state: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ retry: boolean }> => {
    const before = await ctx.db.get(args.pr_id);
    if (!before) return { retry: false };

    const patch: Record<string, any> = {
      mergeable: args.mergeable,
      mergeable_state: args.mergeable_state,
      merge_state_checked_at: Date.now(),
    };
    if (args.head_sha) patch.head_sha = args.head_sha;
    if (args.base_sha) patch.base_sha = args.base_sha;
    if (args.draft !== undefined) patch.draft = args.draft;
    if (args.requested_reviewers) patch.requested_reviewers = args.requested_reviewers;
    if (args.behind_by !== undefined) patch.behind_by = args.behind_by;

    const result = await patchPullRequest(ctx, args.pr_id, patch);
    if (!result) return { retry: false };

    // Only a real change is worth an event or a wake: this refresh runs on
    // every push and every merge-state poll, and most of those change nothing.
    if (result.stateChanged) {
      const state = result.pr.shepherd_state;
      const eventKind =
        state === "conflicts" ? "pr_conflict" : state === "behind" ? "pr_behind" : "pr_ready";
      const detail =
        state === "conflicts"
          ? "the branch no longer merges cleanly"
          : state === "behind"
            ? `${result.pr.behind_by ?? 0} commits behind ${result.pr.base_ref ?? "the base branch"}`
            : undefined;

      if (state === "conflicts" || state === "behind" || result.previousState === "conflicts" || result.previousState === "behind") {
        await recordExternalEvent(ctx, {
          source: "github",
          team_id: result.pr.team_id,
          repository: result.pr.repository,
          kind: eventKind,
          title:
            state === "conflicts"
              ? `PR #${result.pr.number} has conflicts`
              : state === "behind"
                ? `PR #${result.pr.number} is behind ${result.pr.base_ref ?? "its base"}`
                : `PR #${result.pr.number} merges cleanly again`,
          url: prUrl(result.pr.repository, result.pr.number),
          pr_id: result.pr._id,
          pr_number: result.pr.number,
          branch: result.pr.head_ref,
          conversation_id: result.pr.shepherd_conversation_id,
          task_ids: result.pr.task_ids,
          meta: {
            behind_by: result.pr.behind_by,
            mergeable_state: result.pr.mergeable_state,
            shepherd_state: state,
          },
          dedupe_key: `merge_state:${result.pr._id}:${state}:${result.pr.head_sha ?? ""}:${result.pr.behind_by ?? 0}`,
        });

        await firePrTrigger(ctx, eventKind, result.pr);

        await wakeShepherd(
          ctx,
          result.pr._id,
          state === "conflicts" ? "conflict" : state === "behind" ? "behind" : "ready",
          detail,
        );
      }
    }

    return { retry: args.mergeable === null || args.mergeable === undefined };
  },
});

export const refreshMergeState = internalAction({
  args: {
    pr_id: v.id("pull_requests"),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const attempt = args.attempt ?? 0;
    const pr = await ctx.runQuery(internal.prShepherd.getPR, { pr_id: args.pr_id });
    if (!pr) return { ok: false, reason: "no_pr" };
    if (pr.state !== "open") return { ok: false, reason: "not_open" };

    const token: string | null = await ctx.runAction(internal.prShepherd.tokenForPR, { pr_id: args.pr_id });
    if (!token) return { ok: false, reason: "no_token" };

    const [owner, repo] = pr.repository.split("/");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const response = await fetch(`${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}`, { headers });
    if (!response.ok) {
      return { ok: false, reason: `github ${response.status}` };
    }
    const data = await response.json();

    let behindBy: number | undefined;
    const baseRef = data.base?.ref;
    const headRef = data.head?.ref;
    if (baseRef && headRef) {
      const compare = await fetch(
        `${GITHUB_API_BASE}/repos/${owner}/${repo}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(headRef)}`,
        { headers },
      );
      if (compare.ok) {
        const compareData = await compare.json();
        behindBy = compareData.behind_by;
      }
    }

    const result = await ctx.runMutation(internal.prShepherd.applyMergeState, {
      pr_id: args.pr_id,
      mergeable: data.mergeable ?? null,
      mergeable_state: data.mergeable_state,
      head_sha: data.head?.sha,
      base_sha: data.base?.sha,
      draft: !!data.draft,
      requested_reviewers: (data.requested_reviewers ?? []).map((r: any) => r.login),
      behind_by: behindBy,
    });

    if (result.retry && attempt < MAX_MERGE_STATE_ATTEMPTS) {
      await ctx.scheduler.runAfter(MERGE_STATE_RETRY_MS, internal.prShepherd.refreshMergeState, {
        pr_id: args.pr_id,
        attempt: attempt + 1,
      });
    }

    return { ok: true };
  },
});

/**
 * A repository token for this pull request. The App installation is the real
 * credential; a linked user's token is the fallback for repositories installed
 * before the App existed.
 */
export const tokenForPR = internalAction({
  args: { pr_id: v.id("pull_requests") },
  handler: async (ctx, args): Promise<string | null> => {
    const pr = await ctx.runQuery(internal.prShepherd.getPR, { pr_id: args.pr_id });
    if (!pr) return null;

    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, {
      repository: pr.repository,
      team_id: pr.team_id,
    });
    if (installation) {
      try {
        const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
          installation_id: installation.installation_id,
        });
        return tokenResult.token;
      } catch (error) {
        console.error("[prShepherd] installation token failed:", error);
      }
    }

    return await ctx.runQuery(internal.githubWebhooks.getTokenForPR, { pr_id: args.pr_id });
  },
});

/** Wake the shepherd one last time on a merge or close, then stand it down. */
export async function closeOutShepherd(ctx: Ctx, pr: PR, reason: "merged" | "closed"): Promise<void> {
  await wakeShepherd(ctx, pr._id, reason);
  await ctx.db.patch(pr._id, { shepherd_enabled: false });
  await ctx.scheduler?.runAfter(SHEPHERD_MAX_RUNTIME_MS + 60 * 1000, internal.prShepherd.retire, {
    pr_id: pr._id,
    attempt: 0,
  });
}
