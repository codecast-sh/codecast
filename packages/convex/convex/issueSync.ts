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

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { issueProviderValidator, issueSyncSourceKindValidator } from "./issueSyncSchema";

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

const notImplemented = (name: string) => {
  throw new Error(`issueSync.${name}: not implemented`);
};

/* ---------------- Inbound (S6) ---------------- */

export const onLinearEvent = internalMutation({
  args: { event_id: v.id("linear_webhook_events") },
  handler: async () => notImplemented("onLinearEvent"),
});

export const onGithubIssue = internalMutation({
  args: { event_id: v.id("github_webhook_events") },
  handler: async () => notImplemented("onGithubIssue"),
});

export const onGithubIssueComment = internalMutation({
  args: { event_id: v.id("github_webhook_events") },
  handler: async () => notImplemented("onGithubIssueComment"),
});

/** The one write path for provider data (S3, S4). */
export const applyRemote = internalMutation({
  args: {
    source_id: v.optional(v.id("issue_sync_sources")),
    issue: normalizedIssueValidator,
    comments: v.optional(v.array(normalizedCommentValidator)),
    event_kind: v.optional(v.string()),   // S8 kind hint from the webhook action
  },
  handler: async () => notImplemented("applyRemote"),
});

/* ---------------- Outbound (S5) ---------------- */

export const pushTask = internalAction({
  args: { task_id: v.id("tasks"), fields: v.array(v.string()) },
  handler: async () => notImplemented("pushTask"),
});

export const pushComment = internalAction({
  args: { comment_id: v.id("task_comments") },
  handler: async () => notImplemented("pushComment"),
});

/** Create the provider issue for a task born on our side (S1.3 push_new_tasks). */
export const pushNewTask = internalAction({
  args: { task_id: v.id("tasks") },
  handler: async () => notImplemented("pushNewTask"),
});

/* ---------------- Sources: import + reconcile (S6) ---------------- */

export const importSource = internalAction({
  args: { source_id: v.id("issue_sync_sources") },
  handler: async () => notImplemented("importSource"),
});

export const reconcileSources = internalAction({
  args: {},
  handler: async () => notImplemented("reconcileSources"),
});

/* ---------------- Sources: web API (S9) ---------------- */

export const listSources = query({
  args: {},
  handler: async () => notImplemented("listSources"),
});

/** Linear teams + projects, or GitHub repos, the connection can import. */
export const listRemoteCandidates = action({
  args: { provider: issueProviderValidator },
  handler: async () => notImplemented("listRemoteCandidates"),
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
  },
  handler: async () => notImplemented("addSource"),
});

export const updateSource = mutation({
  args: {
    id: v.id("issue_sync_sources"),
    status: v.optional(v.union(v.literal("active"), v.literal("paused"))),
    delegate_label: v.optional(v.string()),
    delegate_assignee: v.optional(v.string()),
    auto_spawn: v.optional(v.boolean()),
    push_new_tasks: v.optional(v.boolean()),
  },
  handler: async () => notImplemented("updateSource"),
});

export const removeSource = mutation({
  args: { id: v.id("issue_sync_sources") },
  handler: async () => notImplemented("removeSource"),
});

export const syncNow = action({
  args: { id: v.id("issue_sync_sources") },
  handler: async () => notImplemented("syncNow"),
});

/* ---------------- Internal lookups shared with tasks.ts / http.ts ---------------- */

export const getSourceByExternal = internalQuery({
  args: { provider: issueProviderValidator, external_id: v.string() },
  handler: async () => notImplemented("getSourceByExternal"),
});
