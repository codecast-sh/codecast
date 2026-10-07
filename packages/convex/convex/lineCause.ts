// Changing the line with an agent (docs/architecture/line-map.md LX6). A
// person writes, on a node of the line map, what should change about it; the
// change is filed as a cause in the project, category `line`, its subject the
// node (`line:station:prove`, `line:finder:agentwatch`), the person's words
// its first signal. Filing goes through the signal door's commit
// (signals.commitSignal), so the cause and its signal are written exactly as
// `cast signal add` writes them. "Start now" starts the project's line on the
// cause through the run start the line's own admission uses
// (orgLine.startLineRun), for the role that leads the project.
//
// Both run as dispatch side effects (dispatch.ts fileLineCause,
// startLineCause): the store paints the cause at once, and a throw here is a
// refusal the store takes back.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { createDataContext } from "./data";
import { canAccessProject, canAccessTask } from "./lib/access";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { allRolesInBoundary, userCanAccessRole } from "./lib/orgAccess";
import { projectLeadOf } from "@codecast/shared/contracts/orgLead";
import { commitSignal, normalizeSignal } from "./signals";
import { startLineRun } from "./orgLine";
import { cancelCore } from "./workflow_runs";
import { CARD_GATE_NODE_ID } from "@codecast/shared/contracts/changeCard";

export const LINE_SUBJECT_PREFIX = "line:";

export type LineCauseInput = { subject: string; title: string; detail_md: string };

/**
 * The signal a person's request becomes. Its fingerprint is the node plus the
 * client's key, so every request opens its own cause (a person asking twice
 * about one station asks for two changes), and a replayed request finds the
 * signal it already wrote.
 */
export function lineCauseSignal(clientKey: string, input: LineCauseInput) {
  return normalizeSignal({
    source: "person",
    kind: "request",
    fingerprint: `${input.subject}#${clientKey}`,
    title: input.title,
    detail_md: input.detail_md,
    subject: input.subject,
  });
}

export async function fileLineCauseCore(ctx: any, userId: Id<"users">, clientKey: string, projectId: Id<"projects">, input: LineCauseInput) {
  if (!clientKey || clientKey.length > 64) throw new ConvexError("A line cause needs its client key");
  if (!input?.subject?.startsWith(LINE_SUBJECT_PREFIX)) throw new ConvexError("A line cause names a node of the line (line:station:<id>, line:finder:<source>, ...)");
  const existing: Doc<"tasks"> | null = await ctx.db
    .query("tasks")
    .withIndex("by_client_key", (q: any) => q.eq("user_id", userId).eq("client_key", clientKey))
    .first();
  if (existing) return { task_id: existing._id, task_short_id: existing.short_id };

  const project: Doc<"projects"> | null = await ctx.db.get(projectId);
  if (!project || !(await canAccessProject(ctx, userId, project))) throw new ConvexError("Project not found");
  // The cause lives where the project lives.
  const ws = parseWorkspaceKey(project.workspace);
  if (!ws) throw new ConvexError("Project not found");
  const db = await createDataContext(ctx, ws.type === "team" ? { userId, workspace: "team", team_id: ws.teamId } : { userId, workspace: "personal" });
  if (db.workspaceKey !== project.workspace) throw new ConvexError("This project is in another workspace");

  const result = await commitSignal(ctx, db, userId, lineCauseSignal(clientKey, input), null, Date.now(), project._id, { category: "line", client_key: clientKey });
  return { task_id: result.task_id, task_short_id: result.task_short_id, signal_short_id: result.short_id };
}

/** The role whose line runs a project's causes: the project's lead (LP1). */
async function leadRoleOf(ctx: any, project: Doc<"projects">): Promise<any | null> {
  const ws = parseWorkspaceKey(project.workspace);
  if (!ws) return null;
  const roles = await allRolesInBoundary(ctx, ws.type === "team" ? { team_id: ws.teamId } : { scope_user_id: ws.userId });
  const lead = projectLeadOf(project as any, roles);
  return lead.kind === "lead" ? lead.role : null;
}

export async function startLineCauseCore(ctx: any, userId: Id<"users">, taskId: Id<"tasks">) {
  const task: Doc<"tasks"> | null = await ctx.db.get(taskId);
  if (!task || !(await canAccessTask(ctx, userId, task))) throw new ConvexError("Cause not found");
  const project: Doc<"projects"> | null = task.project_id ? await ctx.db.get(task.project_id) : null;
  if (!project) throw new ConvexError("This cause is in no project, so no line runs it");
  const role = await leadRoleOf(ctx, project);
  if (!role) throw new ConvexError("No role leads this project yet, so no line runs its causes. Name a lead on the project's page.");
  if (role.status !== "active") throw new ConvexError(`@${role.handle} is paused, so its line starts nothing`);
  if (!(await userCanAccessRole(ctx, userId, role))) throw new ConvexError("You cannot start this project's line");
  await endStalledRun(ctx, task);
  // createRunCore refuses a cause that already holds a live run.
  const runId = await startLineRun(ctx, role, task);
  return { run_id: runId, role_handle: role.handle };
}

/** A runner picks an answered card up within seconds; a run at the card gate
 *  that has reported nothing this long has none (the web trace's shipStall
 *  reads the same wait, line-map.md LX4). */
const STALLED_MS = 15 * 60_000;

/** The run a cause holds, when it sits at the card gate with nothing driving
 *  it: ended, so starting the cause again is the way out of the stall rather
 *  than a refusal. Any other live run is left for createRunCore to refuse. */
async function endStalledRun(ctx: any, task: Doc<"tasks">, now = Date.now()) {
  const run: any = task.workflow_run_id ? await ctx.db.get(task.workflow_run_id) : null;
  if (!run || run.status !== "running" || run.current_node_id !== CARD_GATE_NODE_ID) return;
  if (now - (run.updated_at ?? 0) < STALLED_MS) return;
  await cancelCore(ctx, run, now, "Nothing drove it after its card was answered, so the line started the cause again");
}
