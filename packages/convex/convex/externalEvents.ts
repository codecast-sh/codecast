// External activity as first class codecast events.
//
// One row per thing that happened outside codecast and matters inside it: a
// commit, a push, a pull request change, a review, a check result, a code
// comment, an issue moving. Every row names the objects it belongs to — the
// session, the task, the plan, the project, the pull request — so the same
// event renders in a transcript, a team feed and a task timeline without any of
// those surfaces knowing how GitHub or Linear reports things.
//
// Writes go through `record` only, which dedupes on `dedupe_key`. A webhook
// that GitHub redelivers, or a merge-state refresh that runs twice, therefore
// costs one row, not two.
//
// Reads follow the same rule pull requests already use: a member of the event's
// team may read it, and so may anyone with access to the conversation it links.

import { v } from "convex/values";
import { internalMutation, query } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { normalizeRepository } from "./lib/gitRefs";
import { markEventDirty } from "./lib/changesDirty";
import { externalEventDataValidator } from "./ingestSchema";
import {
  canAccessConversation,
  canAccessPlan,
  canAccessProject,
  canAccessPullRequest,
  requireAccessibleTask,
  requireTeamMembership,
  workspaceGrantsAccess,
} from "./lib/access";

const DEFAULT_LIMIT = 200;
const SCAN_LIMIT = 500;

const metaValidator = v.object({
  status: v.optional(v.string()),
  conclusion: v.optional(v.string()),
  check_name: v.optional(v.string()),
  review_state: v.optional(v.string()),
  file_path: v.optional(v.string()),
  line_number: v.optional(v.number()),
  additions: v.optional(v.number()),
  deletions: v.optional(v.number()),
  files_changed: v.optional(v.number()),
  commit_count: v.optional(v.number()),
  behind_by: v.optional(v.number()),
  mergeable_state: v.optional(v.string()),
  base_ref: v.optional(v.string()),
  head_ref: v.optional(v.string()),
  pr_state: v.optional(v.string()),
  shepherd_state: v.optional(v.string()),
  surface: v.optional(v.string()),
  version: v.optional(v.string()),
  tag: v.optional(v.string()),
});

export const recordArgs = {
  // Absent only for an ingestion row from a personal workspace source.
  team_id: v.optional(v.id("teams")),
  // github | linear | codecast
  source: v.string(),
  repository: v.optional(v.string()),
  kind: v.string(),
  actor_login: v.optional(v.string()),
  actor_avatar_url: v.optional(v.string()),
  actor_user_id: v.optional(v.id("users")),
  title: v.string(),
  summary: v.optional(v.string()),
  url: v.optional(v.string()),
  sha: v.optional(v.string()),
  branch: v.optional(v.string()),
  pr_id: v.optional(v.id("pull_requests")),
  pr_number: v.optional(v.number()),
  commit_id: v.optional(v.id("commits")),
  comment_id: v.optional(v.id("review_comments")),
  conversation_id: v.optional(v.id("conversations")),
  task_ids: v.optional(v.array(v.id("tasks"))),
  plan_ids: v.optional(v.array(v.id("plans"))),
  project_ids: v.optional(v.array(v.id("projects"))),
  issue: v.optional(v.object({
    provider: v.string(),
    key: v.string(),
    url: v.optional(v.string()),
    title: v.optional(v.string()),
  })),
  meta: v.optional(metaValidator),
  // Ingestion rows (external-data.md X3): the access key, the source and group
  // the transition belongs to, and its small render payload.
  workspace: v.optional(v.string()),
  source_id: v.optional(v.id("event_sources")),
  group_id: v.optional(v.id("event_groups")),
  data: v.optional(externalEventDataValidator),
  dedupe_key: v.string(),
  created_at: v.optional(v.number()),
};

type RecordArgs = {
  team_id?: Id<"teams">;
  source: string;
  repository?: string;
  kind: string;
  title: string;
  dedupe_key: string;
  actor_login?: string;
  actor_avatar_url?: string;
  actor_user_id?: Id<"users">;
  summary?: string;
  url?: string;
  sha?: string;
  branch?: string;
  pr_id?: Id<"pull_requests">;
  pr_number?: number;
  commit_id?: Id<"commits">;
  comment_id?: Id<"review_comments">;
  conversation_id?: Id<"conversations">;
  task_ids?: Id<"tasks">[];
  plan_ids?: Id<"plans">[];
  project_ids?: Id<"projects">[];
  issue?: { provider: string; key: string; url?: string; title?: string };
  meta?: Record<string, any>;
  workspace?: string;
  source_id?: Id<"event_sources">;
  group_id?: Id<"event_groups">;
  data?: Doc<"external_events">["data"];
  created_at?: number;
};

/**
 * Write one event, or return the id of the one already written.
 *
 * Callable straight from any mutation, which is why the logic lives in a plain
 * function rather than only inside the internalMutation below. Links are best
 * effort by design: an event about a real push must land even when the task id
 * in its commit message no longer resolves.
 */
export async function recordExternalEvent(ctx: { db: any }, args: RecordArgs): Promise<Id<"external_events">> {
  const existing = await ctx.db
    .query("external_events")
    .withIndex("by_dedupe_key", (q: any) => q.eq("dedupe_key", args.dedupe_key))
    .first();
  if (existing) return existing._id;

  // A row paints only what it stores. An actor known by id alone renders as a
  // blank face, and a pull request known by id alone gets no link, so both are
  // filled here once rather than by every caller.
  const user = args.actor_user_id && !args.actor_login ? await ctx.db.get(args.actor_user_id) : null;
  const pr = args.pr_id && args.pr_number === undefined ? await ctx.db.get(args.pr_id) : null;

  const taskIds = args.task_ids ?? [];
  const id = await ctx.db.insert("external_events", {
    team_id: args.team_id,
    source: args.source,
    repository: normalizeRepository(args.repository),
    kind: args.kind,
    actor_login: args.actor_login ?? user?.github_username ?? user?.name,
    actor_avatar_url: args.actor_avatar_url ?? user?.github_avatar_url ?? user?.image,
    actor_user_id: args.actor_user_id,
    title: args.title,
    summary: args.summary,
    url: args.url,
    sha: args.sha,
    branch: args.branch,
    pr_id: args.pr_id,
    pr_number: args.pr_number ?? pr?.number,
    commit_id: args.commit_id,
    comment_id: args.comment_id,
    issue: args.issue,
    conversation_id: args.conversation_id,
    task_id: taskIds[0],
    task_ids: taskIds.length ? taskIds : undefined,
    plan_ids: args.plan_ids?.length ? args.plan_ids : undefined,
    project_ids: args.project_ids?.length ? args.project_ids : undefined,
    meta: args.meta,
    workspace: args.workspace,
    source_id: args.source_id,
    group_id: args.group_id,
    data: args.data,
    dedupe_key: args.dedupe_key,
    created_at: args.created_at ?? Date.now(),
  });
  await markEventDirty(ctx, { ...args, created_at: args.created_at ?? Date.now() });
  return id;
}

export const record = internalMutation({
  args: recordArgs,
  handler: async (ctx, args): Promise<Id<"external_events">> => {
    return await recordExternalEvent(ctx, args as RecordArgs);
  },
});

// ── Reads ──

/**
 * The event's workspace, or access to the conversation it names. An ingestion
 * row carries its stored key (external-data.md X3), which may be personal; a
 * git or issue row is keyed by its team.
 */
async function canReadEvent(
  ctx: { db: any },
  userId: Id<"users">,
  event: Doc<"external_events">,
  keyCache: Map<string, boolean>,
): Promise<boolean> {
  const key = event.workspace ?? (event.team_id ? `team:${event.team_id}` : undefined);
  if (key && !keyCache.has(key)) {
    keyCache.set(key, await workspaceGrantsAccess(ctx, userId, key));
  }
  if (key && keyCache.get(key)) return true;
  if (!event.conversation_id) return false;
  const conversation = await ctx.db.get(event.conversation_id);
  return conversation ? await canAccessConversation(ctx, userId, conversation) : false;
}

async function filterReadable(
  ctx: { db: any },
  userId: Id<"users">,
  events: Doc<"external_events">[],
  limit: number,
): Promise<Doc<"external_events">[]> {
  const keyCache = new Map<string, boolean>();
  const out: Doc<"external_events">[] = [];
  for (const event of events) {
    if (out.length >= limit) break;
    if (await canReadEvent(ctx, userId, event, keyCache)) out.push(event);
  }
  return out;
}

export const listForTeam = query({
  args: {
    team_id: v.optional(v.id("teams")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    const teamId = args.team_id ?? user?.active_team_id ?? user?.team_id;
    if (!teamId) return [];
    await requireTeamMembership(ctx, userId, teamId);

    return await ctx.db
      .query("external_events")
      // Git and issue activity only: a product's ingestion rows (source_id
      // set) have their own timeline and never push these out of the feed.
      .withIndex("by_team_source_created", (q) => q.eq("team_id", teamId).eq("source_id", undefined))
      .order("desc")
      .take(args.limit ?? DEFAULT_LIMIT);
  },
});

export const listForConversation = query({
  args: {
    conversation_id: v.id("conversations"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];

    return await ctx.db
      .query("external_events")
      .withIndex("by_conversation_created", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(args.limit ?? DEFAULT_LIMIT);
  },
});

export const listForPR = query({
  args: {
    pr_id: v.id("pull_requests"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) return [];

    return await ctx.db
      .query("external_events")
      .withIndex("by_pr_created", (q) => q.eq("pr_id", args.pr_id))
      .order("desc")
      .take(args.limit ?? DEFAULT_LIMIT);
  },
});

export const listForTask = query({
  args: {
    task_id: v.id("tasks"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireAccessibleTask(ctx, userId, args.task_id);

    return await ctx.db
      .query("external_events")
      .withIndex("by_task_created", (q) => q.eq("task_id", args.task_id))
      .order("desc")
      .take(args.limit ?? DEFAULT_LIMIT);
  },
});

// A plan or a project owns events only through its tasks, so there is no index
// to walk. Scanning the team's recent events and filtering is honest at today's
// volumes; when a busy team outgrows it, the fix is a plan_id column, not a
// wider scan.
async function listForContainer(
  ctx: any,
  userId: Id<"users">,
  teamId: Id<"teams"> | undefined,
  match: (event: Doc<"external_events">) => boolean,
  limit: number,
): Promise<Doc<"external_events">[]> {
  if (!teamId) return [];
  const recent = await ctx.db
    .query("external_events")
    .withIndex("by_team_source_created", (q: any) => q.eq("team_id", teamId).eq("source_id", undefined))
    .order("desc")
    .take(SCAN_LIMIT);
  return await filterReadable(ctx, userId, recent.filter(match), limit);
}

export const listForPlan = query({
  args: {
    plan_id: v.id("plans"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const plan = await ctx.db.get(args.plan_id);
    if (!plan || !(await canAccessPlan(ctx, userId, plan))) return [];
    const user = await ctx.db.get(userId);
    const teamId = plan.team_id ?? user?.active_team_id ?? user?.team_id;

    return await listForContainer(
      ctx,
      userId,
      teamId,
      (event) => !!event.plan_ids?.some((id) => String(id) === String(args.plan_id)),
      args.limit ?? DEFAULT_LIMIT,
    );
  },
});

export const listForProject = query({
  args: {
    project_id: v.id("projects"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return [];
    const user = await ctx.db.get(userId);
    const teamId = project.team_id ?? user?.active_team_id ?? user?.team_id;

    return await listForContainer(
      ctx,
      userId,
      teamId,
      (event) => !!event.project_ids?.some((id) => String(id) === String(args.project_id)),
      args.limit ?? DEFAULT_LIMIT,
    );
  },
});

export const listForRepository = query({
  args: {
    repository: v.string(),
    branch: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const limit = args.limit ?? DEFAULT_LIMIT;
    const recent = await ctx.db
      .query("external_events")
      .withIndex("by_repository_created", (q) => q.eq("repository", normalizeRepository(args.repository)))
      .order("desc")
      .take(SCAN_LIMIT);
    const matching = args.branch ? recent.filter((e) => e.branch === args.branch) : recent;
    return await filterReadable(ctx, userId, matching, limit);
  },
});
