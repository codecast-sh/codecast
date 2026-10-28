// Everything that entered the line, newest first (ct-68152): one event per thing
// that happened, each naming what it is, where it came from, when, and the
// objects it touches, so the web can follow it forward (moment -> finding ->
// problem -> run -> deploy) and back. Derived at read from each fact's own row;
// nothing is stored twice. Decisions are not here: their one home on the web is
// the decision collection, and the timeline derives their events there.
//
// Paging: each source is read newest first over its own workspace index, N rows
// before `before`. The page is complete from `cutoff` up: the newest of the
// oldest times of the sources that filled their N (a source that did not fill
// it has nothing older in reach). Problems and runs are read by updated_at, a
// superset of their events (an event never postdates its row's update), so
// their events older than the cutoff ride this page and are not read again.
import { v } from "convex/values";
import { query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { scopeOf, scopeArgs } from "./lib/ingestScope";
import type { TimelineEvent } from "@codecast/shared/contracts/lineTimeline";

/** Rows read per source per page. */
const PAGE_ROWS = 60;
const PAGE_ROWS_MAX = 200;

type Ctx = { db: any };

/** The window a page reads: before `before`, and after `after` when a poll asks only for what is new. */
const range = (field: string, ws: string, before: number | undefined, after: number | undefined) => (q: any) => {
  let w = q.eq("workspace", ws);
  if (after != null) w = w.gt(field, after);
  return before != null ? w.lt(field, before) : w;
};

async function newest<T>(ctx: Ctx, table: string, index: string, field: string, ws: string, before: number | undefined, after: number | undefined, n: number): Promise<{ rows: T[]; oldest: number | null }> {
  const rows: any[] = await ctx.db.query(table).withIndex(index, range(field, ws, before, after)).order("desc").take(n);
  return { rows, oldest: rows.length >= n ? rows[rows.length - 1][field] : null };
}

/** A problem's task: its events (opened, merged or closed) from one row. */
export function problemEvents(t: Doc<"tasks">, ws: string, intoRef: (id: Id<"tasks">) => string | undefined): TimelineEvent[] {
  const base = { workspace: ws, source: "line", project_id: t.project_id ? String(t.project_id) : undefined, title: t.title, task: String(t._id), task_ref: t.short_id };
  const out: TimelineEvent[] = [{
    ...base, _id: `task:${t._id}:opened`, at: t.created_at, kind: "problem_opened",
    ...(t.cause?.split_from ? { split_from: String(t.cause.split_from) } : {}),
  }];
  if (t.closed_at && (t.status === "done" || t.status === "dropped")) {
    const into = t.cause?.merged_into ? intoRef(t.cause.merged_into) : t.duplicate_of;
    out.push(into
      ? { ...base, _id: `task:${t._id}:closed`, at: t.closed_at, kind: "problem_merged", into_ref: into }
      : { ...base, _id: `task:${t._id}:closed`, at: t.closed_at, kind: "problem_closed", detail: t.status === "done" ? "fixed" : "dropped" });
  }
  return out;
}

function runEvents(r: Doc<"workflow_runs">, ws: string, task: Doc<"tasks"> | null): TimelineEvent[] {
  const base = {
    workspace: ws, source: "line", run: String(r._id), title: task?.title ?? r.workflow_name ?? "Run",
    ...(task ? { task: String(task._id), task_ref: task.short_id, project_id: task.project_id ? String(task.project_id) : undefined } : {}),
  };
  const out: TimelineEvent[] = [{ ...base, _id: `run:${r._id}:started`, at: r.created_at, kind: "run_started", detail: r.workflow_name }];
  for (const n of r.node_statuses ?? []) {
    if (!n.completed_at || (n.status !== "completed" && n.status !== "failed")) continue;
    out.push({ ...base, _id: `run:${r._id}:${n.node_id}:${n.completed_at}`, at: n.completed_at, kind: "station", node: n.label ?? n.node_id, detail: n.outcome ?? n.status, ...(n.session_id ? { session: n.session_id } : {}) });
  }
  if (["completed", "failed", "cancelled"].includes(r.status)) out.push({ ...base, _id: `run:${r._id}:ended`, at: r.updated_at, kind: "run_ended", detail: r.status });
  return out;
}

/** One page of the timeline for the caller's workspace (see the head of this file). */
export const page = query({
  // `after`: only what changed since then (a poll of the head), so a poll reads the new rows, never the page again.
  args: { ...scopeArgs, before: v.optional(v.number()), after: v.optional(v.number()), rows: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { workspaceKey: ws } = await scopeOf(ctx, args);
    const n = Math.min(Math.max(args.rows ?? PAGE_ROWS, 1), PAGE_ROWS_MAX);
    const { before, after } = args;
    const [moments, judged, signals, tasks, runs, errors, replays, deploys] = await Promise.all([
      newest<Doc<"moments">>(ctx, "moments", "by_workspace_created", "created_at", ws, before, after, n),
      newest<Doc<"judge_runs">>(ctx, "judge_runs", "by_workspace_at", "at", ws, before, after, n),
      newest<Doc<"signals">>(ctx, "signals", "by_workspace_created", "created_at", ws, before, after, n),
      newest<Doc<"tasks">>(ctx, "tasks", "by_workspace_updated", "updated_at", ws, before, after, n),
      newest<Doc<"workflow_runs">>(ctx, "workflow_runs", "by_workspace_updated", "updated_at", ws, before, after, n),
      newest<Doc<"external_events">>(ctx, "external_events", "by_workspace_created", "created_at", ws, before, after, n),
      newest<Doc<"replays">>(ctx, "replays", "by_workspace_started", "started_at", ws, before, after, n),
      newest<Doc<"deploys">>(ctx, "deploys", "by_workspace_created", "created_at", ws, before, after, n),
    ]);
    const cutoff = Math.max(0, ...[moments, judged, signals, tasks, runs, errors, replays, deploys].map((s) => s.oldest ?? 0));

    const events: TimelineEvent[] = [];
    const sources = new Map<string, Doc<"event_sources"> | null>();
    const sourceOf = async (id: Id<"event_sources">) => {
      const k = String(id);
      if (!sources.has(k)) sources.set(k, await ctx.db.get(id));
      return sources.get(k)!;
    };
    const taskRows = new Map<string, Doc<"tasks"> | null>();
    const taskOf = async (id: Id<"tasks"> | undefined) => {
      if (!id) return null;
      const k = String(id);
      if (!taskRows.has(k)) taskRows.set(k, await ctx.db.get(id));
      const t = taskRows.get(k)!;
      return t && t.workspace === ws ? t : null;
    };

    for (const m of moments.rows) {
      const src = await sourceOf(m.source_id);
      const projectId = m.project_id ?? src?.project_id;
      events.push({
        _id: `moment:${m._id}`, workspace: ws, at: m.created_at, kind: "moment", source: src?.name ?? m.kind,
        ...(projectId ? { project_id: String(projectId) } : {}),
        title: m.who ? String(m.who) : m.subject, detail: m.kind, moment: m.short_id,
      });
    }
    // A judge's read names the conversation it read: its contact, as the moment's own event does.
    const momentRows = new Map<string, Doc<"moments"> | null>(moments.rows.map((m) => [String(m._id), m]));
    for (const j of judged.rows) {
      if (j.status === "skipped") continue;
      const k = String(j.moment_id);
      if (!momentRows.has(k)) momentRows.set(k, await ctx.db.get(j.moment_id));
      const m = momentRows.get(k);
      // An agent judge's read is its review session: one event, named as the review.
      const reviews: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_moment", (q: any) => q.eq("moment_id", j.moment_id)).take(10);
      const review = reviews.find((r) => r.run_id === j._id);
      events.push({
        _id: `judged:${j._id}`, workspace: ws, at: j.at, kind: review ? "review" : "judged", source: `judge:${j.judge}`,
        ...(review ? { review: review.short_id } : {}),
        ...(j.expectations[0] ? { project_id: String(j.expectations[0].project_id) } : {}),
        title: m?.who ? String(m.who) : m?.subject ?? j.moment_short_id, detail: j.status === "failed" ? "failed" : `${j.findings} findings`, moment: j.moment_short_id,
      });
    }
    for (const s of signals.rows) {
      const t = await taskOf(s.task_id);
      events.push({
        _id: `signal:${s._id}`, workspace: ws, at: s.created_at, kind: "finding", source: s.source,
        ...(s.project_id ? { project_id: String(s.project_id) } : {}),
        title: s.title, detail: s.kind, signal: String(s._id), signal_ref: s.short_id,
        ...(s.moment ? { moment: s.moment } : {}),
        ...(s.subject?.startsWith("eg-") ? { group: s.subject } : {}),
        ...(t ? { task: String(t._id), task_ref: t.short_id } : {}),
        ...(s.evidence_url ? { url: s.evidence_url } : {}),
      });
    }
    const intoRefs = new Map<string, string | undefined>();
    for (const t of tasks.rows) if (t.cause?.merged_into) intoRefs.set(String(t.cause.merged_into), (await taskOf(t.cause.merged_into))?.short_id);
    for (const t of tasks.rows) {
      if (t.source !== "signal" || !t.cause) continue;
      // Its source is where its findings came from, which the web already holds per problem (problemOrigins): read here,
      // it was a finding per problem on every page.
      events.push(...problemEvents(t, ws, (id) => intoRefs.get(String(id))));
    }
    for (const r of runs.rows) {
      if (!r.task_id) continue;
      const t = await taskOf(r.task_id);
      if (!t?.cause) continue;
      events.push(...runEvents(r, ws, t));
    }
    for (const e of errors.rows) {
      const data = (e.data ?? {}) as Record<string, any>;
      // Deploy markers show as the deploy object they recorded.
      if (e.kind === "deploy" || !data.group_short_id) continue;
      const src = e.source_id ? await sourceOf(e.source_id) : null;
      events.push({
        _id: `event:${e._id}`, workspace: ws, at: e.created_at, kind: "error", source: data.source_name ?? src?.name ?? e.source,
        ...(src?.project_id ? { project_id: String(src.project_id) } : {}),
        title: e.title ?? data.group_short_id, detail: data.transition ?? e.kind, group: data.group_short_id,
        ...(e.task_id ? { task: String(e.task_id) } : {}),
      });
    }
    for (const r of replays.rows) {
      const src = await sourceOf(r.source_id);
      events.push({
        _id: `replay:${r._id}`, workspace: ws, at: r.started_at, kind: "replay", source: src?.name ?? r.provider,
        ...(src?.project_id ? { project_id: String(src.project_id) } : {}),
        title: r.user?.email ?? r.user?.name ?? r.user?.id ?? "Session replay",
        detail: r.counts.errors ? `${r.counts.errors} errors` : `${r.counts.clicks} clicks`, replay: r.short_id,
      });
    }
    for (const d of deploys.rows) {
      events.push({
        _id: `deploy:${d._id}`, workspace: ws, at: d.live_at ?? d.created_at, kind: "deploy", source: d.source ?? "line",
        ...(d.project_id ? { project_id: String(d.project_id) } : {}),
        title: d.target, detail: d.status, deploy: d.short_id,
      });
    }
    events.sort((a, b) => b.at - a.at);
    return { events, cutoff, workspace: ws };
  },
});
