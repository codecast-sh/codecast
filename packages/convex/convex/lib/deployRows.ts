// Plain helpers over deploy rows: the deploy a target runs now, a deploy by its dp-N, id or Actions run, and closing
// the open deploys a newer live one superseded. Kept out of deploys.ts so the dev push and dropped-work modules read
// them without importing an entry module.

import type { Doc } from "../_generated/dataModel";
import { normalizeRepository } from "./gitRefs";
import { targetDeploys } from "../deployTargetsState";
import { actionsRunKey, DEPLOY_SHORT_ID_RE, liveDeployOf, normalizeDeployTarget, type DeployStatus } from "@codecast/shared/contracts/deploys";

/** A marker reads this many of the workspace's deploys; the live deploy is looked for among this many of the target's. */
export const MARKER_SCAN = 100;

/** The target's current live deploy among `recent`, of the repository when both name one: the one that went live last (liveDeployOf). */
export function liveOf(recent: ReadonlyArray<Doc<"deploys">>, target: string, repository: string | undefined): Doc<"deploys"> | undefined {
  return liveDeployOf(recent, { target, repository });
}

/** The target's latest live deploy, among its newest MARKER_SCAN deploys. */
export async function latestLiveDeploy(ctx: any, workspace: string, target: string, repository?: string): Promise<Doc<"deploys"> | null> {
  const t = normalizeDeployTarget(target);
  if (!t) return null;
  return liveOf(await targetDeploys(ctx, workspace, t, MARKER_SCAN), t, repository ? normalizeRepository(repository) : undefined) ?? null;
}

export const OPEN: ReadonlySet<DeployStatus> = new Set(["requested", "running"]);

/** A deploy a report or marker may still finish: an open one, or one closed only because a newer deploy went live. */
export const finishable = (d: Pick<Doc<"deploys">, "status" | "superseded_by">) => OPEN.has(d.status) || (d.status === "cancelled" && !!d.superseded_by);

/** The words a superseded deploy is closed with. */
export const supersededNote = (by: string) => `superseded by ${by}, never reported live`;

/**
 * The open deploys of a live deploy's target asked for before it: a newer deploy went live, so they never will as
 * asked. Closed as cancelled, naming the deploy that superseded them (unless `dry`); returned either way.
 */
export async function closeSuperseded(ctx: any, live: Doc<"deploys">, opts: { dry?: boolean; now?: number } = {}): Promise<Doc<"deploys">[]> {
  if (live.status !== "live") return [];
  const before: Doc<"deploys">[] = await ctx.db
    .query("deploys")
    .withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", live.workspace).eq("target", live.target).lt("created_at", live.created_at))
    .order("desc")
    .take(200);
  const stale = before.filter((d) => OPEN.has(d.status) && (!d.repository || !live.repository || d.repository === live.repository));
  if (!opts.dry) {
    const now = opts.now ?? Date.now();
    for (const d of stale) {
      await ctx.db.patch(d._id, { status: "cancelled", superseded_by: live.short_id, finished_at: now, updated_at: now, note: [supersededNote(live.short_id), d.note].filter(Boolean).join("\n") });
    }
  }
  return stale;
}

/** A deploy's url, with the Actions run it names stamped beside it. */
export function urlFields(url: string): Pick<Doc<"deploys">, "url" | "workflow_run"> {
  const run = actionsRunKey(url);
  return { url, ...(run ? { workflow_run: run } : {}) };
}

/** The deploys an Actions run carried (one per target that runs it; normally one). */
export async function deploysOfRun(ctx: any, run: string): Promise<Doc<"deploys">[]> {
  return await ctx.db.query("deploys").withIndex("by_workflow_run", (q: any) => q.eq("workflow_run", run)).take(10);
}

/** A deploy by its dp-N or its id. */
export async function deployByRef(ctx: any, ref: string): Promise<Doc<"deploys"> | null> {
  if (DEPLOY_SHORT_ID_RE.test(ref)) return await ctx.db.query("deploys").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.toLowerCase())).first();
  const id = ctx.db.normalizeId("deploys", ref);
  return id ? await ctx.db.get(id) : null;
}
