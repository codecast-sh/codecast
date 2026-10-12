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
import { CLOSED_WITH, reembedFinding, standsAsEvidence } from "./findingGroups";
import type { Doc, Id } from "./_generated/dataModel";
import { insertTaskComment, moveTaskStatus } from "./tasks";
import { refreshCauseDescription } from "./signals";
import { latestExpectations } from "./lib/expectationsApply";
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
        // Retired when a line closed its problem: found again, it is still that problem's history, never a fresh copy.
        if (rows.some((s) => CLOSED_WITH.test(s.retired?.reason ?? ""))) { live.push(r.key); continue; }
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
 * finding marked wrong (judge_review) whose diagnosis did not uphold it,
 * filed against the expectation's current words. A scope is an evidence key
 * without its message (`evidence:<who>:<expectation>:`), so every message of
 * that contact under that expectation is read, whichever judge, judge version
 * or moment kind filed it; any other key is its own scope. A ruling on a
 * finding filed before its line last changed judged words that are gone (a
 * stale line is a common reason a finding is wrong), so it binds nothing.
 */
export const rulings = internalQuery({
  args: { workspace: v.string(), scopes: v.array(v.string()) },
  handler: async (ctx, args): Promise<Ruling[]> => {
    const out: Ruling[] = [];
    const changedAt = new Map<string, number>();
    const lineChangedAt = async (s: Doc<"signals">): Promise<number> => {
      const k = `${s.project_id}|${s.subject}`;
      if (!changedAt.has(k)) changedAt.set(k, await expectationChangedAt(ctx, s.project_id, s.subject));
      return changedAt.get(k)!;
    };
    for (const scope of new Set(args.scopes)) {
      const rows: Doc<"signals">[] = await ctx.db.query("signals")
        .withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", args.workspace).gte("fingerprint", scope).lt("fingerprint", `${scope}\uffff`))
        .take(200);
      for (const s of rows) {
        if (!s.judge || s.case_of || !s.judge_review || s.judge_review.answer === "upheld") continue;
        if (!scope.endsWith(":") && s.fingerprint !== scope) continue;
        if (s.created_at < (await lineChangedAt(s))) continue;
        out.push({ key: s.fingerprint, short_id: s.short_id, quote: quoteOfDetail(s.detail_md) });
      }
    }
    return out;
  },
});

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

/** A live judge run as the standing sweep reads it: where it ran, which findings it stands behind, what it found. */
export type StandingRun = { moment: string; judge: string; version: string; at: number; signal_ids: string[]; found: Array<{ expectation: string; quote: string }> };

/** Two quotes of one message: one holds the other's opening words, or they share a sentence. */
export function quotesOverlap(a: string, b: string): boolean {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (x.includes(y.slice(0, 40)) || y.includes(x.slice(0, 40))) return true;
  const sentences = (t: string) => t.split(/(?<=[.!?])\s+/).filter((s) => s.length >= 20);
  return sentences(x).some((s) => y.includes(s));
}

/**
 * Whether a live finding still has a moment standing behind it. Its carriers
 * are every moment one of its judge's runs filed it from or found it in again:
 * its own moment, a run listing it, a run naming its expectation on the same
 * words. It stands while the newest run of its judge on some carrier still
 * files it; it is stale when every carrier's newest run has let it go. A
 * newest run that names the expectation on other words may be the same message
 * quoted differently, so the finding is left as unsure rather than retired.
 */
export function findingStanding(
  f: { id: string; judge: string; moment: string; expectation: string; quote: string },
  runs: StandingRun[],
): { verdict: "stands" | "stale" | "unsure"; carriers: Array<{ moment: string; at: number; version: string; files: boolean }> } {
  const mine = runs.filter((r) => r.judge === f.judge);
  const names = (r: StandingRun) => r.found.some((x) => x.expectation === f.expectation && quotesOverlap(x.quote, f.quote));
  const files = (r: StandingRun) => r.signal_ids.includes(f.id) || names(r);
  const carriers = new Set([f.moment, ...mine.filter(files).map((r) => r.moment)]);
  const out: Array<{ moment: string; at: number; version: string; files: boolean }> = [];
  let near = false;
  for (const m of carriers) {
    const newest = mine.filter((r) => r.moment === m).sort((a, b) => b.at - a.at)[0];
    if (!newest) continue;
    out.push({ moment: m, at: newest.at, version: newest.version, files: files(newest) });
    if (!files(newest) && newest.found.some((x) => x.expectation === f.expectation)) near = true;
  }
  if (!out.length) return { verdict: "unsure", carriers: out };
  return { verdict: out.some((c) => c.files) ? "stands" : near ? "unsure" : "stale", carriers: out };
}

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
        return { moment: r.moment_short_id, judge: r.judge, version: r.judge_version, at: r.at, signal_ids: (r.signal_ids ?? []).map(String), found };
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
 * Sweep (run with packages/convex/run.sh): every live judge finding of a
 * project against the newest runs of its judge on the moments that carried it
 * (findingStanding). A finding no carrier's newest run files any more leaves
 * its problem, the way judging again retires one (retireSuperseded). Findings
 * under a line no longer graded, or whose newest runs name the line on other
 * words, are listed and left. `dry` reports only.
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
    const words = (cs: Array<{ moment: string; at: number; version: string; files: boolean }>) =>
      cs.map((c) => `${c.moment} ${c.version.slice(0, 8)} ${new Date(c.at).toISOString().slice(5, 16)} ${c.files ? "files it" : "does not"}`).join("; ");
    const stale: Array<{ finding: string; carriers: string; id: string }> = [];
    const unsure: Array<{ finding: string; carriers: string }> = [];
    const ungraded: string[] = [];
    for (const f of plan.findings) {
      if (!f.graded) { ungraded.push(f.short_id); continue; }
      const s = findingStanding(f, runs);
      if (s.verdict === "stale") stale.push({ finding: f.short_id, carriers: words(s.carriers), id: f.id });
      else if (s.verdict === "unsure") unsure.push({ finding: f.short_id, carriers: words(s.carriers) });
    }
    let closed: string[] = [];
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
