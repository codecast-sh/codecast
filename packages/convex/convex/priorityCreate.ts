// A priority, or a milestone of one, that a person names rather than the pass
// infers: `cast priorities create` and `cast task create --under pri-N`. A
// member of a workspace may create one there for themselves or a teammate
// (Scribe files a call's themes for whoever owns them); one pulled from a call
// is readable by whoever can read the call (lib/priorityAccess canRead), and
// a milestone goes only on a priority the writer can read. No Convex
// functions here.

import { lastPriorityKey } from "@codecast/shared/contracts/priorities";
import { matchHandle } from "@codecast/shared/chat";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { FEATURE, featureCheck, readerFor } from "./lib/priorityAccess";
import { activeGroup, stepKeyMark } from "./lib/priorityGroup";
import { askRerun } from "./lib/priorityClassifierHook";
import { insertPriority } from "./lib/priorityInsert";
import { teamRoster } from "./lib/mentionResolve";
import { teamFeatureOffMessage } from "./lib/teamFeatureGuard";
import { resolveFromCall } from "./callReads";
import type { Doc, Id } from "./_generated/dataModel";
import { type Result, readable } from "./priorityRead";

type Ctx = { db: any; scheduler?: any };
const MAX_TITLE = 200;

/** The workspace member `owner` names (`@handle`, or none or "me" for the caller). */
async function ownerFor(ctx: Ctx, viewer: Id<"users">, workspace: string, owner: string | undefined): Promise<Result<Id<"users">>> {
  const handle = owner?.trim().replace(/^@/, "");
  if (!handle || handle === "me") return viewer;
  const ws = parseWorkspaceKey(workspace);
  if (ws?.type !== "team") return { error: "a personal priority is your own; name a team to file one for someone else" };
  const match = matchHandle(await teamRoster(ctx, ws.teamId), handle);
  if (!match || match.is_bot) return { error: `nobody in this team answers to @${handle}` };
  return match._id;
}

/**
 * A new active priority in `workspace` (one createWorkContext resolved, so
 * the caller is a member), owned by the caller or a teammate
 * there, last in its owner's order (as a restore places one). Status and rank
 * stay the pass's to change, as for one it created.
 */
export async function doCreate(
  ctx: Ctx,
  viewer: Id<"users">,
  args: { workspace: string; title: string; summary?: string; owner?: string; from_call?: string },
): Promise<Result<{ short_id: string; title: string; owner_id: Id<"users"> }>> {
  const title = args.title.trim();
  if (!title) return { error: "a priority needs a title" };
  if (title.length > MAX_TITLE) return { error: `a title is at most ${MAX_TITLE} characters` };
  if (!(await featureCheck(ctx)(args.workspace))) return { error: teamFeatureOffMessage(FEATURE) };
  const owner = await ownerFor(ctx, viewer, args.workspace, args.owner);
  if (typeof owner === "object") return owner;
  const from_call = (await resolveFromCall(ctx, viewer, args.from_call)) ?? undefined;
  const now = Date.now();
  const { short_id } = await insertPriority(ctx, {
    user_id: owner,
    workspace: args.workspace,
    title,
    summary: args.summary?.trim() ?? "",
    status: "active",
    ai_rank: lastPriorityKey(await activeGroup(ctx, owner, args.workspace)),
    steps: [],
    first_seen_at: now,
    last_active_at: now,
    pass_at: 0,
    from_call,
  }, now);
  await askRerun(ctx, owner, args.workspace);
  return { short_id, title, owner_id: owner };
}

/**
 * The priority `cast task create --under pri-N` files a milestone on, judged
 * before the task exists so a refusal files nothing: one the caller can read
 * (priorityRead readable, so a missing and an unreadable one answer alike),
 * in the task's own workspace.
 */
export async function priorityForTaskStep(ctx: Ctx, viewer: Id<"users">, shortId: string, taskWorkspace: string): Promise<Doc<"priorities">> {
  const p = await readable(ctx, await readerFor(ctx, viewer), shortId);
  if ("error" in p) throw new Error(p.error);
  if (p.workspace !== taskWorkspace) throw new Error(`${p.short_id} is in another workspace than this task; pass --team to file the task where the priority is`);
  return p;
}

/** A new critical milestone on `p` naming the task, its key after every key the priority has spent; the person's tier, so the pass keeps it. */
export async function appendTaskStep(ctx: Ctx, p: Doc<"priorities">, task: { short_id: string; title: string }): Promise<string> {
  const mark = (await stepKeyMark(ctx, p)) + 1;
  const key = `s${mark}`;
  const step = { key, title: task.title, tier: "critical" as const, tier_set_by: "person" as const, refs: [{ kind: "task" as const, id: task.short_id }], done: false };
  await ctx.db.patch(p._id, { steps: [...p.steps, step], step_key_max: mark, updated_at: Date.now() });
  await askRerun(ctx, p.user_id, p.workspace);
  return key;
}
