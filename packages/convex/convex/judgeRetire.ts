// What a newer judging of the same moment does to a judge's earlier findings
// (docs/architecture/learning-loop.md LL8). When a moment is judged again (a
// later judge version, a moment re-read with its window), the judge's earlier
// findings on it that the new run did not find again leave their problems: a
// board keeps only what the current judge stands behind. A problem left with
// no findings, and no run working it, closes with a note saying why. A
// finding it did find again takes the newer judge's words, so the board reads
// the way the current judge writes.
import { withdrawCore } from "./sessionDecisions";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import { findingKey, findingSignal, type JudgeFinding } from "@codecast/shared/contracts/judges";
import { BEFORE_LINE, CLOSED_WITH, reembedFinding, standsAsEvidence } from "./findingGroups";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { refreshCauseDescription } from "./signals";
import { latestExpectations } from "./lib/expectationsApply";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { judgeInputs } from "./momentsSchema";
import { fold, findingStanding, type StandingRun } from "./lib/findingStanding";
export { findingStanding, quotesOverlap, type StandingRun } from "./lib/findingStanding";

/** Problem statuses a run is working or has finished: those keep their state and only lose the finding. */
const WORKED = new Set(["in_progress", "in_review", "done", "dropped"]);

/**
 * How many reads of an unchanged judge, on an unchanged reading of the moment,
 * must miss a finding before it leaves: at least k of the last n reads (this
 * one included). A judge is a sampled model call, so one read that does not
 * find a finding another read of the same version filed is noise, not news.
 */
export const ABSENT_OF = { k: 2, n: 3 } as const;

/**
 * What a judge run on a moment leaves standing (LL8). Every finding the run
 * files, re-finds or revives (`held`) counts this moment among the moments
 * whose newest run of the judge files it (held_by). A finding an earlier run
 * of this judge on this moment filed and this run did not find again drops
 * this moment; it leaves its problem only when no moment is left, so a message
 * shown in several moments (a contact's conversation and a match of it) stays
 * while any of their newest runs still files it, and leaves when the last one
 * lets it go. Only findings under an expectation the run was shown (`shown`)
 * can be let go: one whose judge no longer grades that expectation was not
 * looked for, and stays. A line left out because it came into force after the
 * moment (`later`, judges.briefAt) was looked at and did not apply: what was
 * filed under it from this moment leaves as history. A row from before
 * held_by was kept counts only this moment. A miss counts against a finding
 * at once only when what decides it changed (absence); a miss by the same
 * judge on the same reading is one sample, and the moment keeps standing
 * behind the finding until ABSENT_OF says the misses outweigh the find.
 */
export const settleRun = internalMutation({
  args: {
    moment_id: v.id("moments"), moment: v.string(), judge: v.string(), judge_version: v.string(), held: v.array(v.id("signals")), keep: v.array(v.string()), shown: v.array(v.string()), later: v.optional(v.array(v.string())), before: v.number(), actor: v.id("users"),
    /** What this run read (judgeInputs): a finding's absence means something only against what the run that found it read. */
    inputs: v.optional(judgeInputs),
    /** Lines whose facts the re-read changed (a re-judge scoped to them, `--lines`): one absence lets their findings go. */
    fresh: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const held = new Set(args.held.map(String));
    for (const id of args.held) {
      const row: Doc<"signals"> | null = await ctx.db.get(id);
      if (!row || row.retired) continue;
      const by = row.held_by ?? [];
      if (!by.includes(args.moment)) await ctx.db.patch(id, { held_by: [...by, args.moment] });
    }
    const all: Doc<"judge_runs">[] = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", args.moment_id)).collect())
      .filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.status === "ok" && r.at < args.before)
      .sort((a: Doc<"judge_runs">, b: Doc<"judge_runs">) => a.at - b.at);
    const runs = all.filter((r) => r.signal_ids?.length || r.held_ids?.length);
    const keep = new Set(args.keep);
    const later = new Set(args.later ?? []);
    const shown = new Set([...args.shown, ...later]);
    const ids = [...new Set(runs.flatMap((r: Doc<"judge_runs">) => [...(r.signal_ids ?? []), ...(r.held_ids ?? [])].map(String)))].filter((id) => !held.has(id)) as Id<"signals">[];
    const rows = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
      (s): s is Doc<"signals"> => !!s && !s.retired && !keep.has(s.fingerprint) && !!s.subject && shown.has(s.subject),
    );
    const fresh = new Set(args.fresh ?? []);
    const gone: Doc<"signals">[] = [];
    const resampled: Doc<"signals">[] = [];
    const early: Doc<"signals">[] = [];
    for (const row of rows) {
      const isLater = later.has(row.subject!);
      const absent = isLater ? "changed" : await absence(ctx, row, all, args, fresh.has(row.subject!));
      // A single resample of the same judge on the same reading: this moment still stands behind it.
      if (absent === "unsettled") continue;
      const by = (row.held_by ?? [args.moment]).filter((m) => m !== args.moment);
      await ctx.db.patch(row._id, { held_by: by });
      if (!by.length) (isLater ? early : absent === "changed" ? gone : resampled).push(row);
    }
    const judged = { judge_version: args.judge_version, actor: args.actor };
    const who = `${args.judge} ${args.judge_version.slice(0, 8)}`;
    const a = await retireSignals(ctx, gone, { reason: `judged again by ${who}, which did not find it`, ...judged });
    const c = await retireSignals(ctx, resampled, { reason: `judged again by ${who}, which did not find it in ${ABSENT_OF.k} of its last ${ABSENT_OF.n} reads`, ...judged });
    const b = await retireSignals(ctx, early, { reason: `${BEFORE_LINE} ${who} no longer grades this moment against it`, ...judged });
    return { retired: a.retired + b.retired + c.retired, problems: a.problems + b.problems + c.problems, closed: [...a.closed, ...b.closed, ...c.closed] };
  },
});

/** Whether a run found the row: it filed it, stood behind it, or found its key before a second read let it file (waiting). */
const foundIn = (r: Doc<"judge_runs">, row: Pick<Doc<"signals">, "_id" | "fingerprint">) =>
  [...(r.signal_ids ?? []), ...(r.held_ids ?? [])].some((s) => String(s) === String(row._id)) || !!r.waiting?.includes(row.fingerprint);

/**
 * Why this run's miss lets a finding go, or that it does not yet. "changed":
 * the judge version, the finding's line, the messages it read, or (named by a
 * scoped re-judge) the facts its line reads changed since the read that last
 * found it, so the miss is the current judge's answer on what it reads now.
 * Otherwise the miss is a resample: "resampled" once ABSENT_OF.k of the last
 * ABSENT_OF.n reads missed it, else "unsettled". A run from before inputs were
 * kept compares as unchanged, so old reads count as samples, never as change.
 */
async function absence(
  ctx: any, row: Doc<"signals">, runs: Doc<"judge_runs">[],
  args: { judge_version: string; inputs?: { messages: string; facts: string } }, fresh: boolean,
): Promise<"changed" | "resampled" | "unsettled"> {
  if (fresh || row.judge_version !== args.judge_version) return "changed";
  if ((await expectationChangedAt(ctx, row.project_id, row.subject)) > row.created_at) return "changed";
  const sameReading = (r: Doc<"judge_runs">) => !r.inputs || !args.inputs || r.inputs.messages === args.inputs.messages;
  const lastFound = [...runs].reverse().find((r) => foundIn(r, row));
  if (lastFound && !sameReading(lastFound)) return "changed";
  const samples = [...runs.filter((r) => r.judge_version === args.judge_version && sameReading(r)).map((r) => foundIn(r, row)), false].slice(-ABSENT_OF.n);
  return samples.filter((found) => !found).length >= ABSENT_OF.k ? "resampled" : "unsettled";
}

/**
 * The file side of the same rule: this judge version's earlier reads of the
 * moment on the messages this run read, oldest first, each with what it found,
 * and when each line's words last changed. momentJudging.fileFindings weighs a
 * finding none of them made against them (newOnResample).
 */
export const sameReads = internalQuery({
  args: { moment_id: v.id("moments"), judge: v.string(), judge_version: v.string(), messages: v.string(), lines: v.array(v.object({ id: v.string(), project_id: v.id("projects") })) },
  handler: async (ctx, args): Promise<{ reads: Array<{ at: number; findings: JudgeFinding[] }>; changed: Record<string, number> }> => {
    const runs: Doc<"judge_runs">[] = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", args.moment_id)).collect())
      .filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.status === "ok" && r.judge_version === args.judge_version && r.inputs?.messages === args.messages)
      .sort((a: Doc<"judge_runs">, b: Doc<"judge_runs">) => a.at - b.at);
    const changed: Record<string, number> = {};
    for (const l of args.lines) changed[l.id] = await expectationChangedAt(ctx, l.project_id, l.id);
    return { reads: runs.map((r) => ({ at: r.at, findings: r.findings_json ? JSON.parse(r.findings_json) : [] })), changed };
  },
});

/**
 * Whether a finding this read made is one sample against earlier reads of the
 * same judge version on the same messages under the same words (`earlier`:
 * whether each found it, oldest first). With no such read it is the judge's
 * first answer and files. Otherwise it files once ABSENT_OF.k of the last
 * ABSENT_OF.n reads, this one included, found it; until then it waits on its
 * run, so one resample neither lets a held finding go nor files a new one.
 */
export function newOnResample(earlier: boolean[]): boolean {
  if (!earlier.length) return false;
  return [...earlier, true].slice(-ABSENT_OF.n).filter(Boolean).length < ABSENT_OF.k;
}

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
 * on the run as this judge's), and `waiting`: the `once` keys with no live
 * row, which this run does not file.
 */
export const refound = internalMutation({
  args: {
    workspace: v.string(), judge: v.string(), judge_version: v.string(), rows: v.array(refoundArgs),
    /** Keys only this one resample found (newOnResample): one with no live row is neither revived nor filed. */
    once: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const once = new Set(args.once ?? []);
    const waiting: string[] = [];
    const live: string[] = [];
    const updated: Array<{ signal_id: Id<"signals">; key: string; revived: boolean }> = [];
    // Rows of this judge's current version found again: unchanged, but this run stands behind them too.
    const held: Id<"signals">[] = [];
    for (const r of args.rows) {
      const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).eq("fingerprint", r.key)).take(20);
      const current = rows.filter((s) => !s.retired);
      let mine = current.filter((s) => s.judge === args.judge && s.judge_version !== args.judge_version);
      let revived = false;
      if (!current.length && once.has(r.key)) { waiting.push(r.key); continue; }
      if (!current.length) {
        // Retired when a line closed its problem: found again, it is still that problem's history, never a fresh copy.
        if (rows.some((s) => CLOSED_WITH.test(s.retired?.reason ?? ""))) { live.push(r.key); continue; }
        const back = await revivable(ctx, rows, args.judge);
        if (!back) continue;
        await ctx.db.patch(back.row._id, { retired: undefined, task_id: back.task._id, held_by: [] });
        await recount(ctx, back.task, r.key, now);
        mine = [{ ...back.row, task_id: back.task._id }];
        revived = true;
      }
      live.push(r.key);
      held.push(...current.filter((s) => s.judge === args.judge && s.judge_version === args.judge_version).map((s) => s._id));
      for (const row of mine) {
        await ctx.db.patch(row._id, { title: r.title, detail_md: r.detail_md, ...(r.severity !== undefined ? { severity: r.severity } : {}), judge_version: args.judge_version });
        const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
        if (task && task.title === row.title && task.title !== r.title) await ctx.db.patch(task._id, { title: r.title, updated_at: now });
        updated.push({ signal_id: row._id, key: r.key, revived });
      }
    }
    return { live, updated, held, ...(waiting.length ? { waiting } : {}) };
  },
});

/**
 * A judge's finding a ruling marked wrong, as the next finding on its message
 * is compared with it: its key, the line it was filed under, the words it
 * quoted, and what a correct judgment of that message does (empty while the
 * ruling has no words yet).
 */
export type Ruling = { key: string; short_id: string; expectation: string; quote: string; ruling: string };

/** The words a finding quoted, from its detail's quote lines. */
export const quoteOfDetail = (detail?: string) => (detail ?? "").split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").trim();

/**
 * The rulings standing against findings under these key scopes: each judge
 * finding marked wrong (judge_review) whose diagnosis did not uphold it,
 * filed against the expectation's current words. A scope is an evidence key
 * without its message (`evidence:<who>:<expectation>:`), so every message of
 * that contact under that expectation is read, whichever judge, judge version
 * or moment kind filed it; or a person's whole prefix (`evidence:<who>:`,
 * judges.evidenceScopes), so every ruling on their messages under any line is
 * read; any other key is its own scope. A ruling on a
 * finding filed before its line last changed judged words that are gone (a
 * stale line is a common reason a finding is wrong), so it binds nothing.
 */
export const rulings = internalQuery({
  args: { workspace: v.string(), scopes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Ruling[]> => readRulings(ctx, args.workspace, args.scopes),
});

export async function readRulings(ctx: any, workspace: string, scopes: string[]): Promise<Ruling[]> {
  const out: Ruling[] = [];
  const changedAt = new Map<string, number>();
  const lineChangedAt = async (s: Doc<"signals">): Promise<number> => {
    const k = `${s.project_id}|${s.subject}`;
    if (!changedAt.has(k)) changedAt.set(k, await expectationChangedAt(ctx, s.project_id, s.subject));
    return changedAt.get(k)!;
  };
  for (const scope of new Set(scopes)) {
    const rows: Doc<"signals">[] = await ctx.db.query("signals")
      .withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", workspace).gte("fingerprint", scope).lt("fingerprint", `${scope}\uffff`))
      .take(200);
    for (const s of rows) {
      if (!s.judge || s.case_of || !s.judge_review || s.judge_review.answer === "upheld") continue;
      if (!scope.endsWith(":") && s.fingerprint !== scope) continue;
      if (s.created_at < (await lineChangedAt(s))) continue;
      out.push({ key: s.fingerprint, short_id: s.short_id, expectation: s.subject ?? "", quote: quoteOfDetail(s.detail_md), ruling: s.judge_review.sentence ?? s.judge_review.note ?? "" });
    }
  }
  return out;
}

/** When an expectation line last changed: the version that last changed it was written then. 0 when the line is unknown. */
async function expectationChangedAt(ctx: any, projectId: Id<"projects"> | undefined, lineId: string | undefined): Promise<number> {
  const doc = projectId ? await latestExpectations(ctx, projectId) : null;
  const line = doc?.items.find((e: { id: string }) => e.id === lineId);
  if (!line) return 0;
  if (line.changed_in === doc.version) return doc.created_at;
  const row = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", projectId).eq("version", line.changed_in)).first();
  return row?.created_at ?? 0;
}

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
      const r = await retireSignals(ctx, rows, { reason: `found wrong earlier as ${b.ruling}: a ruling stands against this message`, actor: args.actor });
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
      await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Closed: none of its ${what} stands any more (${o.reason}).` });
      closed.push(task.short_id);
    }
  }
  return { retired: rows.length, problems: byTask.size, closed };
}

/**
 * Repair after a judge finding's evidence key changes (run with
 * packages/convex/run.sh): each row takes its new key where it stands, and its
 * problem's keys follow. A row whose new key another live finding already
 * holds is the same message filed twice, so all but the oldest are retired:
 * one message is one finding. judges.ts writtenMessage reading a thread's
 * match tag as an email's opening words (2026-10-12) is the first use: it gave
 * different emails one key and the same email a key per moment. `dry` reports
 * only.
 */
export const rekeyFindings = internalMutation({
  args: { workspace: v.string(), user_id: v.id("users"), rows: v.array(v.object({ signal: v.string(), key: v.string() })), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const rekeyed: string[] = [];
    const retired: Array<{ signal: string; same_as: string }> = [];
    for (const r of args.rows) {
      const row: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", r.signal)).first();
      if (!row || row.workspace !== args.workspace) throw new Error(`Finding ${r.signal} not found`);
      if (row.fingerprint === r.key || row.retired) continue;
      const holders = (await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).eq("fingerprint", r.key)).take(50))
        .filter((s: Doc<"signals">) => s._id !== row._id && standsAsEvidence(s));
      const twin = [row, ...holders].sort((a, b) => a.created_at - b.created_at)[0]!;
      if (twin._id !== row._id) {
        retired.push({ signal: row.short_id, same_as: twin.short_id });
        if (!args.dry) await retireSignals(ctx, [row], { reason: `the same message as ${twin.short_id}, filed once more under an older key`, actor: args.user_id });
        continue;
      }
      rekeyed.push(row.short_id);
      for (const h of holders) retired.push({ signal: h.short_id, same_as: row.short_id });
      if (args.dry) continue;
      if (holders.length) await retireSignals(ctx, holders, { reason: `the same message as ${row.short_id}, filed once more from another moment`, actor: args.user_id });
      await ctx.db.patch(row._id, { fingerprint: r.key });
      const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
      if (!task?.cause) continue;
      const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
      const keys = task.cause.fingerprints.filter((k) => k !== row.fingerprint || held.some((s) => s._id !== row._id && s.fingerprint === k));
      await ctx.db.patch(task._id, { cause: { ...task.cause, fingerprints: keys.includes(r.key) ? keys : [...keys, r.key] } });
    }
    return { rekeyed, retired };
  },
});

/** One page of a workspace's live judge runs, as findingStanding reads them. */
export const standingRunsPage = internalQuery({
  args: { workspace: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("judge_runs").withIndex("by_workspace_at", (q: any) => q.eq("workspace", args.workspace)).paginate({ cursor: args.cursor, numItems: 400 });
    const runs: StandingRun[] = (page.page as Doc<"judge_runs">[])
      .filter((r) => r.mode === "live" && r.status === "ok")
      .map((r) => {
        let found: Array<{ expectation: string; quote: string }> = [];
        try { found = (JSON.parse(r.findings_json ?? "[]") as JudgeFinding[]).map((x) => ({ expectation: x.expectation, quote: x.quote ?? "" })); } catch { /* unreadable: names nothing */ }
        return { moment: r.moment_short_id, judge: r.judge, version: r.judge_version, at: r.at, signal_ids: [...(r.signal_ids ?? []), ...(r.held_ids ?? [])].map(String), found };
      });
    return { runs, cursor: page.continueCursor, done: page.isDone };
  },
});

/** A project's live judge findings with what findingStanding needs, and who acts for the project's sources. */
export const standingPlan = internalQuery({
  args: { project_id: v.id("projects") },
  handler: async (ctx, args) => {
    const project = (await ctx.db.get(args.project_id))!;
    const doc = await latestExpectations(ctx, args.project_id);
    const active = new Set((doc?.items ?? []).filter((e: { status: string }) => e.status === "active").map((e: { id: string }) => e.id));
    const live = (await ctx.db.query("signals").withIndex("by_project_created", (q: any) => q.eq("project_id", args.project_id)).collect())
      .filter((s: Doc<"signals">) => standsAsEvidence(s) && s.judge && s.moment && s.subject);
    const source = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", project.workspace)).first();
    return {
      workspace: project.workspace!,
      actor: source?.owner_user_id ?? null,
      findings: live.map((s: Doc<"signals">) => ({ id: String(s._id), short_id: s.short_id, task: s.task_id ? String(s.task_id) : null, judge: s.judge!, moment: s.moment!, expectation: s.subject!, quote: quoteOfDetail(s.detail_md), graded: active.has(s.subject!) })),
    };
  },
});

/** The sweep's record of which moments' newest runs file each standing finding (settleRun keeps it from then on). */
export const setHeldBy = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("signals"), held_by: v.array(v.string()) })) },
  handler: async (ctx, args) => {
    for (const r of args.rows) await ctx.db.patch(r.id, { held_by: r.held_by });
    return { set: args.rows.length };
  },
});

export const retireStale = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("signals"), reason: v.string() })), actor: v.id("users") },
  handler: async (ctx, args) => {
    const closed: string[] = [];
    for (const r of args.rows) {
      const row: Doc<"signals"> | null = await ctx.db.get(r.id);
      if (!row || !standsAsEvidence(row)) continue;
      closed.push(...(await retireSignals(ctx, [row], { reason: r.reason, actor: args.actor })).closed);
    }
    return { closed };
  },
});

/**
 * Repair (run with packages/convex/run.sh): retire a finder's work from before
 * a cutoff when the finder itself is turned off (the old AgentWatch judges and
 * clusters, 2026-10-20). On each named problem filed before `before`, the
 * findings filed before it (from `sources` only, when given) retire with
 * `reason`; a problem left holding none closes as dropped with the reason as
 * its note, whatever its run was doing: the run's gate is then the trial
 * sweep's to end. A finding filed after the cutoff stays, and so does its
 * problem. Each retired finding keeps its problem in `retired.task_id`, which
 * is what undoing it reads. `dry` reports only.
 */
export const retireBefore = internalMutation({
  args: { tasks: v.array(v.string()), before: v.number(), reason: v.string(), sources: v.optional(v.array(v.string())), actor: v.id("users"), dry: v.boolean() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const out: Array<{ task: string; was: string; retired: string[]; kept: string[]; closed: boolean; skipped?: string }> = [];
    for (const ref of args.tasks) {
      const task: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ref)).first();
      if (!task || isTerminalTaskStatus(task.status) || task.created_at >= args.before) {
        out.push({ task: ref, was: task?.status ?? "missing", retired: [], kept: [], closed: false, skipped: !task ? "not found" : task.created_at >= args.before ? "filed after the cutoff" : "already closed" });
        continue;
      }
      const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
      const pick = held.filter((s) => s.created_at < args.before && (!args.sources || args.sources.includes(s.source)));
      const kept = held.filter((s) => !pick.includes(s));
      const closes = kept.length === 0;
      out.push({ task: ref, was: task.status, retired: pick.map((s) => s.short_id), kept: kept.map((s) => s.short_id), closed: closes });
      if (args.dry) continue;
      if (pick.length) await retireSignals(ctx, pick, { reason: args.reason, actor: args.actor });
      const fresh: Doc<"tasks"> = (await ctx.db.get(task._id))!;
      if (!closes || isTerminalTaskStatus(fresh.status)) continue;
      const note = `Closed: ${args.reason}.`;
      await moveTaskStatus(ctx, fresh, "dropped", { actorUserId: args.actor, actorType: "system", now, closedAt: now, ...(fresh.cause ? { extra: { cause: { ...fresh.cause, dissolved: { at: now, note } } } } : {}) });
      await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: note });
    }
    return out;
  },
});

/**
 * Sweep (run with packages/convex/run.sh): every live judge finding of a
 * project against the newest runs of its judge on the moments that carried it
 * (findingStanding). A finding no carrier's newest run files any more leaves
 * its problem, the way judging again retires one (settleRun). Findings
 * under a line no longer graded, or whose newest runs name the line on other
 * words, are listed and left. Each standing finding's held_by is written from
 * its carriers that settleRun can release (`lists`): a moment known only by
 * like words would hold it for good (releaseStrangers repairs those). `dry`
 * reports only.
 */
export const sweepStanding = internalAction({
  args: { project_id: v.id("projects"), dry: v.boolean() },
  handler: async (ctx, args): Promise<{ checked: number; stale: Array<{ finding: string; carriers: string }>; unsure: Array<{ finding: string; carriers: string }>; ungraded: string[]; closed: string[] }> => {
    const plan: { workspace: string; actor: Id<"users"> | null; findings: Array<{ id: string; short_id: string; judge: string; moment: string; expectation: string; quote: string; graded: boolean }> } =
      await ctx.runQuery(internal.judgeRetire.standingPlan, { project_id: args.project_id });
    const runs: StandingRun[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { runs: StandingRun[]; cursor: string; done: boolean } = await ctx.runQuery(internal.judgeRetire.standingRunsPage, { workspace: plan.workspace, cursor });
      runs.push(...page.runs);
      if (page.done) break;
      cursor = page.cursor;
    }
    const words = (cs: Array<{ moment: string; at: number; version: string; files: boolean; lists: boolean }>) =>
      cs.map((c) => `${c.moment} ${c.version.slice(0, 8)} ${new Date(c.at).toISOString().slice(5, 16)} ${c.files ? "files it" : "does not"}`).join("; ");
    const stale: Array<{ finding: string; carriers: string; id: string }> = [];
    const holders: Array<{ id: Id<"signals">; held_by: string[] }> = [];
    const unsure: Array<{ finding: string; carriers: string }> = [];
    const ungraded: string[] = [];
    for (const f of plan.findings) {
      if (!f.graded) { ungraded.push(f.short_id); continue; }
      const s = findingStanding(f, runs);
      if (s.verdict === "stale") stale.push({ finding: f.short_id, carriers: words(s.carriers), id: f.id });
      if (s.verdict === "stands") holders.push({ id: f.id as Id<"signals">, held_by: s.carriers.filter((c) => c.files && c.lists).map((c) => c.moment) });
      else if (s.verdict === "unsure") unsure.push({ finding: f.short_id, carriers: words(s.carriers) });
    }
    let closed: string[] = [];
    if (!args.dry) for (let i = 0; i < holders.length; i += 100) await ctx.runMutation(internal.judgeRetire.setHeldBy, { rows: holders.slice(i, i + 100) });
    if (!args.dry && stale.length) {
      if (!plan.actor) throw new Error("No source in this workspace to act for");
      const judge = (id: string) => plan.findings.find((f) => f.id === id)!.judge;
      closed = (await ctx.runMutation(internal.judgeRetire.retireStale, {
        actor: plan.actor,
        rows: stale.map((s) => ({ id: s.id as Id<"signals">, reason: `the newest runs of ${judge(s.id)} on its moments no longer file it (${s.carriers})` })),
      })).closed;
    }
    return { checked: plan.findings.length, stale: stale.map(({ finding, carriers }) => ({ finding, carriers })), unsure, ungraded, closed };
  },
});

/**
 * Repair (run with packages/convex/run.sh): a moment in a finding's held_by
 * that no run of its judge ever filed or held it from is a stranger: settleRun
 * lets a finding go only from the runs that list it, so a stranger holds it
 * for good and no re-read can retire it. Strangers leave held_by. A finding
 * left with no moment behind it, whose own moment's newest run does not list
 * it, leaves its problem as judging again would have had it. `dry` reports only.
 */
export const releaseStrangers = internalMutation({
  args: { signals: v.array(v.string()), dry: v.boolean() },
  handler: async (ctx, args) => {
    const out: Array<{ signal: string; held_by: string[]; strangers: string[]; retired: boolean }> = [];
    const lists = async (row: Doc<"signals">, moment: string): Promise<Doc<"judge_runs">[] | null> => {
      const m: Doc<"moments"> | null = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", moment)).first();
      if (!m) return null;
      const runs: Doc<"judge_runs">[] = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect())
        .filter((r: Doc<"judge_runs">) => r.judge === row.judge && r.status === "ok").sort((a: Doc<"judge_runs">, b: Doc<"judge_runs">) => a.at - b.at);
      return runs.some((r) => foundIn(r, row)) ? runs : null;
    };
    for (const sid of args.signals) {
      const row: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", sid)).first();
      if (!row || row.retired || !row.judge || !row.held_by) continue;
      const strangers: string[] = [];
      for (const m of row.held_by) if (!(await lists(row, m))) strangers.push(m);
      const by = row.held_by.filter((m) => !strangers.includes(m));
      const own = row.moment ? await lists(row, row.moment) : null;
      const retire = !!strangers.length && !by.length && !!own && !foundIn(own.at(-1)!, row);
      out.push({ signal: sid, held_by: row.held_by, strangers, retired: retire });
      if (args.dry || !strangers.length) continue;
      await ctx.db.patch(row._id, { held_by: by });
      if (retire) {
        const newest = own!.at(-1)!;
        const source: Doc<"event_sources"> | null = await ctx.db.get(newest.source_id);
        if (source) await retireSignals(ctx, [{ ...row, held_by: by }], { reason: `judged again by ${row.judge} ${newest.judge_version.slice(0, 8)}, which did not find it`, judge_version: newest.judge_version, actor: source.owner_user_id });
      }
    }
    return out;
  },
});

/**
 * One-off (run with packages/convex/run.sh): a judge-fix card already waiting
 * when the judge route learned to check repeats first, whose ruled findings
 * the published judge turns out not to repeat (`cast line judges base`
 * outcome draws). Nothing can be measured against a draw, so the card closes
 * unanswered, its run ends, and the problem says why with the counts.
 */
export const settleDrawCard = internalMutation({
  args: { card: v.string(), evidence: v.string() },
  handler: async (ctx, args) => {
    const row: Doc<"trial_cards"> | null = await ctx.db.query("trial_cards").withIndex("by_short_id", (q: any) => q.eq("short_id", args.card)).first();
    if (!row || row.status !== "waiting" || !row.judge_fix) throw new Error(`${args.card} is not a waiting judge-fix card`);
    const now = Date.now();
    await ctx.db.patch(row._id, { status: "closed", updated_at: now });
    const run: Doc<"workflow_runs"> | null = await ctx.db.get(row.run_id);
    if (run && run.status === "paused" && run.gate_node_id === row.node_id) {
      await ctx.db.patch(run._id, { status: "completed", gate_node_id: undefined, gate_prompt: undefined, gate_choices: undefined, gate_response: undefined, updated_at: now });
    }
    const asked = row.decision_id ? await ctx.db.get(row.decision_id) : null;
    if (asked?.status === "pending") await withdrawCore(ctx, asked as any, now);
    if (row.task_id) await insertTaskComment(ctx, row.task_id, { author: "line", comment_type: "note", text: `Judge fix ${row.short_id} closed without publishing: ${args.evidence}` });
    return { card: row.short_id, run: run?.status ?? null };
  },
});

/**
 * Repair after a resample retired real findings (run with
 * packages/convex/run.sh): before settleRun weighed misses (ABSENT_OF), one
 * read of the same judge version that missed a finding let it go. Each
 * `restore` row that a "judged again" miss by the version that filed it
 * retired goes back to the problem it left, which reopens when that retire
 * had emptied and dropped it; it counts its moment again (held_by). Each
 * `retire` row (a substitute the same resample filed) leaves with `reason`,
 * and a problem it empties drops (retireSignals). `dry` reports only.
 */
export const reinstateResampled = internalMutation({
  args: { restore: v.array(v.string()), retire: v.array(v.object({ signal: v.string(), reason: v.string() })), actor: v.id("users"), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const bySid = async (sid: string): Promise<Doc<"signals"> | null> => await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", sid)).first();
    const restored: Array<{ signal: string; task?: string; reopened?: boolean; skipped?: string }> = [];
    for (const sid of args.restore) {
      const row = await bySid(sid);
      const r = row?.retired;
      if (!row || !r) { restored.push({ signal: sid, skipped: row ? "not retired" : "no such finding" }); continue; }
      if (!r.reason.startsWith(`judged again by ${row.judge} `) || r.judge_version !== row.judge_version) { restored.push({ signal: sid, skipped: `not a same-version miss: ${r.reason}` }); continue; }
      const task: Doc<"tasks"> | null = r.task_id ? await ctx.db.get(r.task_id) : null;
      if (!task?.cause) { restored.push({ signal: sid, skipped: "its problem is gone" }); continue; }
      const reopen = isTerminalTaskStatus(task.status);
      if (reopen && task.status !== "dropped") { restored.push({ signal: sid, task: task.short_id, skipped: `its problem is ${task.status}` }); continue; }
      restored.push({ signal: sid, task: task.short_id, ...(reopen ? { reopened: true } : {}) });
      if (args.dry) continue;
      await ctx.db.patch(row._id, { retired: undefined, task_id: task._id, held_by: row.moment ? [row.moment] : [] });
      await recount(ctx, task, row.fingerprint, now);
      if (reopen) {
        await moveTaskStatus(ctx, (await ctx.db.get(task._id))!, "open", { actorUserId: args.actor, actorType: "system", now });
        await insertTaskComment(ctx, task._id, { author: "line", comment_type: "note", text: `Reopened: ${sid} came back. One read of the same judge version had missed it, which is a resample, not news.` });
      }
    }
    const rows: Doc<"signals">[] = [];
    const reasons = new Map<string, string>();
    for (const x of args.retire) {
      const row = await bySid(x.signal);
      if (row && !row.retired) { rows.push(row); reasons.set(String(row._id), x.reason); }
    }
    const retired: Array<{ signal: string; closed: string[] }> = [];
    if (!args.dry) for (const row of rows) retired.push({ signal: row.short_id, closed: (await retireSignals(ctx, [row], { reason: reasons.get(String(row._id))!, actor: args.actor })).closed });
    return { restored, retire: rows.map((r) => r.short_id), retired };
  },
});

/**
 * Audit (run with packages/convex/run.sh): what settleRun's rule now says of
 * findings a "judged again" miss retired, replayed as of that retire: the
 * moment's runs before it, the retiring run read as the current one (`at`
 * replays a row restored since). `fresh`
 * names lines as a scoped re-read would. Reads only.
 */
export const replayLetGo = internalQuery({
  args: { signals: v.array(v.object({ signal: v.string(), at: v.optional(v.number()) })), fresh: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const out: Array<{ signal: string; line?: string; moment?: string; was?: string; now?: string }> = [];
    for (const { signal: sid, at: retiredAt } of args.signals) {
      const row: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", sid)).first();
      // A row restored since is replayed as of the retire it had (`at`).
      const at = retiredAt ?? row?.retired?.at;
      const m: Doc<"moments"> | null = row?.moment ? await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", row.moment!)).first() : null;
      if (!row || !m || !row.judge) { out.push({ signal: sid }); continue; }
      const runs: Doc<"judge_runs">[] = (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect())
        .filter((r: Doc<"judge_runs">) => r.judge === row.judge && r.status === "ok").sort((a: Doc<"judge_runs">, b: Doc<"judge_runs">) => a.at - b.at);
      const before = at ?? Date.now();
      const current = runs.find((r) => r.at >= before) ?? runs.at(-1)!;
      const version = row.retired?.judge_version ?? current.judge_version;
      const now = await absence(ctx, row, runs.filter((r) => r.at < before), { judge_version: version, ...(current.inputs ? { inputs: current.inputs } : {}) }, (args.fresh ?? []).includes(row.subject ?? ""));
      out.push({ signal: sid, line: row.subject, moment: m.short_id, was: row.retired?.reason ?? "live", now });
    }
    return out;
  },
});

/**
 * Repair (run with packages/convex/run.sh): a line whose changed_in moved
 * though only its `since` or citations changed (a since-only edit before
 * edits kept changed_in) claims words newer than it has, so expectationChangedAt
 * reads its findings and rulings as judged against words that are gone. Each
 * line takes back `changed_in`, only when its words at that version equal its
 * words now. `dry` reports only.
 */
export const restampChangedIn = internalMutation({
  args: { project_id: v.id("projects"), lines: v.array(v.object({ id: v.string(), changed_in: v.number() })), dry: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const doc: Doc<"project_expectations"> | null = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", args.project_id)).order("desc").first();
    if (!doc) throw new Error("no expectations for this project");
    const words = (e: any) => { const { changed_in: _c, since: _s, citations: _x, ...rest } = e; return JSON.stringify(rest, Object.keys(rest).sort()); };
    const out: Array<{ id: string; from?: number; to: number; ok: boolean; why?: string }> = [];
    const items = [...doc.items];
    for (const l of args.lines) {
      const i = items.findIndex((e: any) => e.id === l.id);
      if (i < 0) { out.push({ id: l.id, to: l.changed_in, ok: false, why: "no such line" }); continue; }
      const then: Doc<"project_expectations"> | null = await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", args.project_id).eq("version", l.changed_in)).first();
      const old = then?.items.find((e: any) => e.id === l.id);
      if (!old || words(old) !== words(items[i])) { out.push({ id: l.id, from: items[i]!.changed_in, to: l.changed_in, ok: false, why: "its words differ from that version's" }); continue; }
      out.push({ id: l.id, from: items[i]!.changed_in, to: l.changed_in, ok: true });
      items[i] = { ...items[i]!, changed_in: l.changed_in };
    }
    if (!args.dry && out.some((o) => o.ok)) await ctx.db.patch(doc._id, { items });
    return { version: doc.version, lines: out };
  },
});
