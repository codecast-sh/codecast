// The codecast side of the hosted assistant's tools (plan pl-840, build spec
// docs/architecture/hosted-assistant.md): tasks, docs, routines and the
// person's memory, as internal functions the turn action calls for the
// conversation's owner. Each one runs the same path the web runs for that
// person (tasks.createTaskAs / updateTaskAs, docs.createDocAs / updateDocAs,
// agentTasks.insertTask / applyCancel), so access, history and the plan's
// routine limits apply exactly as they do anywhere else.
//
// The assistant works in the person's own workspace only: it lists, reads
// and changes rows whose access key is `user:<owner>`, never a team's. A team
// row is invisible here even when the person could open it on the web, so
// nothing a teammate wrote reaches a hosted turn through these tools.
//
// No module here imports the harness; the tool definitions live beside it
// (codecast.ts) and call these through ctx.runQuery / ctx.runMutation.
import { v } from "convex/values";
import { HOSTED_AGENT_TYPE } from "@codecast/shared/contracts/assistant";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { internalMutation, internalQuery } from "../../functions";
import type { Doc, Id } from "../../_generated/dataModel";
import { scopedFetch } from "../../data";
import { resolveWorkspaceKey, workspaceKey } from "../../lib/access";
import { createTaskAs, updateTaskAs } from "../../tasks";
import { createDocAs, updateDocAs } from "../../docs";
import { applyCancel, insertTask, logVerb } from "../../agentTasks";

type Ctx = { db: any };

/** The title of the one doc per person that holds what the assistant remembers. */
export const MEMORY_DOC_TITLE = "What I know about you";
/** The most the memory doc holds; past it, remember asks the person to tidy it. */
export const MEMORY_MAX_CHARS = 20_000;
/** How much of one doc a read returns. */
export const DOC_READ_MAX_CHARS = 20_000;

const memoryKey = (userId: Id<"users">) => `assistant-memory:${userId}`;

async function inPersonalWorkspace(ctx: Ctx, userId: Id<"users">, row: any): Promise<boolean> {
  return (await resolveWorkspaceKey(ctx, row)) === workspaceKey({ type: "personal", userId });
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);
const clip = (text: string | undefined, max: number) =>
  !text ? undefined : text.length > max ? `${text.slice(0, max)}…` : text;

// ── Tasks ───────────────────────────────────────────────────────────────────

export const TASK_LIST_FILTERS = ["open", "done", "all"] as const;

export const listTasks = internalQuery({
  args: {
    user_id: v.id("users"),
    filter: v.optional(v.union(...TASK_LIST_FILTERS.map((f) => v.literal(f)))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    const { records } = await scopedFetch(ctx, "tasks", { userId: args.user_id, workspace: "personal", limit: 500 });
    const filter = args.filter ?? "open";
    return records
      .filter((t) => filter === "all" || (filter === "done" ? t.status === "done" : !isTerminalTaskStatus(t.status)))
      .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, limit)
      .map((t) => ({
        id: t.short_id as string,
        title: t.title as string,
        status: t.status as string,
        priority: t.priority as string,
        ...(t.description ? { description: clip(t.description, 400) } : {}),
        updated: iso(t.updated_at),
      }));
  },
});

export const TASK_PRIORITIES = ["urgent", "high", "medium", "low", "none"] as const;

export const createTask = internalMutation({
  args: {
    user_id: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user_id, ...fields } = args;
    const created = await createTaskAs(ctx, user_id, { ...fields, workspace: "personal" });
    return { id: created.short_id as string };
  },
});

async function personalTask(ctx: Ctx, userId: Id<"users">, shortId: string): Promise<Doc<"tasks">> {
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_short_id", (q: any) => q.eq("short_id", shortId))
    .first();
  if (!task || !(await inPersonalWorkspace(ctx, userId, task))) throw new Error(`No task ${shortId} in your own list`);
  return task;
}

export const updateTask = internalMutation({
  args: {
    user_id: v.id("users"),
    id: v.string(),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user_id, id, ...fields } = args;
    await personalTask(ctx, user_id, id);
    await updateTaskAs(ctx, user_id, { short_id: id, ...fields });
    const after = await personalTask(ctx, user_id, id);
    return { id, title: after.title, status: after.status, priority: after.priority };
  },
});

// ── Docs ────────────────────────────────────────────────────────────────────

async function personalDoc(ctx: Ctx, userId: Id<"users">, id: string): Promise<Doc<"docs"> | null> {
  const docId = ctx.db.normalizeId("docs", id);
  const doc = docId ? await ctx.db.get(docId) : null;
  if (!doc || doc.archived_at || !(await inPersonalWorkspace(ctx, userId, doc))) return null;
  return doc;
}

/** One doc by id, or the person's docs whose titles match `query`, the best
 *  match read in full. */
export const readDoc = internalQuery({
  args: { user_id: v.id("users"), id: v.optional(v.string()), query: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let doc: Doc<"docs"> | null = null;
    let others: { id: string; title: string }[] = [];
    if (args.id) {
      doc = await personalDoc(ctx, args.user_id, args.id);
      if (!doc) throw new Error("No doc with that id in your own docs");
    } else {
      const query = args.query?.trim();
      if (!query) throw new Error("Give a doc id or words from its title");
      const hits = await ctx.db
        .query("docs")
        .withSearchIndex("search_docs_v2", (q: any) => q.search("title", query).eq("user_id", args.user_id))
        .take(10);
      const mine: Doc<"docs">[] = [];
      for (const hit of hits) if (!hit.archived_at && (await inPersonalWorkspace(ctx, args.user_id, hit))) mine.push(hit);
      if (mine.length === 0) return { found: false as const };
      [doc] = mine;
      others = mine.slice(1, 6).map((d) => ({ id: String(d._id), title: d.title }));
    }
    const content = doc!.content ?? "";
    return {
      found: true as const,
      id: String(doc!._id),
      title: doc!.title,
      updated: iso(doc!.updated_at),
      content: content.slice(0, DOC_READ_MAX_CHARS),
      truncated: content.length > DOC_READ_MAX_CHARS,
      others,
    };
  },
});

/** Create a doc in the person's own workspace, or change one there:
 *  replace its body, or append to it. */
export const writeDoc = internalMutation({
  args: {
    user_id: v.id("users"),
    id: v.optional(v.string()),
    title: v.optional(v.string()),
    content: v.string(),
    append: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (!args.id) {
      const title = args.title?.trim();
      if (!title) throw new Error("A new doc needs a title");
      const { id } = await createDocAs(ctx, args.user_id, { title, content: args.content, workspace: "personal" });
      return { id: String(id), created: true };
    }
    const doc = await personalDoc(ctx, args.user_id, args.id);
    if (!doc) throw new Error("No doc with that id in your own docs");
    const content = args.append ? `${(doc.content ?? "").trimEnd()}\n\n${args.content}` : args.content;
    await updateDocAs(ctx, args.user_id, { id: doc._id, content, ...(args.title?.trim() ? { title: args.title.trim() } : {}) });
    return { id: String(doc._id), created: false };
  },
});

// ── Memory: one doc per person ──────────────────────────────────────────────

async function memoryDoc(ctx: Ctx, userId: Id<"users">): Promise<Doc<"docs"> | null> {
  const doc = await ctx.db
    .query("docs")
    .withIndex("by_source_file", (q: any) => q.eq("source_file", memoryKey(userId)))
    .first();
  return doc && String(doc.user_id) === String(userId) ? doc : null;
}

export const recall = internalQuery({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const doc = await memoryDoc(ctx, args.user_id);
    return { doc_id: doc ? String(doc._id) : undefined, content: doc?.content ?? "" };
  },
});

/** Add one fact to the person's memory doc, creating the doc the first time.
 *  The doc is an ordinary personal doc, so the person reads and edits it
 *  like any other. */
export const remember = internalMutation({
  args: { user_id: v.id("users"), fact: v.string() },
  handler: async (ctx, args) => {
    const fact = args.fact.replace(/\s+/g, " ").trim();
    if (!fact) throw new Error("Nothing to remember");
    const line = `- ${fact}`;
    const doc = await memoryDoc(ctx, args.user_id);
    if (!doc) {
      const { id } = await createDocAs(ctx, args.user_id, { title: MEMORY_DOC_TITLE, content: line, workspace: "personal" });
      await ctx.db.patch(id, { source_file: memoryKey(args.user_id), source: "agent" });
      return { doc_id: String(id) };
    }
    const content = `${(doc.content ?? "").trimEnd()}\n${line}`;
    if (content.length > MEMORY_MAX_CHARS) {
      throw new Error(`"${MEMORY_DOC_TITLE}" is full. Ask the person to tidy it before adding more.`);
    }
    await updateDocAs(ctx, args.user_id, { id: doc._id, content });
    return { doc_id: String(doc._id) };
  },
});

// ── Routines: triggers bound to this conversation ───────────────────────────

async function hostedHome(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">) {
  const home = await ctx.db.get(conversationId);
  if (!home || String(home.user_id) !== String(userId) || !isHostedAgentType(home.agent_type)) {
    throw new Error("Routines can only be set on your own assistant conversation");
  }
  return home;
}

const routineView = (task: Doc<"agent_tasks">) => ({
  id: task.short_id ?? String(task._id),
  title: task.display_title ?? task.title,
  status: task.status,
  schedule: task.schedule_type,
  ...(task.interval_ms ? { every_hours: Math.round((task.interval_ms / 3_600_000) * 100) / 100 } : {}),
  ...(task.run_at && task.status === "scheduled" ? { next_run: iso(task.run_at) } : {}),
  ...(task.last_run_at ? { last_run: iso(task.last_run_at) } : {}),
});

export const scheduleRoutine = internalMutation({
  args: {
    user_id: v.id("users"),
    conversation_id: v.id("conversations"),
    title: v.optional(v.string()),
    prompt: v.string(),
    run_at: v.number(),
    interval_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await hostedHome(ctx, args.user_id, args.conversation_id);
    const prompt = args.prompt.trim();
    if (!prompt) throw new Error("A routine needs something to do");
    const created = await insertTask(ctx, args.user_id, {
      title: args.title?.trim() || prompt.slice(0, 60),
      prompt,
      originating_conversation_id: String(args.conversation_id),
      created_by_conversation_id: String(args.conversation_id),
      agent_type: HOSTED_AGENT_TYPE,
      schedule_type: args.interval_ms ? "recurring" : "once",
      run_at: args.run_at,
      interval_ms: args.interval_ms,
    });
    const row = (await ctx.db.get(created.id as Id<"agent_tasks">)) as Doc<"agent_tasks">;
    return routineView(row);
  },
});

async function routinesOf(ctx: Ctx, userId: Id<"users">, conversationId: Id<"conversations">): Promise<Doc<"agent_tasks">[]> {
  const rows: Doc<"agent_tasks">[] = await ctx.db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q: any) => q.eq("originating_conversation_id", conversationId))
    .collect();
  return rows.filter((t) => String(t.user_id) === String(userId));
}

export const listRoutines = internalQuery({
  args: { user_id: v.id("users"), conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const rows = await routinesOf(ctx, args.user_id, args.conversation_id);
    return rows
      .filter((t) => t.status === "scheduled" || t.status === "running" || t.status === "paused")
      .sort((a, b) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity))
      .map(routineView);
  },
});

export const cancelRoutine = internalMutation({
  args: { user_id: v.id("users"), conversation_id: v.id("conversations"), id: v.string() },
  handler: async (ctx, args) => {
    const rows = await routinesOf(ctx, args.user_id, args.conversation_id);
    const task = rows.find((t) => t.short_id === args.id || String(t._id) === args.id);
    if (!task) throw new Error(`No routine ${args.id} on this conversation`);
    const cancelled = await logVerb(ctx, task, { userId: args.user_id, source: "web" }, applyCancel);
    return { id: args.id, cancelled };
  },
});
