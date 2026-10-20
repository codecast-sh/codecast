// The line's leading stages as objects a person can open (docs/architecture/
// learning-loop.md LL1, LL7 to LL9, LL12): what a product sends (moments and
// the extractor of each kind), the judges that read them (prompt, version,
// every run), how grouping places findings, and the trial's dispatcher (its
// queue in order, what holds it). The Map draws these as the stages before the
// line's own stations; each opens as a drawer (web components/line/workspace/
// stages). Live findings and problems already ride the line's feeds
// (signals.webList, tasks), so what is read here is only what no feed holds:
// moments, extractors, judges and their runs, withdrawn findings, the queue.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { canAccessProject } from "./lib/access";
import { momentView } from "./lib/momentBody";
import { EMBEDDING_MODEL } from "./lib/embeddings";
import { CHEAP_MODEL } from "./lib/anthropic";
import { GROUPING } from "./findingGroups";
import { dispatchPass, dueProblems, trialRoom, TRIAL_RUNNING_CAP } from "./lineTrial";

const DAY = 86_400_000;
/** Newest moments read for a project's counts: older ones are counted as "older than the window". */
const MOMENT_WINDOW = 4000;
/** Newest runs read per judge (each carries its findings' JSON, so this bounds the read). */
const RUNS_PER_JUDGE = 800;
/** Rows of each list a drawer opens on. */
const RECENT = 25;

async function readableProject(ctx: any, project: string): Promise<Doc<"projects"> | null> {
  const userId = await getAuthUserId(ctx);
  const id = ctx.db.normalizeId("projects", project);
  const row: Doc<"projects"> | null = id ? await ctx.db.get(id) : null;
  if (!userId || !row || !(await canAccessProject(ctx, userId, row))) return null;
  return row;
}

/** The product sources that bring this project's moments: a source filed for it, or one whose judges grade it. */
async function sourcesOf(ctx: any, project: Doc<"projects">): Promise<Doc<"event_sources">[]> {
  if (!project.workspace) return [];
  const all: Doc<"event_sources">[] = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", project.workspace)).collect();
  const out: Doc<"event_sources">[] = [];
  for (const s of all) {
    if (String(s.project_id ?? "") === String(project._id)) { out.push(s); continue; }
    const judges: Doc<"judges">[] = await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", s._id)).collect();
    if (judges.some((j) => j.project_ids.some((p) => String(p) === String(project._id)))) out.push(s);
  }
  return out;
}

type Tally = { runs: number; ok: number; failed: number; skipped: number; findings: number; filed: number; cost_usd: number; first_at: number; last_at: number };
const tally = (): Tally => ({ runs: 0, ok: 0, failed: 0, skipped: 0, findings: 0, filed: 0, cost_usd: 0, first_at: Infinity, last_at: 0 });
function add(t: Tally, r: Doc<"judge_runs">) {
  t.runs++;
  t[r.status]++;
  t.findings += r.findings;
  t.filed += r.signal_ids?.length ?? 0;
  t.cost_usd += r.cost_usd;
  t.first_at = Math.min(t.first_at, r.at);
  t.last_at = Math.max(t.last_at, r.at);
}
const round = (t: Tally) => ({ ...t, cost_usd: Math.round(t.cost_usd * 100) / 100, first_at: Number.isFinite(t.first_at) ? t.first_at : null, last_at: t.last_at || null });

/** Days a stage's per-day counts cover, newest last. */
const DAYS = 14;
/** How many of `ats` fall on each of the last DAYS days (local to the server's clock: whole 24h spans back from now), oldest first. */
function perDay(ats: number[], now: number): number[] {
  const out = new Array(DAYS).fill(0);
  for (const at of ats) {
    const i = DAYS - 1 - Math.floor((now - at) / DAY);
    if (i >= 0 && i < DAYS) out[i]++;
  }
  return out;
}

/** The median of a list of numbers, or null. */
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * One project's leading stages, as one row keyed by the project: its moment
 * kinds (each with its extractor, counts by status, rate, the versions that
 * read them, the newest and the failed), its judges (each with its whole
 * prompt, its runs by version, its newest runs), withdrawn findings, and the
 * grouping rule's thresholds and models. Null when the viewer may not read it.
 */
export const flow = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const project = await readableProject(ctx, args.project);
    if (!project) return null;
    const now = Date.now();
    const sources = await sourcesOf(ctx, project);
    const bySource = new Map(sources.map((s) => [String(s._id), s]));

    // Moments: the newest of the workspace, kept to these sources.
    const rows: Doc<"moments">[] = project.workspace && sources.length
      ? await ctx.db.query("moments").withIndex("by_workspace_created", (q: any) => q.eq("workspace", project.workspace)).order("desc").take(MOMENT_WINDOW)
      : [];
    const moments = rows.filter((m) => bySource.has(String(m.source_id)));
    const kinds = new Map<string, { source: Doc<"event_sources">; rows: Doc<"moments">[] }>();
    for (const m of moments) {
      const key = `${m.source_id}|${m.kind}`;
      if (!kinds.has(key)) kinds.set(key, { source: bySource.get(String(m.source_id))!, rows: [] });
      kinds.get(key)!.rows.push(m);
    }
    const extractors: Doc<"moment_extractors">[] = [];
    for (const s of sources) extractors.push(...(await ctx.db.query("moment_extractors").withIndex("by_source_kind", (q: any) => q.eq("source_id", s._id)).collect()));
    // A kind with an extractor and no moment yet still shows: its extractor is published and waits.
    for (const e of extractors) {
      const key = `${e.source_id}|${e.kind}`;
      if (!kinds.has(key)) kinds.set(key, { source: bySource.get(String(e.source_id))!, rows: [] });
    }
    // A listed moment with what its judges made of it: read by each, what they found, what they filed.
    const verdictOf = async (m: Doc<"moments">) => {
      const runs: Doc<"judge_runs">[] = await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect();
      const newest = new Map<string, Doc<"judge_runs">>();
      for (const r of runs) if (!newest.has(r.judge) || newest.get(r.judge)!.at < r.at) newest.set(r.judge, r);
      const last = [...newest.values()];
      return { ...momentView(m), verdict: { judges: last.length, failed: last.filter((r) => r.status === "failed").length, found: last.reduce((n, r) => n + r.findings, 0), filed: last.reduce((n, r) => n + (r.signal_ids?.length ?? 0), 0) } };
    };
    const kindRows = await Promise.all([...kinds.entries()].map(async ([key, k]) => {
      const kind = key.split("|")[1];
      const ex = extractors.find((e) => `${e.source_id}|${e.kind}` === key) ?? null;
      const counts = { waiting: 0, extracting: 0, ready: 0, failed: 0 };
      const versions = new Map<string, { version: string; n: number; last_at: number }>();
      for (const m of k.rows) {
        counts[m.status]++;
        if (m.extractor_version) {
          const v0 = versions.get(m.extractor_version) ?? { version: m.extractor_version, n: 0, last_at: 0 };
          v0.n++;
          v0.last_at = Math.max(v0.last_at, m.extracted_at ?? m.created_at);
          versions.set(m.extractor_version, v0);
        }
      }
      return {
        kind,
        source: k.source.name,
        extractor: ex ? { path: ex.path, version: ex.version, quiet_ms: ex.quiet_ms, timeout_ms: ex.timeout_ms, device_id: ex.device_id, root: ex.root, published_at: ex.published_at } : null,
        counts,
        total: k.rows.length,
        day: k.rows.filter((m) => m.created_at >= now - DAY).length,
        week: k.rows.filter((m) => m.created_at >= now - 7 * DAY).length,
        newest_at: k.rows[0]?.created_at ?? null,
        // When what arrived happened: a replay brings old events, so arrivals alone would read as live traffic.
        newest_event_at: k.rows.reduce((m, r) => Math.max(m, r.event_at), 0) || null,
        days: perDay(k.rows.map((m) => m.created_at), now),
        replayed: k.rows.filter((m) => m.created_at >= now - 7 * DAY && m.created_at - m.event_at > DAY).length,
        gap_ms: median(k.rows.flatMap((m) => (m.gap_ms != null ? [m.gap_ms] : []))),
        versions: [...versions.values()].sort((a, b) => b.last_at - a.last_at),
        recent: await Promise.all(k.rows.slice(0, RECENT).map(verdictOf)),
        failed: await Promise.all(k.rows.filter((m) => m.status === "failed").slice(0, RECENT).map(verdictOf)),
      };
    }));

    // Judges: every one these sources published (a removed one keeps its runs), its prompt whole, its runs by version.
    const judges = [];
    for (const s of sources) {
      const js: Doc<"judges">[] = await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", s._id)).collect();
      for (const j of js) {
        if (!j.project_ids.some((p) => String(p) === String(project._id)) && String(s.project_id ?? "") !== String(project._id)) continue;
        const runs: Doc<"judge_runs">[] = await ctx.db.query("judge_runs").withIndex("by_judge_at", (q: any) => q.eq("judge_id", j._id)).order("desc").take(RUNS_PER_JUDGE);
        const all = tally();
        const week = tally();
        const byVersion = new Map<string, Tally>();
        for (const r of runs) {
          add(all, r);
          if (r.at >= now - 7 * DAY) add(week, r);
          if (!byVersion.has(r.judge_version)) byVersion.set(r.judge_version, tally());
          add(byVersion.get(r.judge_version)!, r);
        }
        judges.push({
          id: String(j._id),
          name: j.name,
          source: s.name,
          version: j.version,
          path: j.path,
          moment_kind: j.moment_kind,
          model: j.model,
          max_tokens: j.max_tokens,
          mode: j.mode,
          parts: j.parts ?? null,
          prompt: j.prompt,
          // An agent judge's session (agentReviews.ts): its reviews are read by `reviews` below while its page is open.
          agent: j.agent ? { tools: j.agent.tools, cwd: j.agent.cwd, max_turns: j.agent.max_turns, timeout_ms: j.agent.timeout_ms, claude_md: !!j.agent.claude_md, gateway: j.agent.gateway ?? null } : null,
          published_at: j.published_at,
          removed_at: j.removed_at ?? null,
          capped: runs.length === RUNS_PER_JUDGE,
          all: round(all),
          week: round(week),
          days: perDay(runs.map((r) => r.at), now),
          versions: [...byVersion.entries()].map(([version, t]) => ({ version, ...round(t) })).sort((a, b) => (b.last_at ?? 0) - (a.last_at ?? 0)),
          recent: runs.slice(0, RECENT).map((r) => ({ moment: r.moment_short_id, status: r.status, reason: r.reason ?? null, findings: r.findings, filed: r.signal_ids?.length ?? 0, version: r.judge_version, cost_usd: r.cost_usd, at: r.at })),
        });
      }
    }

    // Withdrawn findings: a newer judging did not find them again (judgeRetire). The live feed leaves them out.
    const retiredRows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_project_created", (q: any) => q.eq("project_id", project._id)).order("desc").take(1500);
    const retired = retiredRows.filter((s) => s.retired).sort((a, b) => b.retired!.at - a.retired!.at);

    return {
      _id: String(project._id),
      project: project.title,
      sources: sources.map((s) => s.name),
      window: { moments: rows.length, capped: rows.length === MOMENT_WINDOW },
      kinds: kindRows.sort((a, b) => (b.newest_at ?? 0) - (a.newest_at ?? 0)),
      judges,
      retired: {
        week: retired.filter((s) => s.retired!.at >= now - 7 * DAY).length,
        recent: retired.slice(0, RECENT).map((s) => ({ short_id: s.short_id, title: s.title, reason: s.retired!.reason, at: s.retired!.at, task_id: s.retired!.task_id ? String(s.retired!.task_id) : null, judge: s.judge ?? null, judge_version: s.retired!.judge_version ?? null })),
      },
      days: DAYS,
      grouping: { ...GROUPING, embedding_model: EMBEDDING_MODEL, attach_model: CHEAP_MODEL },
      at: now,
    };
  },
});

/**
 * An agent judge's reviews, for its page: the queue by status, what runs now
 * and where, and the newest finished, each with what it took and whether its
 * transcript is kept. Read only while the judge's page is open: it reads every
 * review of the judge, and each one that settles re-runs it.
 */
export const reviews = query({
  args: { project: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const project = await readableProject(ctx, args.project);
    if (!project) return null;
    const sources = await sourcesOf(ctx, project);
    let judge: Doc<"judges"> | null = null;
    for (const s of sources) {
      const row: Doc<"judges"> | null = await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", s._id).eq("name", args.judge)).first();
      if (row?.agent && row.project_ids.some((p) => String(p) === String(project._id))) judge = row;
    }
    if (!judge) return null;
    const rows: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_judge_created", (q: any) => q.eq("judge_id", judge._id)).order("desc").collect();
    const counts = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const r of rows) counts[r.status]++;
    const view = (r: Doc<"agent_reviews">) => ({
      review: r.short_id, moment: r.moment_short_id, subject: r.subject, status: r.status, batch: r.batch ?? null, attempts: r.attempts,
      device: r.claim_device ?? null, account: r.account ?? null, started_at: r.started_at ?? null, finished_at: r.finished_at ?? null,
      took_ms: r.took_ms ?? null, turns: r.turns ?? null, notional_usd: r.notional_usd ?? null, findings: r.findings ?? null, filed: r.filed ?? null,
      transcript: !!r.transcript_key, error: r.error ?? null,
    });
    const done = rows.filter((r) => r.status === "done").sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
    const sample = done.slice(0, 200);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return {
      _id: `${project._id}|${judge.name}`,
      counts,
      running: rows.filter((r) => r.status === "running").map(view),
      recent: done.slice(0, RECENT).map(view),
      failed: rows.filter((r) => r.status === "failed").slice(0, RECENT).map(view),
      averages: {
        of: sample.length,
        took_ms: mean(sample.flatMap((r) => (r.took_ms ? [r.took_ms] : []))),
        notional_usd: mean(sample.flatMap((r) => (r.notional_usd != null ? [r.notional_usd] : []))),
        findings: mean(sample.map((r) => r.findings ?? 0)),
      },
    };
  },
});

/**
 * A trial project's dispatcher as its pass sees it now (lineTrial.dispatchPass,
 * dry): the problems due a run in the order it starts them and why each is due,
 * what it would start next, the places running, the run limit and the spend
 * cap, and what holds it. Read only while its drawer is open: the pass reads
 * every problem of the project.
 */
export const dispatch = query({
  args: { project: v.string() },
  handler: async (ctx, args) => {
    const project = await readableProject(ctx, args.project);
    if (!project?.line_trial) return null;
    const now = Date.now();
    const d = project.line_trial.dispatch;
    if (d) {
      const pass = await dispatchPass(ctx as any, project, now, true);
      const room = await trialRoom(ctx as any, project, now, pass.running);
      return { _id: String(project._id), on: true as const, places: TRIAL_RUNNING_CAP, pass, room: roomFacts(room), last: d.last ?? null, at: now };
    }
    const { due, running } = await dueProblems(ctx as any, project);
    const room = await trialRoom(ctx as any, project, now, running);
    return { _id: String(project._id), on: false as const, places: TRIAL_RUNNING_CAP, pass: { running, due: due.map(({ row: _row, ...x }) => x), started: [], resumed: [], gathering: [], ended: [], held: null }, room: roomFacts(room), last: null, at: now };
  },
});

/** The dispatcher's room as numbers a screen draws (no Infinity: a limit not set is null). Money is billed dollars
 *  only; subscription use is quota, read per account (lineTrial.trialRoom). */
function roomFacts(r: Awaited<ReturnType<typeof trialRoom>>) {
  const fin = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
  return { running: r.running, per_run_usd: fin(r.perRun), room_usd: fin(r.room), runs_left: fin(r.runsLeft), cap_usd: r.cap_usd, max_runs: r.max_runs, runs: r.spend.runs, billed: r.spend.billed, subscription: r.spend.subscription, quota: r.quota, quota_hold: r.quotaHold };
}
