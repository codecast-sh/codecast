// Issue sync: Linear and GitHub issues as tasks.
// Contract: docs/architecture/issue-sync.md (S1..S10). Section ids in comments.
//
// Layout
//   lib/issueMapping.ts   pure field mapping + conflict policy (S2, S3), unit tested
//   linearApi.ts          Linear GraphQL client (S5, S6)
//   githubIssuesApi.ts    GitHub issues REST client (S5, S6)
//   issueSync.ts          this file: inbound handlers, applyRemote, outbound, sources
//
// Loop rule (S4): inbound handlers write through applyRemote and NEVER schedule
// pushTask / pushComment. Only the public task mutations schedule outbound.
//
// Builders come from ./functions, not ./_generated/server: this file writes
// tasks, and the change-feed interceptor lives in the wrapped builders.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { issueProviderValidator, issueSyncSourceKindValidator } from "./issueSyncSchema";
import {
  diffAgainstTask,
  githubStateFor,
  linearPriorityFor,
  linearStateFor,
  normalizeGithubComment,
  normalizeGithubIssue,
  normalizeLinearComment,
  normalizeLinearIssue,
  type NormalizedComment,
  type NormalizedIssue,
} from "./lib/issueMapping";
import * as linearApi from "./linearApi";
import * as githubIssuesApi from "./githubIssuesApi";
import { createDataContext } from "./data";
import { nextShortId } from "./counters";
import { heldKeysFor, requireTeamMembership, resolveWorkspaceKey } from "./lib/access";
import { forbidden, notFound } from "./lib/auth";
import { insertTaskComment, recalcPlanProgress, resolveAssigneeToUserId } from "./tasks";
import { verifyApiToken } from "./apiTokens";
import { teamTaskStatuses } from "@codecast/shared/tasks";

/** A provider issue normalized to one shape before it touches a task (S2). */
export const normalizedIssueValidator = v.object({
  provider: issueProviderValidator,
  id: v.string(),
  identifier: v.string(),
  url: v.string(),
  number: v.optional(v.number()),
  repo: v.optional(v.string()),
  team_key: v.optional(v.string()),
  team_id: v.optional(v.string()),
  project_id: v.optional(v.string()),
  title: v.string(),
  description: v.optional(v.string()),
  status: v.string(),                       // our category
  state_name: v.optional(v.string()),
  priority: v.optional(v.string()),         // our priority word; absent = don't touch
  assignee_email: v.optional(v.string()),
  assignee_login: v.optional(v.string()),
  assignee_label: v.optional(v.string()),
  labels: v.array(v.string()),
  remote_updated_at: v.number(),
  remote_created_at: v.optional(v.number()),
  actor: v.optional(v.string()),
  deleted: v.optional(v.boolean()),
});

export const normalizedCommentValidator = v.object({
  provider: issueProviderValidator,
  id: v.string(),
  issue_id: v.string(),
  body: v.string(),
  author: v.optional(v.string()),
  author_email: v.optional(v.string()),
  author_login: v.optional(v.string()),
  url: v.optional(v.string()),
  created_at: v.number(),
  updated_at: v.optional(v.number()),
  deleted: v.optional(v.boolean()),
});

/** How long an unlinked local comment with identical text is treated as ours (S4.4). */
const COMMENT_LINK_WINDOW_MS = 5 * 60 * 1000;
/** Pages pulled per source per run. 50 issues a page; a reconcile rarely fills one. */
const IMPORT_MAX_PAGES = 10;
/** Reconcile overlap so a webhook that never arrived is still inside the window (S6). */
const RECONCILE_OVERLAP_MS = 5 * 60 * 1000;

type SourceDoc = {
  _id: Id<"issue_sync_sources">;
  provider: "linear" | "github";
  kind: string;
  external_id: string;
  project_id: Id<"projects">;
  user_id: Id<"users">;
  team_id?: Id<"teams">;
  workspace: string;
  status: string;
  delegate_label?: string;
  delegate_assignee?: string;
  auto_spawn: boolean;
  push_new_tasks: boolean;
  last_synced_at?: number;
};

/* ---------------- Shared lookups ---------------- */

async function sourceFor(ctx: any, provider: string, externalId: string) {
  return await ctx.db
    .query("issue_sync_sources")
    .withIndex("by_provider_external", (q: any) =>
      q.eq("provider", provider).eq("external_id", externalId))
    .first();
}

async function taskByExternal(ctx: any, provider: string, id: string) {
  if (!id) return null;
  return await ctx.db
    .query("tasks")
    .withIndex("by_external", (q: any) => q.eq("external.provider", provider).eq("external.id", id))
    .first();
}

/**
 * The provider assignee as one of our users, or null.
 *
 * GitHub gives a login and Linear an email; both funnel into the same resolver
 * the CLI uses, which also covers alternate_emails through the team roster. A
 * miss is not an error — the display lands in external.assignee_label and our
 * assignee is left alone (S2).
 */
async function resolveProviderUser(
  ctx: any,
  issue: NormalizedIssue,
  teamId?: Id<"teams">,
): Promise<Id<"users"> | null> {
  if (issue.assignee_login) {
    const byGh = await ctx.db
      .query("users")
      .withIndex("by_github_username", (q: any) => q.eq("github_username", issue.assignee_login!.toLowerCase()))
      .first();
    if (byGh) return byGh._id;
  }
  if (issue.assignee_email) {
    const byEmail = await ctx.db
      .query("users")
      .withIndex("email", (q: any) => q.eq("email", issue.assignee_email))
      .first();
    if (byEmail) return byEmail._id;
    return await resolveAssigneeToUserId(ctx, issue.assignee_email, teamId);
  }
  return null;
}

/**
 * The `external` object for a task (S1.1).
 *
 * `field_ts` survives from the previous value: it records OUR pushes, and an
 * inbound event must never erase the record of a local write it might be
 * racing. `remote_updated_at` only moves forward for the same reason.
 */
function externalFor(
  issue: NormalizedIssue,
  source: SourceDoc | null,
  now: number,
  prev?: any,
): Record<string, any> {
  return {
    provider: issue.provider,
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    number: issue.number,
    repo: issue.repo,
    team_key: issue.team_key,
    team_id: issue.team_id,
    project_id: issue.project_id,
    source_id: source?._id ?? prev?.source_id,
    remote_updated_at: Math.max(issue.remote_updated_at, prev?.remote_updated_at ?? 0),
    synced_at: now,
    field_ts: prev?.field_ts,
    assignee_label: issue.assignee_label,
    state_name: issue.state_name,
    // A successful inbound proves the connection works, so a stale error goes.
    last_error: undefined,
  };
}

async function history(
  ctx: any,
  taskId: Id<"tasks">,
  action: string,
  field?: string,
  oldValue?: unknown,
  newValue?: unknown,
) {
  await ctx.db.insert("task_history", {
    task_id: taskId,
    actor_type: "system",
    action,
    field,
    old_value: oldValue === undefined ? undefined : String(oldValue),
    new_value: newValue === undefined ? undefined : String(newValue),
    created_at: Date.now(),
  });
}

/* ---------------- Inbound (S6) ---------------- */

/**
 * Record the inbound event on the source and on the connection it came
 * through, so the integrations page can say "last heard from Linear 4 minutes
 * ago" without a probe (S1.5).
 */
async function stampInboundHealth(ctx: any, source: SourceDoc, now: number) {
  await ctx.db.patch(source._id, { last_webhook_at: now, updated_at: now });
  if (!source.team_id) return;
  if (source.provider === "linear") {
    const row = await ctx.db
      .query("app_installations")
      .withIndex("by_provider_team", (q: any) => q.eq("provider", "linear").eq("team_id", source.team_id))
      .first();
    if (row) await ctx.db.patch(row._id, { last_webhook_at: now });
  } else {
    for (const row of await ctx.db
      .query("github_app_installations")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", source.team_id))
      .collect()) {
      await ctx.db.patch(row._id, { last_webhook_at: now });
    }
  }
}

/**
 * What KIND of change a Linear update was (S8). Linear sends `updatedFrom`
 * with only the fields that moved, which is the whole classification.
 */
export function linearEventKind(action: string, payload: any, issue: NormalizedIssue): string {
  if (action === "create") return "issue_opened";
  if (action === "remove") return "issue_closed";
  const changed = payload?.updatedFrom ?? {};
  if ("assigneeId" in changed) return "issue_assigned";
  if ("stateId" in changed) {
    if (issue.status === "done" || issue.status === "dropped") return "issue_closed";
    return "issue_status";
  }
  if ("labelIds" in changed) return "issue_labeled";
  return "issue_edited";
}

export const GITHUB_EVENT_KINDS: Record<string, string> = {
  opened: "issue_opened",
  reopened: "issue_reopened",
  closed: "issue_closed",
  assigned: "issue_assigned",
  unassigned: "issue_assigned",
  labeled: "issue_labeled",
  unlabeled: "issue_labeled",
  edited: "issue_edited",
  deleted: "issue_closed",
};

export const onLinearEvent = internalMutation({
  args: { event_id: v.id("linear_webhook_events") },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.event_id);
    if (!event || event.processed) return { skipped: "processed" as const };

    const done = async (reason: string) => {
      await ctx.db.patch(args.event_id, { processed: true });
      return { skipped: reason };
    };

    let payload: any;
    try {
      payload = JSON.parse(event.payload);
    } catch {
      return await done("unparseable");
    }

    const data = payload?.data ?? {};
    const action: string = payload?.action ?? event.action ?? "update";
    // A Comment event's container is its issue's; an Issue event's is its own.
    const container = event.event_type === "Comment" ? (data.issue ?? {}) : data;
    const source = (await sourceFor(ctx, "linear", container?.project?.id ?? "__none__"))
      ?? (await sourceFor(ctx, "linear", container?.team?.id ?? "__none__"));
    if (!source) return await done("no_source");

    const now = Date.now();
    await stampInboundHealth(ctx, source as SourceDoc, now);

    if (event.event_type === "Comment") {
      const comment = normalizeLinearComment(data, { deleted: action === "remove", now });
      // The comment's parent may not be in the payload. The task already knows
      // the issue, so rebuild the minimum applyRemote needs to touch comments.
      const issue = data.issue
        ? normalizeLinearIssue(data.issue, { now })
        : await issueFromTask(ctx, "linear", comment.issue_id);
      if (!issue) return await done("no_issue");
      await applyRemoteInner(ctx, {
        source_id: source._id,
        issue,
        comments: [comment],
        event_kind: "issue_commented",
        comment_only: true,
      });
      return await done("applied");
    }

    if (event.event_type !== "Issue") return await done("unhandled_type");

    const issue = normalizeLinearIssue(data, {
      deleted: action === "remove",
      actor: payload?.actor?.name,
      now,
    });
    await applyRemoteInner(ctx, {
      source_id: source._id,
      issue,
      event_kind: linearEventKind(action, payload, issue),
    });
    return await done("applied");
  },
});

/**
 * The issue a task already carries, for a comment event that arrived without
 * its parent. Comment-only, so the fields that would drive a diff are the
 * task's own — nothing can move on this path.
 */
async function issueFromTask(ctx: any, provider: string, issueId: string): Promise<NormalizedIssue | null> {
  const task = await taskByExternal(ctx, provider, issueId);
  if (!task?.external) return null;
  const ext = task.external;
  return {
    provider: ext.provider,
    id: ext.id,
    identifier: ext.identifier,
    url: ext.url,
    number: ext.number,
    repo: ext.repo,
    team_key: ext.team_key,
    team_id: ext.team_id,
    project_id: ext.project_id,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    state_name: ext.state_name,
    priority: task.priority,
    labels: task.labels ?? [],
    remote_updated_at: ext.remote_updated_at,
  };
}

/**
 * A GitHub delivery this integration must ignore (S4.3): our own app's writes
 * come back as webhooks, and re-applying them would be the echo the diff rule
 * already stops — but dropping them at the door is cheaper and clearer.
 */
function isOwnBotEvent(payload: any): boolean {
  return payload?.sender?.type === "Bot" && String(payload?.sender?.login ?? "").startsWith("codecast-sh");
}

/**
 * GitHub webhook rows are SHARED with githubWebhooks.ts (a PR comment is an
 * issue_comment too), so these handlers never claim the `processed` flag and
 * never gate on it. They do not need it: applyRemote is idempotent by
 * construction — a replay maps to values equal to ours and diffs to nothing.
 */
async function githubEventPayload(ctx: any, eventId: Id<"github_webhook_events">) {
  const event = await ctx.db.get(eventId);
  if (!event) return null;
  try {
    return { event, payload: JSON.parse(event.payload) as any };
  } catch {
    return null;
  }
}

export const onGithubIssue = internalMutation({
  args: { event_id: v.id("github_webhook_events") },
  handler: async (ctx, args) => {
    const loaded = await githubEventPayload(ctx, args.event_id);
    if (!loaded) return { skipped: "no_event" as const };
    const { event, payload } = loaded;
    if (isOwnBotEvent(payload)) return { skipped: "own_bot" as const };

    const repo: string | undefined = payload?.repository?.full_name;
    if (!repo || !payload?.issue) return { skipped: "no_repo" as const };
    if (githubIssuesApi.isPullRequest(payload.issue)) return { skipped: "pull_request" as const };

    const source = await sourceFor(ctx, "github", repo);
    if (!source) return { skipped: "no_source" as const };

    const action: string = payload?.action ?? event.action ?? "edited";
    const now = Date.now();
    await stampInboundHealth(ctx, source as SourceDoc, now);

    const issue = normalizeGithubIssue(payload.issue, repo, {
      deleted: action === "deleted",
      actor: payload?.sender?.login,
      now,
    });
    await applyRemoteInner(ctx, {
      source_id: source._id,
      issue,
      event_kind: GITHUB_EVENT_KINDS[action] ?? "issue_edited",
      github_action: action,
    });
    return { applied: true as const };
  },
});

export const onGithubIssueComment = internalMutation({
  args: { event_id: v.id("github_webhook_events") },
  handler: async (ctx, args) => {
    const loaded = await githubEventPayload(ctx, args.event_id);
    if (!loaded) return { skipped: "no_event" as const };
    const { event, payload } = loaded;
    if (isOwnBotEvent(payload)) return { skipped: "own_bot" as const };

    const repo: string | undefined = payload?.repository?.full_name;
    // A comment on a pull request is the PR integration's, not ours.
    if (!repo || !payload?.issue || githubIssuesApi.isPullRequest(payload.issue)) {
      return { skipped: "pull_request" as const };
    }

    const source = await sourceFor(ctx, "github", repo);
    if (!source) return { skipped: "no_source" as const };

    const now = Date.now();
    await stampInboundHealth(ctx, source as SourceDoc, now);

    const issue = normalizeGithubIssue(payload.issue, repo, { actor: payload?.sender?.login, now });
    const comment = normalizeGithubComment(payload.comment, issue.id, {
      deleted: (payload?.action ?? event.action) === "deleted",
      now,
    });
    await applyRemoteInner(ctx, {
      source_id: source._id,
      issue,
      comments: [comment],
      event_kind: "issue_commented",
      comment_only: true,
      github_action: payload?.action ?? "created",
    });
    return { applied: true as const };
  },
});

/* ---------------- applyRemote: the one write path (S3, S4) ---------------- */

type ApplyArgs = {
  source_id?: Id<"issue_sync_sources">;
  issue: NormalizedIssue;
  comments?: NormalizedComment[];
  event_kind?: string;
  /** Touch comments only — the issue fields are a stand-in, not an observation. */
  comment_only?: boolean;
  /** The raw GitHub action, so triggers keep firing on their native names (S7). */
  github_action?: string;
};

/** The one write path for provider data (S3, S4). */
export const applyRemote = internalMutation({
  args: {
    source_id: v.optional(v.id("issue_sync_sources")),
    issue: normalizedIssueValidator,
    comments: v.optional(v.array(normalizedCommentValidator)),
    event_kind: v.optional(v.string()),   // S8 kind hint from the webhook action
    comment_only: v.optional(v.boolean()),
    github_action: v.optional(v.string()),
  },
  handler: async (ctx, args) => await applyRemoteInner(ctx, args as ApplyArgs),
});

async function applyRemoteInner(ctx: any, args: ApplyArgs) {
  const { issue } = args;
  const now = Date.now();
  const source: SourceDoc | null = args.source_id ? await ctx.db.get(args.source_id) : null;
  let task = await taskByExternal(ctx, issue.provider, issue.id);

  if (!task) {
    // Nothing to attach a comment or a deletion to, and no home to create in.
    if (args.comment_only || issue.deleted || !source) return { skipped: "no_task" };
    task = await createTaskFromIssue(ctx, source, issue, now);
  } else if (!args.comment_only) {
    await updateTaskFromIssue(ctx, source, task, issue, now);
    task = await ctx.db.get(task._id);
  }
  if (!task) return { skipped: "no_task" };

  for (const comment of args.comments ?? []) {
    await upsertComment(ctx, task._id, comment);
  }

  await maybeDelegate(ctx, source, task, issue);
  await recordFeedEvent(ctx, source, task, issue, args.event_kind, now);
  await fireTriggers(ctx, source, issue, args.event_kind, args.github_action, !!args.comments?.length);

  return { task_id: task._id };
}

async function createTaskFromIssue(ctx: any, source: SourceDoc, issue: NormalizedIssue, now: number) {
  const db = await createDataContext(ctx, {
    userId: source.user_id,
    ...(source.team_id
      ? { workspace: "team" as const, team_id: source.team_id }
      : { workspace: "personal" as const }),
  });
  const assigneeId = await resolveProviderUser(ctx, issue, source.team_id);
  const short_id = await nextShortId(ctx.db, "ct");
  const closed = issue.status === "done" || issue.status === "dropped";

  const id = await db.insert("tasks", {
    project_id: source.project_id,
    short_id,
    title: issue.title || issue.identifier,
    description: issue.description || undefined,
    task_type: "task",
    status: issue.status,
    priority: issue.priority || "medium",
    assignee: assigneeId ? String(assigneeId) : undefined,
    labels: issue.labels.length > 0 ? issue.labels : undefined,
    source: "import",
    triage_status: "active",
    attempt_count: 0,
    retry_count: 0,
    max_retries: 3,
    closed_at: closed ? now : undefined,
    external: externalFor(issue, source, now),
  } as any);

  await history(ctx, id, "synced_from_provider", undefined, undefined, issue.identifier);
  return await ctx.db.get(id);
}

async function updateTaskFromIssue(
  ctx: any,
  source: SourceDoc | null,
  task: any,
  issue: NormalizedIssue,
  now: number,
) {
  const teamId = task.team_id ?? source?.team_id;
  const assigneeId = await resolveProviderUser(ctx, issue, teamId);

  // A deletion is not a field edit: the row stays (it carries our comments,
  // sessions and history) and only its status moves (S6).
  const diff = issue.deleted
    ? (task.status === "dropped" ? {} : { status: "dropped" })
    : diffAgainstTask(task, issue, { assignee: assigneeId ? String(assigneeId) : undefined });

  const patch: Record<string, any> = {
    ...diff,
    external: externalFor(issue, source, now, task.external),
    updated_at: now,
  };
  if (diff.status === "done" || diff.status === "dropped") patch.closed_at = now;

  for (const field of ["status", "title", "assignee", "priority"] as const) {
    if (diff[field] === undefined) continue;
    await history(ctx, task._id, "updated", field, task[field] ?? "", diff[field]);
  }

  await ctx.db.patch(task._id, patch);

  if (diff.status && task.plan_id) {
    await recalcPlanProgress(ctx, task.plan_id, task._id, diff.status);
  }
}

/**
 * Land one provider comment on the task (S4.4).
 *
 * Three cases in order: we already have it by provider id (update the text and
 * stop); we wrote the identical text moments ago and the webhook beat our own
 * id patch (link that row instead of duplicating it); otherwise it is new.
 */
async function upsertComment(ctx: any, taskId: Id<"tasks">, comment: NormalizedComment) {
  if (!comment.id) return;
  const existing = await ctx.db
    .query("task_comments")
    .withIndex("by_external", (q: any) =>
      q.eq("external.provider", comment.provider).eq("external.id", comment.id))
    .first();

  if (existing) {
    if (comment.deleted) return;
    if (existing.text !== comment.body) await ctx.db.patch(existing._id, { text: comment.body });
    return;
  }
  if (comment.deleted) return;

  const recent = await ctx.db
    .query("task_comments")
    .withIndex("by_task_created", (q: any) =>
      q.eq("task_id", taskId).gte("created_at", Date.now() - COMMENT_LINK_WINDOW_MS))
    .collect();
  const twin = recent.find((c: any) => !c.external && c.text === comment.body);
  const external = {
    provider: comment.provider,
    id: comment.id,
    url: comment.url,
    author: comment.author,
  };
  if (twin) {
    await ctx.db.patch(twin._id, { external });
    return;
  }

  const id = await insertTaskComment(ctx, taskId, {
    author: comment.author || comment.author_login || comment.provider,
    text: comment.body,
    comment_type: "note",
  });
  await ctx.db.patch(id, { external });
}

/* ---------------- Delegation, feed, triggers (S7, S8) ---------------- */

/**
 * The source's delegation convention (S7.3): a label or an assignee on the
 * provider side that means "an agent takes this". Guarded by the task having
 * no session yet, so the signal spawns once and re-firing events are inert.
 */
async function maybeDelegate(ctx: any, source: SourceDoc | null, task: any, issue: NormalizedIssue) {
  if (!source?.auto_spawn) return;
  if ((task.conversation_ids ?? []).length > 0) return;

  const label = (source.delegate_label || "agent").toLowerCase();
  const byLabel = issue.labels.some((l) => l.toLowerCase() === label);
  const target = source.delegate_assignee?.toLowerCase();
  const byAssignee = !!target
    && [issue.assignee_login, issue.assignee_email, issue.assignee_label]
      .some((v) => typeof v === "string" && v.toLowerCase() === target);
  if (!byLabel && !byAssignee) return;

  await ctx.scheduler.runAfter(0, internal.tasks.spawnSessionForTaskInternal, {
    task_id: task._id,
    user_id: source.user_id,
    initial_message: `Picked up from ${issue.identifier}: ${issue.url}`,
  });
}

/** S8: one feed row per inbound event, deduped so retries do not stack. */
async function recordFeedEvent(
  ctx: any,
  source: SourceDoc | null,
  task: any,
  issue: NormalizedIssue,
  kind: string | undefined,
  now: number,
) {
  const teamId = task.team_id ?? source?.team_id;
  if (!kind || !teamId) return;
  await ctx.scheduler.runAfter(0, internal.externalEvents.record, {
    team_id: teamId,
    source: issue.provider,
    repository: issue.repo,
    kind,
    actor_login: issue.actor,
    title: issue.title || issue.identifier,
    url: issue.url,
    issue: {
      provider: issue.provider,
      key: issue.identifier,
      url: issue.url,
      title: issue.title,
    },
    task_ids: [task._id],
    project_ids: task.project_id ? [task.project_id] : undefined,
    dedupe_key: `${issue.provider}:${issue.id}:${kind}:${issue.remote_updated_at || now}`,
  });
}

/**
 * Hand the event to armed triggers (S7). Two shapes, both scheduled: the
 * provider-native pair (`issues` + `opened`) that GitHub users already arm on,
 * and the CLI shorthand (`issue_opened`) that reads the same for Linear. The
 * repository is the repo name, or the Linear team key when there is none.
 */
async function fireTriggers(
  ctx: any,
  source: SourceDoc | null,
  issue: NormalizedIssue,
  kind: string | undefined,
  githubAction: string | undefined,
  hasComment: boolean,
) {
  const repository = issue.repo ?? issue.team_key ?? source?.external_id;
  const eventType = hasComment ? "issue_comment" : "issues";
  const action = githubAction ?? linearActionFor(kind);
  await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
    event_type: eventType,
    action,
    repository,
  });
  const shorthand = hasComment ? "issue_commented" : kind;
  if (shorthand) {
    await ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
      event_type: shorthand,
      repository,
    });
  }
}

function linearActionFor(kind: string | undefined): string | undefined {
  switch (kind) {
    case "issue_opened": return "opened";
    case "issue_assigned": return "assigned";
    case "issue_labeled": return "labeled";
    case "issue_closed": return "closed";
    case "issue_reopened": return "reopened";
    case "issue_commented": return "created";
    default: return "edited";
  }
}

/* ---------------- Outbound (S5) ---------------- */

/** Everything an outbound push needs, read once so the action holds no db. */
export const taskPushContext = internalQuery({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task?.external) return null;
    const source = task.external.source_id ? await ctx.db.get(task.external.source_id) : null;
    const teamId = task.team_id ?? source?.team_id;

    // The team's own name for this status, which beats position when picking
    // the Linear workflow state (S2).
    let statusName: string | undefined;
    if (task.status_id && teamId) {
      const team = await ctx.db.get(teamId);
      statusName = teamTaskStatuses(team?.task_statuses).find((s: any) => s.id === task.status_id)?.name;
    }

    let assigneeEmail: string | undefined;
    let assigneeLogin: string | undefined;
    if (task.assignee && !task.assignee.startsWith("agent:")) {
      const id = ctx.db.normalizeId("users", task.assignee);
      const user = id ? await ctx.db.get(id) : null;
      assigneeEmail = user?.email;
      assigneeLogin = user?.github_username;
    }

    return {
      external: task.external,
      title: task.title,
      description: task.description ?? "",
      status: task.status,
      status_name: statusName,
      priority: task.priority,
      labels: task.labels ?? [],
      assignee_email: assigneeEmail,
      assignee_login: assigneeLogin,
      user_id: task.user_id,
      team_id: teamId,
    };
  },
});

/** The token for a provider write, or null when the connection is gone. */
async function tokenFor(
  ctx: any,
  provider: string,
  teamId: Id<"teams"> | undefined,
  userId: Id<"users">,
  repo?: string,
): Promise<string | null> {
  if (provider === "linear") {
    if (!teamId) return null;
    const res = await ctx.runQuery(internal.oauthConnectors.getAccessTokenForTeam, {
      provider: "linear",
      team_id: teamId,
    });
    return res?.token ?? null;
  }
  if (!repo) return null;
  const installation = teamId
    ? await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, { repository: repo, team_id: teamId })
    : await ctx.runQuery(internal.githubApp.getInstallationForRepo, { repository: repo, user_id: userId });
  if (!installation) return null;
  const token = await ctx.runAction(internal.githubApp.getInstallationToken, {
    installation_id: installation.installation_id,
  });
  return token?.token ?? null;
}

export const pushTask = internalAction({
  args: { task_id: v.id("tasks"), fields: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ pushed?: string[]; skipped?: string; error?: string }> => {
    const info: any = await ctx.runQuery(internal.issueSync.taskPushContext, { task_id: args.task_id });
    if (!info) return { skipped: "no_external" };
    const ext = info.external;
    const want = new Set(args.fields);

    try {
      const token = await tokenFor(ctx, ext.provider, info.team_id, info.user_id, ext.repo);
      if (!token) return { skipped: "no_connection" };

      if (ext.provider === "linear") {
        const input: linearApi.LinearIssueInput = {};
        if (want.has("title")) input.title = info.title;
        if (want.has("description")) input.description = info.description;
        if (want.has("priority")) input.priority = linearPriorityFor(info.priority);
        if (want.has("status") && ext.team_id) {
          const states = await linearApi.fetchWorkflowStates(token, ext.team_id);
          const state = linearStateFor(info.status, states, info.status_name);
          if (state) input.stateId = state.id;
        }
        if (want.has("labels") && ext.team_id) {
          input.labelIds = await resolveLinearLabelIds(token, ext.team_id, info.labels);
        }
        if (want.has("assignee") && info.assignee_email) {
          const user = await linearApi.findUserByEmail(token, info.assignee_email);
          if (user) input.assigneeId = user.id;
        }
        if (Object.keys(input).length === 0) return { skipped: "nothing_to_push" };
        await linearApi.updateIssue(token, ext.id, input);
      } else {
        const patch: githubIssuesApi.GithubIssuePatch = {};
        if (want.has("title")) patch.title = info.title;
        if (want.has("description")) patch.body = info.description;
        if (want.has("status")) Object.assign(patch, githubStateFor(info.status));
        if (want.has("labels")) patch.labels = info.labels;
        if (want.has("assignee") && info.assignee_login) patch.assignees = [info.assignee_login];
        if (Object.keys(patch).length === 0) return { skipped: "nothing_to_push" };
        if (!ext.repo || ext.number == null) return { skipped: "no_repo" };
        await githubIssuesApi.updateIssue(token, ext.repo, ext.number, patch);
      }

      await ctx.runMutation(internal.issueSync.stampPushed, { task_id: args.task_id, fields: args.fields });
      return { pushed: args.fields };
    } catch (error) {
      // Never throw out of an outbound push: the write already landed on our
      // side, and the 15 minute reconcile is the retry (S5).
      const message = error instanceof Error ? error.message : String(error);
      console.error(`issueSync.pushTask ${args.task_id}: ${message}`);
      await ctx.runMutation(internal.issueSync.stampPushed, {
        task_id: args.task_id,
        fields: [],
        error: message.slice(0, 500),
      });
      return { error: message };
    }
  },
});

/** Label names -> Linear label ids, creating the ones the team does not have. */
async function resolveLinearLabelIds(token: string, teamId: string, names: string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const existing = await linearApi.fetchLabels(token, teamId);
  const byName = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
  const ids: string[] = [];
  for (const name of names) {
    const hit = byName.get(name.toLowerCase());
    if (hit) {
      ids.push(hit);
      continue;
    }
    const created = await linearApi.createLabel(token, teamId, name);
    byName.set(name.toLowerCase(), created.id);
    ids.push(created.id);
  }
  return ids;
}

/**
 * Record a completed push (S3): `field_ts[field]` is what makes a webhook
 * already in flight lose to the write it crossed.
 */
export const stampPushed = internalMutation({
  args: { task_id: v.id("tasks"), fields: v.array(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task?.external) return;
    const now = Date.now();
    const field_ts = { ...(task.external.field_ts ?? {}) };
    for (const field of args.fields) field_ts[field] = now;
    await ctx.db.patch(args.task_id, {
      external: { ...task.external, field_ts, synced_at: now, last_error: args.error },
    });
  },
});

export const commentPushContext = internalQuery({
  args: { comment_id: v.id("task_comments") },
  handler: async (ctx, args) => {
    const comment = await ctx.db.get(args.comment_id);
    if (!comment || comment.external) return null;
    const task = await ctx.db.get(comment.task_id);
    if (!task?.external) return null;
    const source = task.external.source_id ? await ctx.db.get(task.external.source_id) : null;
    return {
      text: comment.text,
      author: comment.author,
      external: task.external,
      user_id: task.user_id,
      team_id: task.team_id ?? source?.team_id,
    };
  },
});

export const stampComment = internalMutation({
  args: {
    comment_id: v.id("task_comments"),
    provider: issueProviderValidator,
    id: v.string(),
    url: v.optional(v.string()),
    author: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.comment_id, {
      external: { provider: args.provider, id: args.id, url: args.url, author: args.author },
    });
  },
});

export const pushComment = internalAction({
  args: { comment_id: v.id("task_comments") },
  handler: async (ctx, args): Promise<{ pushed?: boolean; skipped?: string; error?: string }> => {
    const info: any = await ctx.runQuery(internal.issueSync.commentPushContext, { comment_id: args.comment_id });
    if (!info) return { skipped: "no_external" };
    const ext = info.external;
    try {
      const token = await tokenFor(ctx, ext.provider, info.team_id, info.user_id, ext.repo);
      if (!token) return { skipped: "no_connection" };
      const posted = ext.provider === "linear"
        ? await linearApi.createComment(token, ext.id, info.text)
        : ext.repo && ext.number != null
          ? await githubIssuesApi.createIssueComment(token, ext.repo, ext.number, info.text)
          : null;
      if (!posted) return { skipped: "no_repo" };
      // The id write is what stops the echo: the webhook this post triggers
      // arrives with an id we now recognise and is skipped (S4.4).
      await ctx.runMutation(internal.issueSync.stampComment, {
        comment_id: args.comment_id,
        provider: ext.provider,
        id: posted.id,
        url: posted.url,
        author: info.author,
      });
      return { pushed: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`issueSync.pushComment ${args.comment_id}: ${message}`);
      return { error: message };
    }
  },
});

export const newTaskPushContext = internalQuery({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task || task.external || !task.project_id) return null;
    const source = await ctx.db
      .query("issue_sync_sources")
      .withIndex("by_project", (q: any) => q.eq("project_id", task.project_id))
      .first();
    if (!source || source.status !== "active" || !source.push_new_tasks) return null;
    let assigneeEmail: string | undefined;
    let assigneeLogin: string | undefined;
    if (task.assignee && !task.assignee.startsWith("agent:")) {
      const id = ctx.db.normalizeId("users", task.assignee);
      const user = id ? await ctx.db.get(id) : null;
      assigneeEmail = user?.email;
      assigneeLogin = user?.github_username;
    }
    return {
      source,
      title: task.title,
      description: task.description ?? "",
      status: task.status,
      priority: task.priority,
      labels: task.labels ?? [],
      assignee_email: assigneeEmail,
      assignee_login: assigneeLogin,
      user_id: task.user_id,
      team_id: task.team_id ?? source.team_id,
    };
  },
});

export const setTaskExternal = internalMutation({
  args: { task_id: v.id("tasks"), issue: normalizedIssueValidator, source_id: v.id("issue_sync_sources") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    if (!task || task.external) return;
    const source = await ctx.db.get(args.source_id);
    const now = Date.now();
    await ctx.db.patch(args.task_id, {
      external: externalFor(args.issue as NormalizedIssue, source as SourceDoc | null, now),
      updated_at: now,
    });
    await history(ctx, args.task_id, "synced_to_provider", undefined, undefined, args.issue.identifier);
  },
});

/** Create the provider issue for a task born on our side (S1.3 push_new_tasks). */
export const pushNewTask = internalAction({
  args: { task_id: v.id("tasks") },
  handler: async (ctx, args): Promise<{ created?: string; skipped?: string; error?: string }> => {
    const info: any = await ctx.runQuery(internal.issueSync.newTaskPushContext, { task_id: args.task_id });
    if (!info) return { skipped: "not_pushable" };
    const source = info.source;
    try {
      const repo = source.provider === "github" ? source.external_id : undefined;
      const token = await tokenFor(ctx, source.provider, info.team_id, info.user_id, repo);
      if (!token) return { skipped: "no_connection" };

      let issue: NormalizedIssue;
      if (source.provider === "linear") {
        const teamId = source.kind === "linear_team" ? source.external_id : source.external_key;
        if (!teamId) return { skipped: "no_linear_team" };
        const input: linearApi.LinearIssueInput = {
          teamId,
          title: info.title,
          description: info.description || undefined,
          priority: linearPriorityFor(info.priority),
        };
        if (source.kind === "linear_project") input.projectId = source.external_id;
        const states = await linearApi.fetchWorkflowStates(token, teamId);
        const state = linearStateFor(info.status, states);
        if (state) input.stateId = state.id;
        if (info.labels.length > 0) input.labelIds = await resolveLinearLabelIds(token, teamId, info.labels);
        if (info.assignee_email) {
          const user = await linearApi.findUserByEmail(token, info.assignee_email);
          if (user) input.assigneeId = user.id;
        }
        issue = normalizeLinearIssue(await linearApi.createIssue(token, input));
      } else {
        const created = await githubIssuesApi.createIssue(token, source.external_id, {
          title: info.title,
          body: info.description || undefined,
          labels: info.labels.length > 0 ? info.labels : undefined,
          assignees: info.assignee_login ? [info.assignee_login] : undefined,
        });
        issue = normalizeGithubIssue(created, source.external_id);
      }

      await ctx.runMutation(internal.issueSync.setTaskExternal, {
        task_id: args.task_id,
        issue,
        source_id: source._id,
      });
      return { created: issue.identifier };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`issueSync.pushNewTask ${args.task_id}: ${message}`);
      return { error: message };
    }
  },
});

/* ---------------- Sources: import + reconcile (S6) ---------------- */

export const getSource = internalQuery({
  args: { source_id: v.id("issue_sync_sources") },
  handler: async (ctx, args) => await ctx.db.get(args.source_id),
});

export const listActiveSources = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db.query("issue_sync_sources").withIndex("by_status", (q: any) => q.eq("status", "active")).collect(),
});

export const markSourceSynced = internalMutation({
  args: {
    source_id: v.id("issue_sync_sources"),
    error: v.optional(v.string()),
    auth_failed: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const patch: Record<string, any> = { updated_at: now, last_error: args.error };
    if (!args.error) patch.last_synced_at = now;
    // Only an auth failure parks the source: a transient 500 must not stop the
    // next reconcile from trying again.
    if (args.auth_failed) patch.status = "error";
    await ctx.db.patch(args.source_id, patch);
  },
});

function isAuthFailure(message: string): boolean {
  return /\b(401|403)\b|no_connection|unauthorized|authentication/i.test(message);
}

/**
 * Pull a source and apply every issue through applyRemote (S6).
 *
 * `since` unset is the full import; set is the reconcile window. Both take the
 * same path, so a reconcile is exactly as safe as a webhook — the diff rule
 * (S3) decides what actually changes in either case.
 */
async function pullSource(ctx: any, source: any, since?: number): Promise<number> {
  let applied = 0;
  if (source.provider === "linear") {
    const token = await tokenFor(ctx, "linear", source.team_id, source.user_id);
    if (!token) throw new Error("no_connection");
    let after: string | undefined;
    for (let page = 0; page < IMPORT_MAX_PAGES; page++) {
      const result = await linearApi.fetchIssuesPage(token, {
        projectId: source.kind === "linear_project" ? source.external_id : undefined,
        teamId: source.kind === "linear_team" ? source.external_id : undefined,
        updatedAfter: since,
        after,
        withComments: true,
      });
      for (const node of result.nodes) {
        const issue = normalizeLinearIssue(node);
        const comments = (node?.comments?.nodes ?? []).map((c: any) =>
          normalizeLinearComment(c, { issue_id: issue.id }));
        await ctx.runMutation(internal.issueSync.applyRemote, {
          source_id: source._id,
          issue,
          comments,
        });
        applied++;
      }
      if (!result.hasNextPage || !result.endCursor) break;
      after = result.endCursor;
    }
    return applied;
  }

  const repo: string = source.external_id;
  const token = await tokenFor(ctx, "github", source.team_id, source.user_id, repo);
  if (!token) throw new Error("no_connection");
  for (let page = 1; page <= IMPORT_MAX_PAGES; page++) {
    const rows = await githubIssuesApi.listIssues(token, repo, { since, page });
    for (const row of rows) {
      const issue = normalizeGithubIssue(row, repo);
      // The comment count is free in the list payload, so an issue nobody has
      // commented on costs no extra request.
      const comments = (row?.comments ?? 0) > 0
        ? (await githubIssuesApi.listIssueComments(token, repo, row.number))
          .map((c: any) => normalizeGithubComment(c, issue.id))
        : [];
      await ctx.runMutation(internal.issueSync.applyRemote, {
        source_id: source._id,
        issue,
        comments,
      });
      applied++;
    }
    if (rows.length < 100) break;
  }
  return applied;
}

export const importSource = internalAction({
  args: { source_id: v.id("issue_sync_sources") },
  handler: async (ctx, args): Promise<{ applied?: number; error?: string }> => {
    const source: any = await ctx.runQuery(internal.issueSync.getSource, { source_id: args.source_id });
    if (!source) return { error: "no_source" };
    try {
      const applied = await pullSource(ctx, source);
      await ctx.runMutation(internal.issueSync.markSourceSynced, { source_id: args.source_id });
      return { applied };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`issueSync.importSource ${args.source_id}: ${message}`);
      await ctx.runMutation(internal.issueSync.markSourceSynced, {
        source_id: args.source_id,
        error: message.slice(0, 500),
        auth_failed: isAuthFailure(message),
      });
      return { error: message };
    }
  },
});

export const reconcileSources = internalAction({
  args: {},
  handler: async (ctx): Promise<{ sources: number }> => {
    const sources: any[] = await ctx.runQuery(internal.issueSync.listActiveSources, {});
    for (const source of sources) {
      try {
        const since = source.last_synced_at ? source.last_synced_at - RECONCILE_OVERLAP_MS : undefined;
        await pullSource(ctx, source, since);
        await ctx.runMutation(internal.issueSync.markSourceSynced, { source_id: source._id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`issueSync.reconcileSources ${source._id}: ${message}`);
        await ctx.runMutation(internal.issueSync.markSourceSynced, {
          source_id: source._id,
          error: message.slice(0, 500),
          auth_failed: isAuthFailure(message),
        });
      }
    }
    return { sources: sources.length };
  },
});

/* ---------------- Sources: shared handlers behind web + CLI (S9, S10) ---------------- */

/** Sources in any workspace the viewer holds a key for. One equality per row. */
async function listSourcesFor(ctx: any, userId: Id<"users">) {
  const keys = await heldKeysFor(ctx, userId);
  const rows: any[] = [];
  for (const key of keys) {
    rows.push(...await ctx.db
      .query("issue_sync_sources")
      .withIndex("by_workspace", (q: any) => q.eq("workspace", key))
      .collect());
  }
  const out = [];
  for (const row of rows) {
    const project = await ctx.db.get(row.project_id);
    out.push({ ...row, project_short_id: project?.short_id, project_title: project?.title });
  }
  return out.sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

async function requireSource(ctx: any, userId: Id<"users">, id: Id<"issue_sync_sources">) {
  const source = await ctx.db.get(id);
  if (!source) notFound("Source not found");
  if (String(source.user_id) === String(userId)) return source;
  const keys = await heldKeysFor(ctx, userId);
  if (!keys.has(source.workspace)) forbidden("Forbidden: source is in another workspace");
  return source;
}

async function addSourceFor(
  ctx: any,
  userId: Id<"users">,
  args: {
    provider: "linear" | "github";
    kind: string;
    external_id: string;
    external_key?: string;
    name: string;
    url?: string;
    project_id?: Id<"projects">;
    team_id?: Id<"teams">;
  },
) {
  const existing = await sourceFor(ctx, args.provider, args.external_id);
  if (existing) return { id: existing._id, project_id: existing.project_id, existing: true };

  const now = Date.now();
  let project = args.project_id ? await ctx.db.get(args.project_id) : null;
  if (args.project_id && !project) notFound("Project not found");

  let teamId = args.team_id ?? (project?.team_id as Id<"teams"> | undefined);
  if (teamId) await requireTeamMembership(ctx, userId, teamId);

  const db = await createDataContext(ctx, {
    userId,
    ...(teamId ? { workspace: "team" as const, team_id: teamId } : { workspace: "personal" as const }),
  });

  if (!project) {
    // No project named: the imported container gets one of its own, so the
    // tasks land somewhere a person can find them (S1.3).
    const projectId = await db.insert("projects", {
      short_id: `pj-${now.toString(36)}`,
      title: args.name,
      description: `Imported from ${args.provider}`,
      status: "active",
    } as any);
    project = await ctx.db.get(projectId);
  } else {
    const key = await resolveWorkspaceKey(ctx, project);
    if (key !== db.workspaceKey) forbidden("Forbidden: project is in another workspace");
  }

  const id = await ctx.db.insert("issue_sync_sources", {
    provider: args.provider,
    kind: args.kind,
    external_id: args.external_id,
    external_key: args.external_key,
    name: args.name,
    url: args.url,
    project_id: project!._id,
    user_id: userId,
    team_id: teamId,
    workspace: db.workspaceKey,
    status: "active",
    delegate_label: "agent",
    auto_spawn: false,
    push_new_tasks: false,
    created_at: now,
    updated_at: now,
  } as any);

  await ctx.scheduler.runAfter(0, internal.issueSync.importSource, { source_id: id });
  return { id, project_id: project!._id, existing: false };
}

const updateSourceArgs = {
  status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
  delegate_label: v.optional(v.string()),
  delegate_assignee: v.optional(v.string()),
  auto_spawn: v.optional(v.boolean()),
  push_new_tasks: v.optional(v.boolean()),
};

async function updateSourceFor(ctx: any, userId: Id<"users">, id: Id<"issue_sync_sources">, args: any) {
  await requireSource(ctx, userId, id);
  const patch: Record<string, any> = { updated_at: Date.now() };
  for (const key of ["status", "delegate_label", "delegate_assignee", "auto_spawn", "push_new_tasks"]) {
    if (args[key] !== undefined) patch[key] = args[key];
  }
  // Resuming a paused or errored source clears the error that parked it.
  if (args.status === "active") patch.last_error = undefined;
  await ctx.db.patch(id, patch);
  return { success: true };
}

/**
 * Drop the source. Imported tasks stay: they carry our comments, sessions and
 * history. They keep `external` (so the identifier and link still render) and
 * lose only `source_id`, which is what stops the reconcile from touching them.
 */
async function removeSourceFor(ctx: any, userId: Id<"users">, id: Id<"issue_sync_sources">) {
  const source = await requireSource(ctx, userId, id);
  for (const task of await ctx.db
    .query("tasks")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", source.project_id))
    .collect()) {
    if (task.external?.source_id && String(task.external.source_id) === String(id)) {
      await ctx.db.patch(task._id, { external: { ...task.external, source_id: undefined } });
    }
  }
  await ctx.db.delete(id);
  return { success: true };
}

/** Linear teams and projects, or the GitHub repos the team's installations cover. */
async function remoteCandidatesFor(
  ctx: any,
  provider: string,
  teamId: Id<"teams"> | undefined,
  userId: Id<"users">,
): Promise<Array<{ kind: string; external_id: string; external_key?: string; name: string; url?: string }>> {
  if (provider === "linear") {
    const token = await tokenFor(ctx, "linear", teamId, userId);
    if (!token) return [];
    const [teams, projects] = await Promise.all([linearApi.fetchTeams(token), linearApi.fetchProjects(token)]);
    return [
      ...teams.map((t) => ({ kind: "linear_team", external_id: t.id, external_key: t.key, name: `${t.key} · ${t.name}` })),
      ...projects.map((p) => ({
        kind: "linear_project",
        external_id: p.id,
        // The project's team key is what a push needs to create an issue.
        external_key: p.teams?.nodes?.[0]?.id,
        name: p.name,
        url: p.url,
      })),
    ];
  }

  const installations: any[] = teamId
    ? await ctx.runQuery(internal.issueSync.githubInstallationsForTeam, { team_id: teamId })
    : [];
  const out: Array<{ kind: string; external_id: string; name: string; url?: string }> = [];
  const seen = new Set<string>();
  for (const installation of installations) {
    let repos: Array<{ full_name: string; html_url?: string }> = installation.repositories ?? [];
    if (installation.repository_selection === "all") {
      const token = await ctx.runAction(internal.githubApp.getInstallationToken, {
        installation_id: installation.installation_id,
      });
      repos = await githubIssuesApi.listInstallationRepos(token.token);
    }
    for (const repo of repos) {
      if (seen.has(repo.full_name)) continue;
      seen.add(repo.full_name);
      out.push({
        kind: "github_repo",
        external_id: repo.full_name,
        name: repo.full_name,
        url: repo.html_url ?? `https://github.com/${repo.full_name}`,
      });
    }
  }
  return out;
}

export const githubInstallationsForTeam = internalQuery({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) =>
    await ctx.db
      .query("github_app_installations")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", args.team_id))
      .collect(),
});

/** The workspace an action should read a connection from, when none was named. */
export const resolveActor = internalQuery({
  args: { user_id: v.id("users"), team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args) => {
    if (args.team_id) {
      await requireTeamMembership(ctx, args.user_id, args.team_id);
      return { user_id: args.user_id, team_id: args.team_id };
    }
    const user = await ctx.db.get(args.user_id);
    return { user_id: args.user_id, team_id: (user?.active_team_id ?? user?.team_id) as Id<"teams"> | undefined };
  },
});

/** CLI actions carry a token, not an identity; this is where it becomes one. */
export const userForToken = internalQuery({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    return auth ? { user_id: auth.userId } : null;
  },
});

/* ---------------- Sources: web API (S9) ---------------- */

export const listSources = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    return await listSourcesFor(ctx, userId);
  },
});

/** Linear teams + projects, or GitHub repos, the connection can import. */
export const listRemoteCandidates = action({
  args: { provider: issueProviderValidator, team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<Array<Record<string, any>>> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const actor: any = await ctx.runQuery(internal.issueSync.resolveActor, {
      user_id: userId,
      team_id: args.team_id,
    });
    return await remoteCandidatesFor(ctx, args.provider, actor.team_id, userId);
  },
});

export const addSource = mutation({
  args: {
    provider: issueProviderValidator,
    kind: issueSyncSourceKindValidator,
    external_id: v.string(),
    external_key: v.optional(v.string()),
    name: v.string(),
    url: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),   // absent = create a project named after the source
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await addSourceFor(ctx, userId, args);
  },
});

export const updateSource = mutation({
  args: { id: v.id("issue_sync_sources"), ...updateSourceArgs },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await updateSourceFor(ctx, userId, args.id, args);
  },
});

export const removeSource = mutation({
  args: { id: v.id("issue_sync_sources") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await removeSourceFor(ctx, userId, args.id);
  },
});

export const syncNow = action({
  args: { id: v.id("issue_sync_sources") },
  handler: async (ctx, args): Promise<{ applied?: number; error?: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    await ctx.runQuery(internal.issueSync.assertSourceAccess, { user_id: userId, id: args.id });
    return await ctx.runAction(internal.issueSync.importSource, { source_id: args.id });
  },
});

export const assertSourceAccess = internalQuery({
  args: { user_id: v.id("users"), id: v.id("issue_sync_sources") },
  handler: async (ctx, args) => {
    await requireSource(ctx, args.user_id, args.id);
    return { ok: true };
  },
});

/* ---------------- Sources: CLI API (S10) ---------------- */

export const cliListSources = query({
  args: { api_token: v.string() },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await listSourcesFor(ctx, auth.userId);
  },
});

export const cliAddSource = mutation({
  args: {
    api_token: v.string(),
    provider: issueProviderValidator,
    kind: issueSyncSourceKindValidator,
    external_id: v.string(),
    external_key: v.optional(v.string()),
    name: v.string(),
    url: v.optional(v.string()),
    project_id: v.optional(v.id("projects")),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await addSourceFor(ctx, auth.userId, args);
  },
});

export const cliUpdateSource = mutation({
  args: { api_token: v.string(), id: v.id("issue_sync_sources"), ...updateSourceArgs },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await updateSourceFor(ctx, auth.userId, args.id, args);
  },
});

export const cliRemoveSource = mutation({
  args: { api_token: v.string(), id: v.id("issue_sync_sources") },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    return await removeSourceFor(ctx, auth.userId, args.id);
  },
});

export const cliSyncNow = action({
  args: { api_token: v.string(), id: v.id("issue_sync_sources") },
  handler: async (ctx, args): Promise<{ applied?: number; error?: string }> => {
    const actor: any = await ctx.runQuery(internal.issueSync.userForToken, { api_token: args.api_token });
    if (!actor) throw new Error("Unauthorized");
    await ctx.runQuery(internal.issueSync.assertSourceAccess, { user_id: actor.user_id, id: args.id });
    return await ctx.runAction(internal.issueSync.importSource, { source_id: args.id });
  },
});

export const cliListRemoteCandidates = action({
  args: { api_token: v.string(), provider: issueProviderValidator, team_id: v.optional(v.id("teams")) },
  handler: async (ctx, args): Promise<Array<Record<string, any>>> => {
    const actor: any = await ctx.runQuery(internal.issueSync.userForToken, { api_token: args.api_token });
    if (!actor) throw new Error("Unauthorized");
    const resolved: any = await ctx.runQuery(internal.issueSync.resolveActor, {
      user_id: actor.user_id,
      team_id: args.team_id,
    });
    return await remoteCandidatesFor(ctx, args.provider, resolved.team_id, actor.user_id);
  },
});

/* ---------------- Internal lookups shared with tasks.ts / http.ts ---------------- */

export const getSourceByExternal = internalQuery({
  args: { provider: issueProviderValidator, external_id: v.string() },
  handler: async (ctx, args) => await sourceFor(ctx, args.provider, args.external_id),
});
