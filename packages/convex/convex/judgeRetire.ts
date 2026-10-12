// What a newer judging of the same moment does to a judge's earlier findings
// (docs/architecture/learning-loop.md LL8). When a moment is judged again (a
// later judge version, a moment re-read with its window), the judge's earlier
// findings on it that the new run did not find again leave their problems: a
// board keeps only what the current judge stands behind. A problem left with
// no findings, and no run working it, closes with a note saying why. A
// finding it did find again takes the newer judge's words, so the board reads
// the way the current judge writes.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { findingKey, findingSignal, type JudgeFinding } from "@codecast/shared/contracts/judges";
import { reembedFinding } from "./findingGroups";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { refreshCauseDescription } from "./signals";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

/** Problem statuses a run is working or has finished: those keep their state and only lose the finding. */
const WORKED = new Set(["in_progress", "in_review", "done", "dropped"]);

/**
 * Retire the findings earlier runs of this judge filed from this moment, all
 * but those whose key the new run found again (`keep`). Only findings under
 * an expectation the new run was shown (`shown`) can be found again: one whose
 * judge no longer grades that expectation was not looked for, and stays.
 */
export const retireSuperseded = internalMutation({
  args: { moment_id: v.id("moments"), judge: v.string(), judge_version: v.string(), keep: v.array(v.string()), shown: v.array(v.string()), before: v.number(), actor: v.id("users") },
  handler: async (ctx, args) => {
    const runs = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", args.moment_id)).collect())
      .filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.at < args.before && r.signal_ids?.length);
    const keep = new Set(args.keep);
    const shown = new Set(args.shown);
    const ids = [...new Set(runs.flatMap((r: Doc<"judge_runs">) => (r.signal_ids ?? []).map(String)))] as Id<"signals">[];
    const rows = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
      (s): s is Doc<"signals"> => !!s && !s.retired && !keep.has(s.fingerprint) && !!s.subject && shown.has(s.subject),
    );
    return await retireSignals(ctx, rows, {
      reason: `judged again by ${args.judge} ${args.judge_version.slice(0, 8)}, which did not find it`,
      judge_version: args.judge_version,
      actor: args.actor,
    });
  },
});

const refoundArgs = v.object({ key: v.string(), title: v.string(), detail_md: v.optional(v.string()), severity: v.optional(v.number()) });

/**
 * The findings a live judge's run found again, by evidence key. Each key's
 * live row written by an earlier version of the same judge takes this run's
 * title, detail, severity and version, keeping its problem; a problem titled
 * by that finding's old words takes the new ones. A row an earlier version
 * retired as not found again comes back to its problem while that problem is
 * open. A row another judge wrote keeps its words: two judges read one message,
 * and the first to file it keeps it.
 *
 * Returns the keys that now have a live row (the run files no second copy of
 * those) and the rows that took new words (to be embedded again, and listed
 * on the run as this judge's).
 */
export const refound = internalMutation({
  args: { workspace: v.string(), judge: v.string(), judge_version: v.string(), rows: v.array(refoundArgs) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const live: string[] = [];
    const updated: Array<{ signal_id: Id<"signals">; key: string; revived: boolean }> = [];
    for (const r of args.rows) {
      const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).eq("fingerprint", r.key)).take(20);
      const current = rows.filter((s) => !s.retired);
      let mine = current.filter((s) => s.judge === args.judge && s.judge_version !== args.judge_version);
      let revived = false;
      if (!current.length) {
        const back = await revivable(ctx, rows, args.judge);
        if (!back) continue;
        await ctx.db.patch(back.row._id, { retired: undefined, task_id: back.task._id });
        await recount(ctx, back.task, r.key, now);
        mine = [{ ...back.row, task_id: back.task._id }];
        revived = true;
      }
      live.push(r.key);
      for (const row of mine) {
        await ctx.db.patch(row._id, { title: r.title, detail_md: r.detail_md, ...(r.severity !== undefined ? { severity: r.severity } : {}), judge_version: args.judge_version });
        const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
        if (task && task.title === row.title && task.title !== r.title) await ctx.db.patch(task._id, { title: r.title, updated_at: now });
        updated.push({ signal_id: row._id, key: r.key, revived });
      }
    }
    return { live, updated };
  },
});

/** A judge's finding a ruling marked wrong, as the next finding on its message is compared with it. */
export type Ruling = { key: string; short_id: string; quote: string };

/** The words a finding quoted, from its detail's quote lines. */
export const quoteOfDetail = (detail?: string) => (detail ?? "").split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").trim();

/**
 * The rulings standing against findings under these key scopes: each judge
 * finding marked wrong (judge_review) whose diagnosis did not uphold it. A
 * scope is an evidence key without its message (`evidence:<who>:<expectation>:`),
 * so every message of that contact under that expectation is read, whichever
 * judge, judge version or moment kind filed it; any other key is its own scope.
 */
export const rulings = internalQuery({
  args: { workspace: v.string(), scopes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Ruling[]> => {
    const out: Ruling[] = [];
    for (const scope of new Set(args.scopes)) {
      const rows: Doc<"signals">[] = await ctx.db.query("signals")
        .withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).gte("fingerprint", scope).lt("fingerprint", `${scope}￿`))
        .take(200);
      for (const s of rows) {
        if (!s.judge || s.case_of || !s.judge_review || s.judge_review.answer === "upheld") continue;
        if (!scope.endsWith(":") && s.fingerprint !== scope) continue;
        out.push({ key: s.fingerprint, short_id: s.short_id, quote: quoteOfDetail(s.detail_md) });
      }
    }
    return out;
  },
});

/**
 * A judge found again what a ruling already marked wrong (rulings): the
 * finding files nothing, and any live finding under its key leaves its
 * problem naming the ruling, so a problem holding only known judge errors
 * empties and drops (retireSignals). The ruled finding's case on its judge's
 * problem is where the error is worked.
 */
export const retireRuled = internalMutation({
  args: { workspace: v.string(), bound: v.array(v.object({ key: v.string(), ruling: v.string() })), actor: v.id("users") },
  handler: async (ctx, args) => {
    const out: Array<{ key: string; retired: string[]; closed: string[] }> = [];
    for (const b of args.bound) {
      const rows: Doc<"signals">[] = (await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).eq("fingerprint", b.key)).take(50))
        .filter((s: Doc<"signals">) => s.judge && !s.retired && !s.case_of && !s.judge_review);
      if (!rows.length) continue;
      const r = await retireSignals(ctx, rows, { reason: `found wrong earlier as ${b.ruling}: a ruling stands against this message under this expectation`, actor: args.actor });
      out.push({ key: b.key, retired: rows.map((s) => s.short_id), closed: r.closed });
    }
    return out;
  },
});

/** A row this judge retired as not found again, whose problem is still open. */
async function revivable(ctx: any, rows: Doc<"signals">[], judge: string): Promise<{ row: Doc<"signals">; task: Doc<"tasks"> } | null> {
  for (const row of rows.sort((a, b) => a.created_at - b.created_at)) {
    if (row.judge !== judge || !row.retired?.task_id || !row.retired.reason.startsWith(`judged again by ${judge} `)) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(row.retired.task_id);
    if (task?.cause && !isTerminalTaskStatus(task.status)) return { row, task };
  }
  return null;
}

/** A problem that took a finding back: its count from the findings it holds, and the finding's key. */
async function recount(ctx: any, task: Doc<"tasks">, key: string, now: number) {
  const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const keys = task.cause!.fingerprints;
  await ctx.db.patch(task._id, { cause: { ...task.cause!, signal_count: held.length, fingerprints: keys.includes(key) || keys.length >= 50 ? keys : [...keys, key] }, updated_at: now });
}

/**
 * Once: a project's live findings that an earlier version of their judge
 * wrote, from before a re-found key took the newer judge's words. Each takes
 * the words its moment's latest run of that judge wrote for it, through
 * `refound`, and is embedded again. That run left the row live, so it found
 * the row's key again under the row's expectation: the run's one finding of
 * that expectation, or among several the one quoting the same words. A row
 * with no such finding is left as it is and listed.
 */
export const backfillRefound = internalAction({
  args: { project_id: v.id("projects"), dry_run: v.boolean() },
  handler: async (ctx, args): Promise<{ checked: number; stale: number; updated: string[]; embedded: number; unmatched: string[] }> => {
    const plan: { workspace: string; team_id?: Id<"teams">; checked: number; rows: Array<{ short_id: string; signal_id: Id<"signals">; judge: string; judge_version: string; key: string; expectation: string; quote: string; moment: string; findings_json: string | null }> } =
      await ctx.runQuery(internal.judgeRetire.refoundPlan, { project_id: args.project_id });
    const scope = { workspace: plan.workspace, ...(plan.team_id ? { team_id: plan.team_id } : {}) };
    const updated: string[] = [];
    const unmatched: string[] = [];
    let embedded = 0;
    for (const r of plan.rows) {
      const findings: JudgeFinding[] = r.findings_json ? JSON.parse(r.findings_json) : [];
      const finding = sameFinding(findings.filter((f) => f.expectation === r.expectation), r.quote);
      if (!finding) { unmatched.push(r.short_id); continue; }
      const s = findingSignal(finding, { judge: r.judge, judge_version: r.judge_version, moment: r.moment });
      if (args.dry_run) { updated.push(`${r.short_id}: ${s.title}`); continue; }
      const out: { updated: Array<{ signal_id: Id<"signals"> }> } = await ctx.runMutation(internal.judgeRetire.refound, {
        workspace: plan.workspace,
        judge: r.judge,
        judge_version: r.judge_version,
        rows: [{ key: r.key, title: s.title, ...(s.detail_md ? { detail_md: s.detail_md } : {}), ...(typeof s.severity === "number" ? { severity: s.severity } : {}) }],
      });
      for (const u of out.updated) {
        updated.push(r.short_id);
        if (await reembedFinding(ctx, scope, { signal_id: u.signal_id, subject: s.subject, text: s.similar_text })) embedded++;
      }
    }
    return { checked: plan.checked, stale: plan.rows.length, updated, embedded, unmatched };
  },
});

const fold = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The one candidate, or among several the one whose quote shares the row's opening words. */
function sameFinding(candidates: JudgeFinding[], quote: string): JudgeFinding | null {
  if (candidates.length <= 1) return candidates[0] ?? null;
  const q = fold(quote).slice(0, 40);
  return candidates.find((f) => q && (fold(f.quote).includes(q) || q.includes(fold(f.quote).slice(0, 40)))) ?? null;
}

/** The project's live judge findings whose moment has a later run of their judge at another version, with that run's findings. */
export const refoundPlan = internalQuery({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const project = (await ctx.db.get(args.project_id))!;
    const live = (await ctx.db.query("signals").withIndex("by_project_created", (q: any) => q.eq("project_id", args.project_id)).collect())
      .filter((s: Doc<"signals">) => !s.retired && s.judge && s.judge_version && s.moment && s.subject);
    const rows = [];
    for (const s of live) {
      const moment = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", s.moment)).first();
      if (!moment) continue;
      const runs = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", moment._id)).collect())
        .filter((r: Doc<"judge_runs">) => r.judge === s.judge && r.status === "ok");
      const latest = runs.sort((a: Doc<"judge_runs">, b: Doc<"judge_runs">) => b.at - a.at)[0];
      if (!latest || latest.judge_version === s.judge_version) continue;
      const quote = quoteOfDetail(s.detail_md);
      rows.push({ short_id: s.short_id, signal_id: s._id, judge: s.judge!, judge_version: latest.judge_version, key: s.fingerprint, expectation: s.subject!, quote, moment: s.moment!, findings_json: latest.findings_json ?? null });
    }
    return { workspace: project.workspace!, ...(project.team_id ? { team_id: project.team_id } : {}), checked: live.length, rows };
  },
});

export async function retireSignals(ctx: any, rows: Doc<"signals">[], o: { reason: string; judge_version?: string; actor: Id<"users"> }) {
  const now = Date.now();
  const byTask = new Map<string, Doc<"signals">[]>();
  for (const row of rows) {
    await ctx.db.patch(row._id, {
      task_id: undefined,
      retired: { at: now, reason: o.reason, ...(row.task_id ? { task_id: row.task_id } : {}), ...(o.judge_version ? { judge_version: o.judge_version } : {}) },
    });
    if (row.task_id) byTask.set(String(row.task_id), [...(byTask.get(String(row.task_id)) ?? []), row]);
  }
  const closed: string[] = [];
  for (const [taskId, gone] of byTask) {
    const task: Doc<"tasks"> | null = await ctx.db.get(taskId as Id<"tasks">);
    if (!task?.cause) continue;
    const left: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
    const keys = new Set(left.map((s) => s.fingerprint));
    await ctx.db.patch(task._id, {
      cause: { ...task.cause, signal_count: left.length, fingerprints: task.cause.fingerprints.filter((k) => keys.has(k) || !gone.some((g) => g.fingerprint === k)) },
      updated_at: now,
    });
    if (left.length) await refreshCauseDescription(ctx, task._id, gone);
    const what = gone.length === 1 ? "1 finding" : `${gone.length} findings`;
    if (left.length === 0 && !WORKED.has(task.status)) {
      await moveTaskStatus(ctx, (await ctx.db.get(task._id))!, "dropped", { actorUserId: o.actor, actorType: "system", now });
      await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Closed: its ${what} were judged again and none held (${o.reason}).` });
      closed.push(task.short_id);
    }
  }
  return { retired: rows.length, problems: byTask.size, closed };
}
