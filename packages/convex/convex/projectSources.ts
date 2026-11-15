// A project's sources: the triggers that feed it (agent_tasks.project_id).
// A chat channel or any trigger event attached to a project wakes the
// project's main session with what arrived, so its agent does the first pass
// before a person reads it. The main session is resolved at each firing
// (session-projects.md SP4), so a newly seated lead takes the next one; a
// project with no main session yet gets one started the way its composer
// starts it. Pausing the project pauses them all (lib/agentTaskRows
// syncProjectTriggers).

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./functions";
import { canAccessConversation, canAccessProject } from "./lib/access";
import { canAccessChannel } from "./chatAccess";
import { mainSessionFor, mainSessionRefusal } from "./lib/projectMainSession";
import { deliverTriggerRun, failTriggerFiring, insertTask, nextArmingAfterRun } from "./agentTasks";
import { patchTask, projectQuiet, projectRunsInline } from "./lib/agentTaskRows";
import { startSessionAsComposer } from "./dispatch";
import { TRIGGER_EVENT_SHORTHANDS, triggerEventLabel } from "@codecast/shared/contracts";

/** What a source's run is asked to do. The event lines follow it in the frame. */
export const PROJECT_SOURCE_PROMPT = [
  "New items arrived from one of this project's sources. Do the first pass before a person reads them.",
  "Read each item in full where it lives. Act on what is plainly this project's work and within this session's authority; put what needs a person on the project's existing work, with the item named, rather than in a new thread.",
  "An item that asks for nothing gets nothing. Never reply in the source for the sake of acknowledging it.",
].join("\n");

export const fireProjectTrigger = internalMutation({
  args: { task_id: v.id("agent_tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.task_id);
    const now = Date.now();
    // An outrun wake (a later window, a pause, a run already taken) does nothing.
    if (!task || !projectRunsInline(task) || task.status !== "scheduled" || task.run_at === undefined || task.run_at > now) return null;
    const project = await ctx.db.get(task.project_id!);
    if (!project || !(await canAccessProject(ctx, task.user_id, project))) {
      await failTriggerFiring(ctx, task, "Its project is gone, or its owner can no longer read it");
      return null;
    }
    // A quiet project wakes nobody, whatever resumed this one trigger: it waits with the project's others.
    if (projectQuiet(project.status)) {
      await patchTask(ctx, task, { status: "paused", paused_by_project_id: project._id });
      return null;
    }
    // A paused lead's seat takes no turns (org-staffing.md S25): the firing is dropped, as its own routines are.
    const lead = project.owner_role_id ? await ctx.db.get(project.owner_role_id) : null;
    if (lead?.status === "paused") {
      await patchTask(ctx, task, nextArmingAfterRun(task, now));
      return null;
    }
    const main = await mainSessionFor(ctx, project);
    const refusal = mainSessionRefusal(main, task.user_id);
    if (refusal) {
      await failTriggerFiring(ctx, task, refusal);
      return null;
    }
    const pending = task.pending_events ?? [];
    const events = main ? pending.filter((e) => e.origin_conversation_id !== String(main._id)) : pending;
    // Every line was the main session's own: nothing to read, nothing to run.
    if (pending.length > 0 && events.length === 0) {
      await patchTask(ctx, task, nextArmingAfterRun(task, now));
      return null;
    }
    let target = main;
    if (!target) {
      const id = await startSessionAsComposer(ctx as any, task.user_id, {
        project_id: String(project._id),
        project_default: true,
        ...(project.project_path ?? task.project_path ? { project_path: project.project_path ?? task.project_path } : {}),
        ...(task.agent_type === "codex" ? { agent_type: "codex" } : {}),
      });
      target = await ctx.db.get(id);
      if (!target) return null;
    }
    await deliverTriggerRun(ctx, task, target, `project-trigger:${task._id}:${task.run_count}`, { pending_events: events });
    return target._id;
  },
});

/** Attach a source to a project: a chat channel (by id), or a trigger event
 *  by its name. The trigger is the caller's, and its runs land in the main
 *  session. `client_key` is the store stub's key, superseded by this row. */
export const webAddSource = mutation({
  args: {
    project_id: v.id("projects"),
    channel_id: v.optional(v.string()),
    event: v.optional(v.string()),
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    return await addProjectSource(ctx, userId, args);
  },
});

/** A project holds a handful of live sources; finished one-shot triggers pile
 *  up beside them, so the read walks newest first and stops at either cap. */
const PROJECT_SOURCES_SHOWN = 50;
const PROJECT_SOURCES_SCAN = 500;

/** The project's sources its teammates armed, for anyone who may read the
 *  project: the Sources panel lists every source, the viewer's own from their
 *  trigger list (agentTasks.webList) and these beside them. Read only: the
 *  verbs stay with each trigger's owner. A source on a channel the viewer
 *  cannot open is left out, and its last run is named only when the viewer
 *  may open that session. */
export const teammateSources = query({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, userId, project))) return [];
    const names = new Map<string, string>();
    const out = [];
    let scanned = 0;
    for await (const t of ctx.db.query("agent_tasks").withIndex("by_project", (q: any) => q.eq("project_id", project._id)).order("desc")) {
      if (++scanned > PROJECT_SOURCES_SCAN || out.length >= PROJECT_SOURCES_SHOWN) break;
      if (String(t.user_id) === String(userId) || t.status === "completed" || t.status === "cancelled") continue;
      const channelId = t.event_filter?.channel_id ? ctx.db.normalizeId("chat_channels", t.event_filter.channel_id) : null;
      const channel = channelId ? await ctx.db.get(channelId) : null;
      if (t.event_filter?.channel_id && !(channel && (await canAccessChannel(ctx as any, userId, channel)))) continue;
      const run = t.last_run_conversation_id ? await ctx.db.get(t.last_run_conversation_id) : null;
      if (!names.has(String(t.user_id))) names.set(String(t.user_id), ((await ctx.db.get(t.user_id)) as any)?.name ?? "A teammate");
      out.push({
        _id: t._id,
        project_id: t.project_id,
        title: t.title,
        status: t.status,
        event_filter: t.event_filter ? { event_type: t.event_filter.event_type, ...(t.event_filter.channel_id ? { channel_id: t.event_filter.channel_id } : {}) } : undefined,
        paused_by_project_id: t.paused_by_project_id,
        last_run_at: t.last_run_at,
        last_run_failed: t.last_run_failed,
        last_run_conversation_id: run && (await canAccessConversation(ctx as any, userId, run as any)) ? t.last_run_conversation_id : undefined,
        run_count: t.run_count ?? 0,
        owner_name: names.get(String(t.user_id))!,
      });
    }
    return out;
  },
});

export async function addProjectSource(
  ctx: any,
  userId: Id<"users">,
  args: { project_id: Id<"projects">; channel_id?: string; event?: string; client_key?: string },
): Promise<{ id: Id<"agent_tasks">; short_id: string }> {
  const project = await ctx.db.get(args.project_id);
  if (!project || !(await canAccessProject(ctx, userId, project))) throw new Error("Project not found");
  if (!!args.channel_id === !!args.event) throw new Error("A source is one channel or one event");
  const event = args.channel_id ? "chat_message" : args.event!;
  const base = TRIGGER_EVENT_SHORTHANDS[event];
  if (!base) throw new Error(`Unknown event "${event}"`);
  const event_filter = { ...base, ...(args.channel_id ? { channel_id: args.channel_id } : {}) };
  if (args.client_key) {
    const existing = await ctx.db.query("agent_tasks").withIndex("by_project", (q: any) => q.eq("project_id", project._id)).collect();
    const replay = existing.find((t: Doc<"agent_tasks">) => t.client_key === args.client_key && String(t.user_id) === String(userId));
    if (replay) return { id: replay._id, short_id: replay.short_id ?? "" };
  }
  const created = await insertTask(ctx, userId, {
    title: triggerEventLabel(event),
    prompt: PROJECT_SOURCE_PROMPT,
    project_path: project.project_path,
    schedule_type: "event",
    event_filter,
    mode: "apply",
    project_id: project._id,
  });
  // Named after the channel the save resolved ("#name" or an id).
  const row = await ctx.db.get(created.id);
  const channelId = row?.event_filter?.channel_id ? ctx.db.normalizeId("chat_channels", row.event_filter.channel_id) : null;
  const channel = channelId ? await ctx.db.get(channelId) : null;
  await ctx.db.patch(created.id, { ...(channel ? { title: `#${channel.name}` } : {}), ...(args.client_key ? { client_key: args.client_key } : {}) });
  return created;
}
