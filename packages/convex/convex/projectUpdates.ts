import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessProject } from "./projects";
import { canAccessTask, canAccessPlan, canAccessDoc } from "./lib/access";
import { nextShortId } from "./counters";

// Project updates: posts on a project's Updates tab (human status posts and
// agent digests) plus their comment threads, and the project timeline — one
// merged, time-ordered view of everything that happened in a project.
//
// Access model: every read and write here resolves the parent project and runs
// projects.canAccessProject (owner or team member). Child rows carry no
// workspace stamp, so they can never disagree with the project's scope.
//
// Sync model: both tables are untracked (same trade as task_comments). Every
// write bumps the parent project's updated_at so the change feed notices, and
// the web reads these tables through reactive queries, which Convex keeps live
// without any change-log plumbing.

const MAX_BODY = 20_000;
const MAX_COMMENT = 4_000;
const MAX_TITLE = 200;

async function requireProject(ctx: any, userId: Id<"users">, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project || !(await canAccessProject(ctx, userId, project))) {
    throw new Error("Project not found");
  }
  return project;
}

async function requireUpdate(ctx: any, userId: Id<"users">, updateId: Id<"project_updates">) {
  const update = await ctx.db.get(updateId);
  if (!update) throw new Error("Update not found");
  const project = await ctx.db.get(update.project_id);
  if (!project || !(await canAccessProject(ctx, userId, project))) {
    throw new Error("Update not found");
  }
  return { update, project };
}

async function insertUpdate(
  ctx: any,
  project: any,
  fields: {
    user_id: Id<"users">;
    author: string;
    author_user_id?: Id<"users">;
    author_kind: "user" | "agent";
    kind: "update" | "digest";
    title?: string;
    body: string;
    conversation_id?: Id<"conversations">;
  },
) {
  const now = Date.now();
  const short_id = await nextShortId(ctx.db, "pu");
  const id = await ctx.db.insert("project_updates", {
    project_id: project._id,
    short_id,
    ...fields,
    title: fields.title?.slice(0, MAX_TITLE),
    body: fields.body.slice(0, MAX_BODY),
    created_at: now,
    updated_at: now,
  });
  // task_comments pattern: the child table is untracked, so stamp the parent —
  // the change feed re-fetches the project row and cached counts stay fresh.
  await ctx.db.patch(project._id, { updated_at: now });
  return { id, short_id };
}

async function insertComment(
  ctx: any,
  update: any,
  fields: {
    author: string;
    author_user_id?: Id<"users">;
    author_kind: "user" | "agent";
    text: string;
    conversation_id?: Id<"conversations">;
  },
) {
  const now = Date.now();
  const id = await ctx.db.insert("project_update_comments", {
    update_id: update._id,
    project_id: update.project_id,
    ...fields,
    text: fields.text.slice(0, MAX_COMMENT),
    created_at: now,
  });
  await ctx.db.patch(update._id, { updated_at: now });
  await ctx.db.patch(update.project_id, { updated_at: now });
  return id;
}

// Newest posts a reader will actually scroll; keeps the query result bounded
// on a project with years of digests behind it.
const MAX_UPDATES_READ = 200;

async function updatesWithComments(ctx: any, projectId: Id<"projects">) {
  const updates = await ctx.db
    .query("project_updates")
    .withIndex("by_project_created", (q: any) => q.eq("project_id", projectId))
    .order("desc")
    .take(MAX_UPDATES_READ);
  return Promise.all(
    updates.map(async (u: any) => ({
      ...u,
      comments: await ctx.db
        .query("project_update_comments")
        .withIndex("by_update_created", (q: any) => q.eq("update_id", u._id))
        .collect(),
    })),
  );
}

// ── Timeline ──────────────────────────────────────────────────────────────
//
// One merged feed: update posts and their comments, task lifecycle (created,
// status transitions from task_history, comments), plans (created + their
// entries[]), docs (created). Everything the project page needs to answer
// "what happened here, when, and who did it".

export type TimelineEvent = {
  ts: number;
  type:
    | "project_created"
    | "update_posted"
    | "update_comment"
    | "task_created"
    | "task_status"
    | "task_comment"
    | "plan_created"
    | "plan_entry"
    | "doc_created";
  actor?: string;
  actor_kind?: "user" | "agent" | "system";
  update?: {
    id: string;
    short_id?: string;
    title?: string;
    kind: "update" | "digest";
    body: string;
  };
  text?: string;
  task?: { short_id?: string; title: string; status: string; priority?: string };
  old_value?: string;
  new_value?: string;
  plan?: { short_id?: string; title: string; status: string };
  entry_type?: string;
  doc?: { id: string; title: string; doc_type?: string };
};

const TIMELINE_SNIPPET = 600;
// Fan-out cap: history/comments are read per task, most recently touched
// first. Beyond this, tasks still contribute created/closed events (read off
// the row itself) but not their per-row history.
const TIMELINE_TASK_FANOUT = 300;
// Per-source read caps. Convex bounds one query at ~16k documents / 8MiB;
// these keep the merged feed inside that budget on any project size, biased
// toward recency (every capped read is order("desc") off a created_at index).
const TIMELINE_MAX_TASKS = 2000;
const TIMELINE_MAX_UPDATES = 300;
const TIMELINE_MAX_UPDATE_COMMENTS = 500;
const TIMELINE_PER_TASK_ROWS = 50;
const TIMELINE_MAX_PLANS = 200;
const TIMELINE_MAX_DOCS = 200;

function snippet(text: string): string {
  return text.length > TIMELINE_SNIPPET ? `${text.slice(0, TIMELINE_SNIPPET)}…` : text;
}

async function userName(ctx: any, cache: Map<string, string>, userId?: string): Promise<string | undefined> {
  if (!userId) return undefined;
  const key = String(userId);
  if (cache.has(key)) return cache.get(key);
  const user = await ctx.db.get(userId as Id<"users">);
  const name = user?.name || user?.email || "unknown";
  cache.set(key, name);
  return name;
}

export async function buildProjectTimeline(
  ctx: any,
  userId: Id<"users">,
  project: any,
  opts: { limit?: number; since?: number } = {},
): Promise<TimelineEvent[]> {
  const limit = Math.min(Math.max(opts.limit ?? 250, 1), 1000);
  const since = opts.since ?? 0;
  const names = new Map<string, string>();
  const events: TimelineEvent[] = [];
  const push = (e: TimelineEvent) => {
    if (e.ts >= since) events.push(e);
  };

  if (project.created_at) {
    push({ ts: project.created_at, type: "project_created" });
  }

  // Updates + their comments. `since` rides into the index range so an
  // incremental read (the weekly digest's --since 7d) touches only new rows.
  const updates = await ctx.db
    .query("project_updates")
    .withIndex("by_project_created", (q: any) =>
      q.eq("project_id", project._id).gte("created_at", since),
    )
    .order("desc")
    .take(TIMELINE_MAX_UPDATES);
  for (const u of updates) {
    push({
      ts: u.created_at,
      type: "update_posted",
      actor: u.author,
      actor_kind: u.author_kind,
      update: {
        id: String(u._id),
        short_id: u.short_id,
        title: u.title,
        kind: u.kind,
        body: snippet(u.body),
      },
    });
  }
  const updateComments = await ctx.db
    .query("project_update_comments")
    .withIndex("by_project_created", (q: any) =>
      q.eq("project_id", project._id).gte("created_at", since),
    )
    .order("desc")
    .take(TIMELINE_MAX_UPDATE_COMMENTS);
  const updateById = new Map<string, any>(updates.map((u: any) => [String(u._id), u]));
  for (const c of updateComments) {
    const u = updateById.get(String(c.update_id));
    push({
      ts: c.created_at,
      type: "update_comment",
      actor: c.author,
      actor_kind: c.author_kind,
      text: snippet(c.text),
      update: u
        ? { id: String(u._id), short_id: u.short_id, title: u.title, kind: u.kind, body: "" }
        : undefined,
    });
  }

  // Tasks: creation and close off the row for EVERY task; transitions and
  // comments from the per-task tables only for the most recently touched ones.
  const rawTasks = await ctx.db
    .query("tasks")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", project._id))
    .take(TIMELINE_MAX_TASKS);
  const tasks: any[] = [];
  for (const t of rawTasks) {
    if (await canAccessTask(ctx, userId, t)) tasks.push(t);
  }
  const taskRef = (t: any) => ({
    short_id: t.short_id,
    title: t.title,
    status: t.status,
    priority: t.priority,
  });
  for (const t of tasks) {
    push({
      ts: t.created_at,
      type: "task_created",
      actor: await userName(ctx, names, t.user_id),
      actor_kind: t.source === "agent" ? "agent" : "user",
      task: taskRef(t),
    });
  }
  const fanout = [...tasks]
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
    .slice(0, TIMELINE_TASK_FANOUT);
  const sawTerminal = new Set<string>();
  for (const t of fanout) {
    const history = await ctx.db
      .query("task_history")
      .withIndex("by_task_id", (q: any) => q.eq("task_id", t._id))
      .take(TIMELINE_PER_TASK_ROWS);
    for (const h of history) {
      if (h.action !== "updated" || h.field !== "status") continue;
      if (h.new_value === "done" || h.new_value === "dropped") sawTerminal.add(String(t._id));
      push({
        ts: h.created_at,
        type: "task_status",
        actor: await userName(ctx, names, h.user_id),
        actor_kind: h.actor_type,
        task: taskRef(t),
        old_value: h.old_value,
        new_value: h.new_value,
      });
    }
    const comments = await ctx.db
      .query("task_comments")
      .withIndex("by_task_created", (q: any) => q.eq("task_id", t._id))
      .order("desc")
      .take(TIMELINE_PER_TASK_ROWS);
    for (const c of comments) {
      push({
        ts: c.created_at,
        type: "task_comment",
        actor: c.author,
        actor_kind: c.author_user_id ? "user" : "agent",
        text: snippet(c.text),
        task: taskRef(t),
      });
    }
  }
  // Closes for finished work whose history we did not read (beyond the fanout
  // cap, or rows that predate task_history) — off the row itself, so finished
  // work always shows when and as what it finished.
  for (const t of tasks) {
    if (t.status !== "done" && t.status !== "dropped") continue;
    if (!t.closed_at || sawTerminal.has(String(t._id))) continue;
    push({
      ts: t.closed_at,
      type: "task_status",
      actor_kind: "system",
      task: taskRef(t),
      new_value: t.status,
    });
  }

  // Plans: creation plus their inline entries[] log.
  const rawPlans = await ctx.db
    .query("plans")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", project._id))
    .take(TIMELINE_MAX_PLANS);
  for (const p of rawPlans) {
    if (!(await canAccessPlan(ctx, userId, p))) continue;
    const planRef = { short_id: p.short_id, title: p.title, status: p.status };
    push({
      ts: p.created_at,
      type: "plan_created",
      actor: await userName(ctx, names, p.user_id),
      plan: planRef,
    });
    for (const e of p.entries ?? []) {
      push({
        ts: e.timestamp,
        type: "plan_entry",
        actor: e.author,
        actor_kind: e.session_id ? "agent" : "user",
        entry_type: e.type,
        text: snippet(e.content),
        plan: planRef,
      });
    }
  }

  // Docs: creation only — doc bodies churn too much to narrate.
  const rawDocs = await ctx.db
    .query("docs")
    .withIndex("by_project_id", (q: any) => q.eq("project_id", project._id))
    .take(TIMELINE_MAX_DOCS);
  for (const d of rawDocs) {
    if (!(await canAccessDoc(ctx, userId, d))) continue;
    push({
      ts: d.created_at,
      type: "doc_created",
      actor: await userName(ctx, names, d.user_id),
      doc: { id: String(d._id), title: d.title, doc_type: d.doc_type },
    });
  }

  events.sort((a, b) => b.ts - a.ts);
  return events.slice(0, limit);
}

// ── Web surface ───────────────────────────────────────────────────────────

export const webList = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return null;
    return updatesWithComments(ctx, args.project_id);
  },
});

export const webTimeline = query({
  args: {
    project_id: v.id("projects"),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return null;
    return buildProjectTimeline(ctx, userId, project, { limit: args.limit, since: args.since });
  },
});

export const webPost = mutation({
  args: {
    project_id: v.id("projects"),
    body: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!args.body.trim()) throw new Error("Update body is empty");
    const project = await requireProject(ctx, userId, args.project_id);
    const user = await ctx.db.get(userId);
    return insertUpdate(ctx, project, {
      user_id: userId,
      author: user?.name || user?.email || "unknown",
      author_user_id: userId,
      author_kind: "user",
      kind: "update",
      title: args.title,
      body: args.body,
    });
  },
});

export const webComment = mutation({
  args: {
    update_id: v.id("project_updates"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (!args.text.trim()) throw new Error("Comment is empty");
    const { update } = await requireUpdate(ctx, userId, args.update_id);
    const user = await ctx.db.get(userId);
    const id = await insertComment(ctx, update, {
      author: user?.name || user?.email || "unknown",
      author_user_id: userId,
      author_kind: "user",
      text: args.text,
    });
    return { id };
  },
});

export const webEdit = mutation({
  args: {
    id: v.id("project_updates"),
    body: v.optional(v.string()),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const { update } = await requireUpdate(ctx, userId, args.id);
    // Only the author edits their words.
    if (String(update.author_user_id) !== String(userId)) throw new Error("Update not found");
    const now = Date.now();
    const patch: any = { updated_at: now, edited_at: now };
    if (args.body !== undefined) {
      if (!args.body.trim()) throw new Error("Update body is empty");
      patch.body = args.body.slice(0, MAX_BODY);
    }
    if (args.title !== undefined) patch.title = args.title.slice(0, MAX_TITLE);
    await ctx.db.patch(args.id, patch);
    await ctx.db.patch(update.project_id, { updated_at: now });
    return { success: true };
  },
});

export const webDelete = mutation({
  args: { id: v.id("project_updates") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    const { update, project } = await requireUpdate(ctx, userId, args.id);
    // The author, or the project owner, may remove a post.
    const isAuthor = String(update.author_user_id) === String(userId);
    const isProjectOwner = String(project.user_id) === String(userId);
    if (!isAuthor && !isProjectOwner) throw new Error("Update not found");
    const comments = await ctx.db
      .query("project_update_comments")
      .withIndex("by_update_created", (q: any) => q.eq("update_id", args.id))
      .collect();
    for (const c of comments) await ctx.db.delete(c._id);
    await ctx.db.delete(args.id);
    await ctx.db.patch(update.project_id, { updated_at: Date.now() });
    return { success: true };
  },
});

// ── CLI surface ───────────────────────────────────────────────────────────

export const post = mutation({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
    body: v.string(),
    title: v.optional(v.string()),
    kind: v.optional(v.union(v.literal("update"), v.literal("digest"))),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    if (!args.body.trim()) throw new Error("Update body is empty");
    const project = await requireProject(ctx, auth.userId, args.id);
    const user = await ctx.db.get(auth.userId);

    let conversation_id: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", args.conversation_id!))
        .first();
      // Only link a session the poster owns — the id names their own agent run,
      // never a handle onto someone else's conversation.
      if (conv && String(conv.user_id) === String(auth.userId)) conversation_id = conv._id;
    }

    // Same rule as task comments: a post from inside a session is an agent's.
    // Judged on the RESOLVED conversation — an id that resolves to nothing (or
    // to someone else's session) must not strip authorship from the poster.
    const fromAgent = !!conversation_id;
    return insertUpdate(ctx, project, {
      user_id: auth.userId,
      author: user?.name || user?.email || "unknown",
      author_user_id: fromAgent ? undefined : auth.userId,
      author_kind: fromAgent ? "agent" : "user",
      kind: args.kind ?? "update",
      title: args.title,
      body: args.body,
      conversation_id,
    });
  },
});

export const listUpdates = query({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const project = await ctx.db.get(args.id);
    if (!project || !(await canAccessProject(ctx, auth.userId, project))) return null;
    return updatesWithComments(ctx, args.id);
  },
});

export const comment = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    text: v.string(),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    if (!args.text.trim()) throw new Error("Comment is empty");
    const update = await ctx.db
      .query("project_updates")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", args.short_id))
      .first();
    if (!update) throw new Error("Update not found");
    const project = await ctx.db.get(update.project_id);
    if (!project || !(await canAccessProject(ctx, auth.userId, project))) {
      throw new Error("Update not found");
    }
    const user = await ctx.db.get(auth.userId);
    // Same resolution + ownership rule as post above.
    let conversation_id: Id<"conversations"> | undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q: any) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv && String(conv.user_id) === String(auth.userId)) conversation_id = conv._id;
    }
    const fromAgent = !!conversation_id;
    const id = await insertComment(ctx, update, {
      author: user?.name || user?.email || "unknown",
      author_user_id: fromAgent ? undefined : auth.userId,
      author_kind: fromAgent ? "agent" : "user",
      text: args.text,
      conversation_id,
    });
    return { id };
  },
});

export const timeline = query({
  args: {
    api_token: v.string(),
    id: v.id("projects"),
    limit: v.optional(v.number()),
    since: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");
    const project = await ctx.db.get(args.id);
    if (!project || !(await canAccessProject(ctx, auth.userId, project))) return null;
    return buildProjectTimeline(ctx, auth.userId, project, {
      limit: args.limit,
      since: args.since,
    });
  },
});
