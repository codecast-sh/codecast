// Permanent deletion for teams whose managed policy marks their data as
// regulated (regulated_data, HIPAA). There is no retention window: data goes
// when someone asks, and all of it goes at contract end (the BAA's
// destroy-at-termination step). Backups age out on their own 14-day rotation
// (infra/pg-backup/backup.sh).
//
//   - one session: its owner or a team admin (sessionDelete.deleteSession routes here)
//   - one published page: its owner or a team admin (artifacts.deleteForWeb / deleteFromCLI)
//   - one call, with its recordings and transcript: a team admin (deleteCall)
//   - the whole team: a team admin who types its name (destroyTeam)
//
// Every delete is a data_deletions row and runs as a chain of scheduled
// passes (runDeletion), each a bounded walk of the purge trees in
// lib/deletionPlans.ts. The row holds what remains and the rows deleted per
// table, so it is both the job's progress and the record of the delete; each
// one is also written to the team's access log (lib/accessLog).
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { accessError } from "@platform/auth/convex";
import { internalMutation, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isTeamAdmin } from "./privacy";
import { isRegulatedTeam, recordAccess } from "./lib/accessLog";
import { purgeChildren, purgeRange, purgeRow, type PurgeBudget, type PurgeCounts, type PurgeOutcome } from "./lib/purgeTree";
import { artifactPlan, callPlan, conversationRowPlan, teamDeletionSteps } from "./lib/deletionPlans";
import { isRecordingActive } from "@codecast/shared/contracts";
import { retireTeam } from "./teams";

type Kind = Doc<"data_deletions">["kind"];
type Root = Doc<"data_deletions">["roots"][number];

/** Units one pass may spend (lib/purgeTree): far under the per-function read and time caps. */
export const DELETION_PASS_BUDGET = 1000;
/** A call still being filmed is looked at again after this long. */
const WAIT_RETRY_MS = 5 * 60_000;
/** A running delete untouched this long lost its chain (a pass threw); the cron starts a new one. */
export const DELETION_STALL_MS = 15 * 60_000;

const KIND_TABLE: Record<Kind, string> = { session: "conversations", page: "artifacts", call: "transcripts", team: "teams" };

const refuse = (message: string): never => { throw accessError("FORBIDDEN", message); };

/** A live, regulated team the user administers; refuses otherwise. */
async function regulatedTeamAdmin(ctx: any, userId: Id<"users">, teamId: Id<"teams"> | null | undefined): Promise<Doc<"teams">> {
  const team = teamId ? await ctx.db.get(teamId) : null;
  if (!team || team.deleted_at) refuse("Team not found");
  if (!(await isRegulatedTeam(ctx, teamId))) refuse("Permanent deletion is for teams that hold regulated data");
  if (!(await isTeamAdmin(ctx, userId, teamId!))) refuse("Only a team admin can permanently delete the team's data");
  return team;
}

/** Whether `userId` may permanently delete an object `ownerId` owns in regulated team `teamId`: its owner or a team admin. */
export async function mayDeleteRegulated(ctx: any, userId: Id<"users">, ownerId: Id<"users">, teamId: Id<"teams">): Promise<boolean> {
  return userId === ownerId || (await isTeamAdmin(ctx, userId, teamId));
}

/** Record a delete and start its passes. The caller has checked who may. */
export async function startDeletion(
  ctx: any,
  d: { team: { _id: Id<"teams">; name: string }; actorId: Id<"users">; kind: Kind; targetId: string; targetLabel?: string; shortId?: string; roots: Root[] },
): Promise<Id<"data_deletions">> {
  const now = Date.now();
  // Logged first: the access log only writes for a live regulated team, and a
  // team's delete tombstones it right after this.
  await recordAccess(ctx, d.team._id, {
    actor: { userId: d.actorId },
    action: "delete",
    object: { table: KIND_TABLE[d.kind], id: d.targetId, shortId: d.shortId },
    client: "web",
    detail: d.targetLabel ? `requested: ${d.targetLabel}` : "requested",
  });
  const id = await ctx.db.insert("data_deletions", {
    team_id: d.team._id,
    team_name: d.team.name,
    actor_user_id: d.actorId,
    kind: d.kind,
    target_id: d.targetId,
    ...(d.targetLabel ? { target_label: d.targetLabel.slice(0, 200) } : {}),
    status: "running",
    roots: d.roots,
    counts: {},
    passes: 0,
    gen: 0,
    requested_at: now,
    updated_at: now,
  });
  await ctx.scheduler.runAfter(0, internal.regulatedDeletion.runDeletion, { deletion_id: id, gen: 0 });
  return id;
}

/** One root's walk; `root.step` advances through a team's steps. */
async function runRoot(ctx: any, root: Root, budget: PurgeBudget, counts: PurgeCounts): Promise<PurgeOutcome> {
  if (root.plan === "conversation") return purgeChildren(ctx, conversationRowPlan(), { _id: root.id }, budget, counts);
  if (root.plan === "artifact" || root.plan === "call") {
    const row = await ctx.db.get(root.id);
    if (!row) return "done";
    return purgeRow(ctx, root.plan === "artifact" ? artifactPlan() : callPlan(), row, budget, counts);
  }
  const steps = teamDeletionSteps();
  const team = { _id: root.id };
  for (let i = root.step ?? 0; i < steps.length; i++) {
    const out = await purgeRange(ctx, steps[i], team, budget, counts);
    if (out !== "done") return out;
    root.step = i + 1;
  }
  const row = await ctx.db.get(root.id);
  if (row) {
    await ctx.db.delete(row._id);
    counts.teams = (counts.teams ?? 0) + 1;
  }
  return "done";
}

export function summarizeCounts(counts: PurgeCounts): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([table, n]) => `${table} ${n}`)
    .join(", ");
}

/** One pass of a delete: walk what remains within the budget, record it, and schedule the next. */
export const runDeletion = internalMutation({
  args: { deletion_id: v.id("data_deletions"), gen: v.number() },
  handler: async (ctx, args): Promise<{ done: boolean }> => {
    const d = await ctx.db.get(args.deletion_id);
    if (!d || d.status !== "running" || d.gen !== args.gen) return { done: true };
    const budget = { left: DELETION_PASS_BUDGET };
    const counts: PurgeCounts = { ...d.counts };
    const roots: Root[] = d.roots.map((r) => ({ ...r }));
    let outcome: PurgeOutcome = "done";
    while (roots.length) {
      outcome = await runRoot(ctx, roots[0], budget, counts);
      if (outcome !== "done") break;
      roots.shift();
    }
    const now = Date.now();
    const done = roots.length === 0;
    await ctx.db.patch(d._id, {
      roots,
      counts,
      passes: d.passes + 1,
      updated_at: now,
      ...(done ? { status: "done" as const, finished_at: now } : {}),
    });
    if (!done) {
      await ctx.scheduler.runAfter(outcome === "wait" ? WAIT_RETRY_MS : 0, internal.regulatedDeletion.runDeletion, args);
    } else if (d.kind !== "team") {
      await recordAccess(ctx, d.team_id, {
        actor: { userId: d.actor_user_id },
        action: "delete",
        object: { table: KIND_TABLE[d.kind], id: d.target_id },
        client: "web",
        detail: `deleted: ${summarizeCounts(counts)}`,
      });
    }
    return { done };
  },
});

/** Restart deletes whose chain stopped (a pass threw): each resumes from its recorded roots. */
export const resumeStalledDeletions = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ resumed: number }> => {
    const now = Date.now();
    const stalled = await ctx.db
      .query("data_deletions")
      .withIndex("by_status_updated", (q) => q.eq("status", "running").lt("updated_at", now - DELETION_STALL_MS))
      .take(25);
    for (const d of stalled) {
      const gen = d.gen + 1;
      await ctx.db.patch(d._id, { gen, updated_at: now });
      await ctx.scheduler.runAfter(0, internal.regulatedDeletion.runDeletion, { deletion_id: d._id, gen });
    }
    return { resumed: stalled.length };
  },
});

/** A team admin permanently deletes one call: its recordings, transcript and record. */
export const deleteCall = mutation({
  args: { transcript_id: v.id("transcripts") },
  handler: async (ctx, args): Promise<{ deletion_id: Id<"data_deletions"> }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const call = await ctx.db.get(args.transcript_id);
    if (!call) refuse("Call not found");
    const team = await regulatedTeamAdmin(ctx, userId, call!.team_id);
    if (call!.status === "live") refuse("End the call before deleting it");
    const recordings = await ctx.db
      .query("call_recordings")
      .withIndex("by_transcript", (q) => q.eq("transcript_id", call!._id))
      .collect();
    if (recordings.some((r) => isRecordingActive(r.status))) refuse("Stop the recording before deleting the call");
    const deletion_id = await startDeletion(ctx, {
      team, actorId: userId, kind: "call", targetId: String(call!._id), targetLabel: call!.title ?? undefined,
      roots: [{ plan: "call", id: String(call!._id) }],
    });
    return { deletion_id };
  },
});

/** The most of each kind the destroy review counts; more reads as "N+". */
export const DESTROY_PREVIEW_CAP = 250;

/** What a whole-team delete would remove, for its review: capped counts of the team's content. */
export const destroyPreview = query({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const team = await ctx.db.get(args.team_id);
    if (!team || team.deleted_at || !(await isRegulatedTeam(ctx, team._id)) || !(await isTeamAdmin(ctx, userId, team._id))) return null;
    const cap = DESTROY_PREVIEW_CAP + 1;
    const count = async (table: "conversations" | "transcripts" | "tasks" | "docs" | "plans" | "team_memberships", index: string) => {
      const rows = await (ctx.db as any).query(table).withIndex(index, (q: any) => q.eq("team_id", team._id)).take(cap);
      return { n: Math.min(rows.length, DESTROY_PREVIEW_CAP), more: rows.length > DESTROY_PREVIEW_CAP };
    };
    return {
      team_name: team.name,
      sessions: await count("conversations", "by_team_id"),
      calls: await count("transcripts", "by_team_started"),
      tasks: await count("tasks", "by_team_id"),
      docs: await count("docs", "by_team_id"),
      plans: await count("plans", "by_team_id"),
      members: await count("team_memberships", "by_team_id"),
    };
  },
});

/**
 * A team admin permanently deletes the team and all of its data: the BAA's
 * destroy-at-termination step. The caller types the team's name and the
 * server checks it. The team is retired at once (every member loses access,
 * its agents stop, recordings stop), then its data goes in passes; unlike a
 * plain team delete, it can never be restored (teams.restoreTeam refuses).
 */
export const destroyTeam = mutation({
  args: { team_id: v.id("teams"), confirm_name: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const team = await regulatedTeamAdmin(ctx, userId, args.team_id);
    if (args.confirm_name.trim() !== team.name.trim()) refuse("Type the team name exactly to confirm");
    const deletion_id = await startDeletion(ctx, {
      team, actorId: userId, kind: "team", targetId: String(team._id), targetLabel: team.name,
      roots: [{ plan: "team", id: String(team._id) }],
    });
    await retireTeam(ctx, team, userId);
    const me = await ctx.db.get(userId);
    return { deleted: true as const, deletion_id, name: team.name, active_team_id: me?.active_team_id ?? null };
  },
});
