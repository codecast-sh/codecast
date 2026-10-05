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
import { isActiveTask, isOnHumanBoard, isTerminalTaskStatus, TASK_PRIORITIES, TASK_STATUS_CATEGORIES } from "@codecast/shared/tasks";
import { internalMutation, internalQuery } from "../../functions";
import type { Doc, Id } from "../../_generated/dataModel";
import { scopedFetch } from "../../data";
import { resolveWorkspaceKey, workspaceKey } from "../../lib/access";
import { createTaskAs, updateTaskAs } from "../../tasks";
import { createDocAs, ownDocsBySourceFile, updateDocAs } from "../../docs";
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

/** Why a change to this task or doc would reach someone other than the
 *  person, or null when only the person sees it. A task synced with a GitHub
 *  or Linear issue pushes every change to that issue (lib/taskWrite.patchTask),
 *  and a row shared by link shows its latest text to anyone holding the link
 *  (publicShare.ts). The tools that change rows without asking refuse such a
 *  row, so text read from mail or the web never leaves through them. */
export function publicCopy(row: Pick<Doc<"tasks">, "share_token"> & { external?: Doc<"tasks">["external"] }): { reason: string; changeIn: string } | null {
  if (row.external) {
    const provider = row.external.provider === "github" ? "GitHub" : "Linear";
    return { reason: `is linked to the ${provider} issue ${row.external.identifier}, so a change here would post to that issue`, changeIn: provider };
  }
  if (row.share_token) return { reason: "is shared by link, so anyone with the link would see a change made here", changeIn: "codecast on the web" };
  return null;
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);
const clip = (text: string | undefined, max: number) =>
  !text ? undefined : text.length > max ? `${text.slice(0, max)}…` : text;

// ── Tasks ───────────────────────────────────────────────────────────────────

/** open: not finished. done: finished, done or dropped. all: both. */
export const TASK_LIST_FILTERS = ["open", "done", "all"] as const;

export const listTasks = internalQuery({
  args: {
    user_id: v.id("users"),
    filter: v.optional(v.union(...TASK_LIST_FILTERS.map((f) => v.literal(f)))),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(args.limit ?? 50, 200));
    // The most recently changed rows, so an old open task that moved lately
    // is not cut off by newer ones, and only the rows the person's own board
    // shows: no mined suggestions, no unpromoted insights.
    const { records } = await scopedFetch(ctx, "tasks", { userId: args.user_id, workspace: "personal", limit: 500, updatedSince: 0 });
    const filter = args.filter ?? "open";
    return records
      .filter((t) => isActiveTask(t) && isOnHumanBoard(t))
      .filter((t) => filter === "all" || isTerminalTaskStatus(t.status) === (filter === "done"))
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

const taskPriority = v.union(...TASK_PRIORITIES.map((p) => v.literal(p)));
const taskStatus = v.union(...TASK_STATUS_CATEGORIES.map((s) => v.literal(s)));

export const createTask = internalMutation({
  args: {
    user_id: v.id("users"),
    title: v.string(),
    description: v.optional(v.string()),
    priority: v.optional(taskPriority),
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
    status: v.optional(taskStatus),
    priority: v.optional(taskPriority),
  },
  handler: async (ctx, args) => {
    const { user_id, id, ...fields } = args;
    const task = await personalTask(ctx, user_id, id);
    const shown = publicCopy(task);
    if (shown) throw new Error(`Task ${id} ${shown.reason}. Change it in ${shown.changeIn}.`);
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
    // Appending runs without asking; replacing goes through the gate, where
    // the person sees the new text before it lands.
    const shown = args.append ? publicCopy(doc) : null;
    if (shown) throw new Error(`Doc "${doc.title}" ${shown.reason}. Use replace_doc, which shows the person the new text first.`);
    const content = args.append ? `${(doc.content ?? "").trimEnd()}\n\n${args.content}` : args.content;
    await updateDocAs(ctx, args.user_id, { id: doc._id, content, ...(args.title?.trim() ? { title: args.title.trim() } : {}) });
    return { id: String(doc._id), created: false };
  },
});

// ── Memory: one doc per person ──────────────────────────────────────────────

/** The person's live memory doc: their newest one not archived. Archiving it
 *  is how the person makes the assistant forget, so an archived one is gone:
 *  recall finds nothing and the next remember starts a fresh doc. */
async function memoryDoc(ctx: Ctx, userId: Id<"users">): Promise<Doc<"docs"> | null> {
  return await ownDocsBySourceFile(ctx, userId, memoryKey(userId))
    .filter((q: any) => q.eq(q.field("archived_at"), undefined))
    .first();
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
    const shown = publicCopy(doc);
    if (shown) throw new Error(`"${MEMORY_DOC_TITLE}" ${shown.reason}. Ask the person to stop sharing it before adding more.`);
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
