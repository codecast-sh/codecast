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
import { internalMutation, mutation } from "./functions";
import { canAccessProject } from "./lib/access";
import { projectDefaultSessionId } from "./sessionProjects";
import { deliverTriggerRun, failTriggerFiring, insertTask, nextArmingAfterRun } from "./agentTasks";
import { patchTask, projectRunsInline } from "./lib/agentTaskRows";
import { startSessionAsComposer } from "./dispatch";
import { isHostedAgentType, TRIGGER_EVENT_SHORTHANDS, triggerEventLabel } from "@codecast/shared/contracts";

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
    const mainId = await projectDefaultSessionId(ctx, project);
    let main: Doc<"conversations"> | null = mainId ? await ctx.db.get(mainId) : null;
    // A machine turn goes only into a session its owner runs (sendMessageToSession's rule).
    if (main && (String(main.user_id) !== String(task.user_id) || isHostedAgentType(main.agent_type))) {
      await failTriggerFiring(ctx, task, `The project's main session ${main.short_id ?? main._id} is not run by this trigger's owner, so its runs cannot land there`);
      return null;
    }
    const pending = task.pending_events ?? [];
    const events = main ? pending.filter((e) => e.origin_conversation_id !== String(main!._id)) : pending;
    // Every line was the main session's own: nothing to read, nothing to run.
    if (pending.length > 0 && events.length === 0) {
      await patchTask(ctx, task, nextArmingAfterRun(task, now));
      return null;
    }
    if (!main) {
      const id = await startSessionAsComposer(ctx as any, task.user_id, {
        project_id: String(project._id),
        project_default: true,
        ...(project.project_path ?? task.project_path ? { project_path: project.project_path ?? task.project_path } : {}),
        ...(task.agent_type === "codex" ? { agent_type: "codex" } : {}),
      });
      main = await ctx.db.get(id);
      if (!main) return null;
    }
    await deliverTriggerRun(ctx, task, main, `project-trigger:${task._id}:${task.run_count}`, { pending_events: events });
    return main._id;
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
  const channel = args.channel_id ? await ctx.db.get(ctx.db.normalizeId("chat_channels", args.channel_id)) : null;
  const created = await insertTask(ctx, userId, {
    title: channel ? `#${channel.name}` : triggerEventLabel(event),
    prompt: PROJECT_SOURCE_PROMPT,
    project_path: project.project_path,
    schedule_type: "event",
    event_filter,
    mode: "apply",
    project_id: project._id,
  });
  if (args.client_key) await ctx.db.patch(created.id, { client_key: args.client_key });
  return created;
}
