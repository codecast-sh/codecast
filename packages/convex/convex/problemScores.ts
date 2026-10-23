// Scoring and families of problems (docs/architecture/learning-loop.md LL15):
// a backfill that re-runs, driven with packages/convex/run.sh. `submit` sends
// the open problems an agent judge's findings reached and that hold no current
// score to the Batch API; `collect` writes the answers onto tasks.cause.scored
// once the batch has ended. `submitFamilies` / `collectFamilies` name the
// families of the root-cause labels; `submitAssign` / `collectAssign` place
// each label in one and write the cluster onto every problem carrying it.
// Writes touch cause.scored only: never a task's status, assignee or priority.

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { batchResults, createBatch, getBatch, modelCost, type ModelUsage } from "./lib/anthropic";
import {
  ASSIGN_SCHEMA,
  FAMILIES_SCHEMA,
  FAMILY_MODEL,
  PROBLEM_SCORE_SCHEMA,
  SCORE_MODEL,
  SCORE_VERSION,
  assignFamiliesPrompt,
  labelKey,
  parseAssignments,
  parseFamilies,
  parseProblemScore,
  problemFamiliesPrompt,
  problemScorePrompt,
  sampleFindings,
  type ProblemFamily,
} from "@codecast/shared/contracts/problemScore";

const ASSIGN_CHUNK = 250;
/**
 * Every task patch streams to each client of the team, so writes go in small
 * mutations with a pause between, one page per call; the caller calls again
 * from `next` until it is null.
 */
const WRITE_PAGE = 200;
const WRITE_CHUNK = 25;
const WRITE_PAUSE_MS = 2_000;

async function writePaced<T>(rows: T[], from: number, write: (chunk: T[]) => Promise<number>): Promise<{ written: number; of: number; next: number | null }> {
  const page = rows.slice(from, from + WRITE_PAGE);
  let written = 0;
  for (let i = 0; i < page.length; i += WRITE_CHUNK) {
    if (i) await new Promise((r) => setTimeout(r, WRITE_PAUSE_MS));
    written += await write(page.slice(i, i + WRITE_CHUNK));
  }
  return { written, of: rows.length, next: from + WRITE_PAGE < rows.length ? from + WRITE_PAGE : null };
}
/** A batch is billed at half the list price. */
const batchCost = (model: string, usage: ModelUsage) => modelCost(model, usage) / 2;

type Scored = NonNullable<NonNullable<Doc<"tasks">["cause"]>["scored"]>;

const isOpen = (t: Doc<"tasks">) => t.status === "open" && !t.cause?.merged_into && !t.cause?.dissolved;

/** Every problem the judge's live findings reach, by id. */
async function problemIds(ctx: any, workspace: string, judge: string): Promise<Id<"tasks">[]> {
  const ids = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: { rows: Array<{ task: string | null; retired: boolean }>; cursor: string | null } = await ctx.runQuery(internal.agentReviewsRepair.filingPage, { workspace, judge, cursor });
    for (const r of page.rows) if (r.task && !r.retired) ids.add(r.task);
    if (!page.cursor) break;
    cursor = page.cursor;
  }
  return [...ids] as Id<"tasks">[];
}

/** Each task's fields the pass reads: whether it is open, its ranking inputs today, and its score. */
export const brief = internalQuery({
  args: { ids: v.array(v.id("tasks")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const t = await ctx.db.get(id);
      if (!t) continue;
      out.push({
        id: String(t._id),
        short_id: t.short_id ?? null,
        title: t.title,
        open: isOpen(t),
        status: t.status,
        priority: t.priority ?? "none",
        signal_count: t.cause?.signal_count ?? 0,
        readiness: t.readiness ?? null,
        goal_ref: t.goal_ref ?? null,
        assignee: t.assignee ?? null,
        running: !!t.workflow_run_id,
        created_at: t.created_at ?? t._creationTime,
        scored: t.cause?.scored ?? null,
      });
    }
    return out;
  },
});

type Brief = Awaited<ReturnType<typeof readBriefs>>[number];

async function readBriefs(ctx: any, ids: Id<"tasks">[]) {
  const out: Array<{ id: string; short_id: string | null; title: string; open: boolean; status: string; priority: string; signal_count: number; readiness: string | null; goal_ref: string | null; assignee: string | null; running: boolean; created_at: number; scored: Scored | null }> = [];
  for (let i = 0; i < ids.length; i += 200) out.push(...(await ctx.runQuery(internal.problemScores.brief, { ids: ids.slice(i, i + 200) })));
  return out;
}

const openBriefs = async (ctx: any, workspace: string, judge: string): Promise<Brief[]> => (await readBriefs(ctx, await problemIds(ctx, workspace, judge))).filter((b) => b.open);

/**
 * How the open problems spread on what the line ranks them by today
 * (lib/linePriority: the goal, task.priority as severity, signal_count), so
 * the order they would run in is plain before anything is scored.
 */
export const spread = internalAction({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const open = await openBriefs(ctx, args.workspace, args.judge);
    const count = (f: (b: Brief) => string) => {
      const m: Record<string, number> = {};
      for (const b of open) m[f(b)] = (m[f(b)] ?? 0) + 1;
      return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
    };
    const bucket = (n: number) => (n <= 1 ? "1" : n <= 2 ? "2" : n <= 4 ? "3-4" : n <= 8 ? "5-8" : n <= 16 ? "9-16" : n <= 64 ? "17-64" : "65+");
    const ties = count((b) => `${b.goal_ref ?? "-"}|${b.priority}|${bucket(b.signal_count)}`);
    return {
      open: open.length,
      priority: count((b) => b.priority),
      signal_count: count((b) => bucket(b.signal_count)),
      readiness: count((b) => b.readiness ?? "-"),
      goal_ref: count((b) => b.goal_ref ?? "-"),
      largest_ties: Object.entries(ties).slice(0, 8),
      scored: open.filter((b) => b.scored).length,
    };
  },
});

/** The scorer's input for each problem: title, description, the counts and a sample of its live findings. */
export const inputs = internalQuery({
  args: { ids: v.array(v.id("tasks")) },
  handler: async (ctx, args) => {
    const out = [];
    for (const id of args.ids) {
      const t = await ctx.db.get(id);
      if (!t) continue;
      const rows = (await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", id)).collect()).filter((r: Doc<"signals">) => !r.retired && !r.merged_into);
      const moments = new Set<string>();
      for (const r of rows) for (const m of [r.moment, ...(r.held_by ?? [])]) if (m) moments.add(m);
      const sample = sampleFindings(rows.map((r: Doc<"signals">) => ({ detail: r.detail_md?.trim() || r.title, severity: r.severity ?? undefined, at: r.observed_at ?? r.created_at })));
      out.push({
        id: String(t._id),
        input: {
          title: t.title,
          description: t.description ?? "",
          finding_count: rows.length,
          conversation_count: Math.max(moments.size, rows.length ? 1 : 0),
          severities: rows.map((r: Doc<"signals">) => r.severity ?? 0).filter((s: number) => s > 0).sort((a: number, b: number) => b - a),
          sample: sample.map((s) => ({ detail: s.detail, ...(s.severity ? { severity: s.severity } : {}) })),
        },
      });
    }
    return out;
  },
});

/**
 * Sends up to `limit` open problems with no current score to the Batch API
 * (`rescore` takes scored ones too). Returns the batch id for `collect`.
 */
export const submit = internalAction({
  args: { workspace: v.string(), judge: v.string(), limit: v.number(), rescore: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const open = await openBriefs(ctx, args.workspace, args.judge);
    const due = open.filter((b) => args.rescore || !b.scored || b.scored.version !== SCORE_VERSION).slice(0, args.limit);
    if (!due.length) return { batch_id: null, count: 0, open: open.length };
    const requests: Array<{ custom_id: string; req: any }> = [];
    for (let i = 0; i < due.length; i += 50) {
      const rows: Array<{ id: string; input: any }> = await ctx.runQuery(internal.problemScores.inputs, { ids: due.slice(i, i + 50).map((b) => b.id as Id<"tasks">) });
      for (const r of rows) requests.push({ custom_id: r.id, req: { model: SCORE_MODEL, max_tokens: 6_000, effort: "low", prompt: problemScorePrompt(r.input), output_schema: PROBLEM_SCORE_SCHEMA } });
    }
    const batch = await createBatch(requests);
    return { batch_id: batch.id, count: requests.length, open: open.length };
  },
});

/** Writes scores onto causes. A new score drops the cluster, since its label may have changed. */
export const record = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("tasks"), scored: v.any() })) },
  handler: async (ctx, args) => {
    let written = 0;
    for (const r of args.rows) {
      const t = await ctx.db.get(r.id);
      if (!t?.cause) continue;
      await ctx.db.patch(t._id, { cause: { ...t.cause, scored: r.scored } });
      written++;
    }
    return written;
  },
});

/** Sums a batch's usage and prices it. */
function meter(model: string, results: Array<{ usage: ModelUsage | null }>) {
  const usage = results.reduce((s, r) => ({ input_tokens: s.input_tokens + (r.usage?.input_tokens ?? 0), output_tokens: s.output_tokens + (r.usage?.output_tokens ?? 0) }), { input_tokens: 0, output_tokens: 0 });
  const cost = batchCost(model, usage);
  return { ...usage, cost_usd: Math.round(cost * 10_000) / 10_000, per_request_usd: results.length ? Math.round((cost / results.length) * 100_000) / 100_000 : 0 };
}

/** Reads a scoring batch; once it has ended, writes one page of the scores it holds, from `from`. */
export const collect = internalAction({
  args: { batch_id: v.string(), from: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const state = await getBatch(args.batch_id);
    if (state.processing_status !== "ended") return { status: state.processing_status, counts: state.request_counts };
    const results = await batchResults(state);
    const at = Date.now();
    const rows: Array<{ id: Id<"tasks">; scored: Scored }> = [];
    const failed: Array<{ id: string; why: string }> = [];
    for (const r of results) {
      const score = r.text ? parseProblemScore(r.text) : null;
      if (!score) { failed.push({ id: r.custom_id, why: r.error ?? `unparsed (${r.stop_reason})` }); continue; }
      rows.push({ id: r.custom_id as Id<"tasks">, scored: { ...score, at, version: SCORE_VERSION } });
    }
    const page = await writePaced(rows, args.from ?? 0, (chunk): Promise<number> => ctx.runMutation(internal.problemScores.record, { rows: chunk }));
    return { status: "ended", ...page, failed: failed.length, failures: failed.slice(0, 10), ...meter(SCORE_MODEL, results) };
  },
});

/** The distinct root-cause labels on scored open problems, with how many carry each and which problems. */
async function labelsOf(ctx: any, workspace: string, judge: string) {
  const open = (await openBriefs(ctx, workspace, judge)).filter((b) => b.scored);
  const byLabel = new Map<string, { label: string; ids: string[] }>();
  for (const b of open) {
    const k = labelKey(b.scored!.root_cause);
    const e = byLabel.get(k) ?? { label: b.scored!.root_cause.trim(), ids: [] };
    e.ids.push(b.id);
    byLabel.set(k, e);
  }
  return { open, labels: [...byLabel.values()].sort((a, b) => b.ids.length - a.ids.length) };
}

/** One Opus call naming the families of every distinct label. */
export const submitFamilies = internalAction({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const { labels } = await labelsOf(ctx, args.workspace, args.judge);
    const prompt = problemFamiliesPrompt(labels.map((l) => ({ label: l.label, count: l.ids.length })));
    const batch = await createBatch([{ custom_id: "families", req: { model: FAMILY_MODEL, max_tokens: 64_000, effort: "medium", prompt, output_schema: FAMILIES_SCHEMA } }]);
    return { batch_id: batch.id, labels: labels.length };
  },
});

export const collectFamilies = internalAction({
  args: { batch_id: v.string() },
  handler: async (_ctx, args) => {
    const state = await getBatch(args.batch_id);
    if (state.processing_status !== "ended") return { status: state.processing_status };
    const results = await batchResults(state);
    const families = results[0]?.text ? parseFamilies(results[0].text) : null;
    return { status: "ended", families, error: families ? undefined : results[0]?.error ?? results[0]?.stop_reason, ...meter(FAMILY_MODEL, results) };
  },
});

/** The families already written on problems, for a re-run that places new labels in them. */
function writtenFamilies(open: Brief[]): ProblemFamily[] {
  const m = new Map<string, ProblemFamily>();
  for (const b of open) {
    const s = b.scored;
    if (s?.cluster_key && s.cluster_key !== "other" && !m.has(s.cluster_key)) m.set(s.cluster_key, { key: s.cluster_key, name: s.cluster_name ?? s.cluster_key, covers: "" });
  }
  return [...m.values()];
}

/**
 * Places labels in families, a few hundred per Opus call. With `families`
 * (from collectFamilies) every label is placed; without, only labels on
 * problems with no cluster, in the families already written.
 */
export const submitAssign = internalAction({
  args: { workspace: v.string(), judge: v.string(), families: v.optional(v.array(v.object({ key: v.string(), name: v.string(), covers: v.string() }))) },
  handler: async (ctx, args) => {
    const { open, labels } = await labelsOf(ctx, args.workspace, args.judge);
    const families = args.families ?? writtenFamilies(open);
    const unplaced = args.families ? labels : labels.filter((l) => l.ids.some((id) => !open.find((b) => b.id === id)?.scored?.cluster_key));
    if (!unplaced.length || !families.length) return { batch_id: null, labels: 0 };
    const requests = [];
    for (let i = 0; i < unplaced.length; i += ASSIGN_CHUNK) {
      const chunk = unplaced.slice(i, i + ASSIGN_CHUNK).map((l) => l.label);
      requests.push({ custom_id: `assign-${i / ASSIGN_CHUNK}`, req: { model: FAMILY_MODEL, max_tokens: 32_000, effort: "low" as const, prompt: assignFamiliesPrompt(families, chunk), output_schema: ASSIGN_SCHEMA } });
    }
    const batch = await createBatch(requests);
    return { batch_id: batch.id, labels: unplaced.length, requests: requests.length, families, chunks: unplaced.map((l) => l.label) };
  },
});

/** Writes a cluster onto problems, keeping their score. */
export const recordClusters = internalMutation({
  args: { rows: v.array(v.object({ id: v.id("tasks"), key: v.string(), name: v.string() })) },
  handler: async (ctx, args) => {
    let written = 0;
    for (const r of args.rows) {
      const t = await ctx.db.get(r.id);
      if (!t?.cause?.scored) continue;
      await ctx.db.patch(t._id, { cause: { ...t.cause, scored: { ...t.cause.scored, cluster_key: r.key, cluster_name: r.name } } });
      written++;
    }
    return written;
  },
});

/**
 * Reads an assignment batch; once it has ended, writes each label's family
 * onto every open problem carrying that label. `labels` and `families` are
 * what submitAssign returned (the labels in the order it chunked them).
 */
export const collectAssign = internalAction({
  args: { workspace: v.string(), judge: v.string(), batch_id: v.string(), from: v.optional(v.number()), labels: v.array(v.string()), families: v.array(v.object({ key: v.string(), name: v.string(), covers: v.string() })) },
  handler: async (ctx, args) => {
    const state = await getBatch(args.batch_id);
    if (state.processing_status !== "ended") return { status: state.processing_status, counts: state.request_counts };
    const results = await batchResults(state);
    const keyOf = new Map<string, string>();
    const failed: string[] = [];
    for (const r of results) {
      const n = Number(r.custom_id.replace("assign-", ""));
      const chunk = args.labels.slice(n * ASSIGN_CHUNK, (n + 1) * ASSIGN_CHUNK);
      const placed = r.text ? parseAssignments(r.text, args.families, chunk.length) : null;
      if (!placed) { failed.push(r.custom_id); continue; }
      chunk.forEach((label, i) => { const k = placed.get(i); if (k) keyOf.set(labelKey(label), k); });
    }
    const nameOf = new Map(args.families.map((f) => [f.key, f.name]));
    nameOf.set("other", "Other");
    const { labels } = await labelsOf(ctx, args.workspace, args.judge);
    const rows: Array<{ id: Id<"tasks">; key: string; name: string }> = [];
    for (const l of labels) {
      const key = keyOf.get(labelKey(l.label));
      if (!key) continue;
      for (const id of l.ids) rows.push({ id: id as Id<"tasks">, key, name: nameOf.get(key) ?? key });
    }
    const page = await writePaced(rows, args.from ?? 0, (chunk): Promise<number> => ctx.runMutation(internal.problemScores.recordClusters, { rows: chunk }));
    return { status: "ended", ...page, placed_labels: keyOf.size, failed, ...meter(FAMILY_MODEL, results) };
  },
});

/** The scored open problems for review: score, reason, cluster and title, highest first; and the clusters by size. */
export const report = internalAction({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const open = await openBriefs(ctx, args.workspace, args.judge);
    const scored = open.filter((b) => b.scored).sort((a, b) => b.scored!.score - a.scored!.score || b.signal_count - a.signal_count || a.created_at - b.created_at);
    const sizes = new Map<string, { key: string; name: string; size: number; top: number }>();
    for (const b of scored) {
      const key = b.scored!.cluster_key ?? "(none)";
      const e = sizes.get(key) ?? { key, name: b.scored!.cluster_name ?? key, size: 0, top: 0 };
      e.size++;
      e.top = Math.max(e.top, b.scored!.score);
      sizes.set(key, e);
    }
    const hist: Record<string, number> = {};
    for (const b of scored) { const k = `${Math.floor((b.scored!.score - 1) / 10) * 10 + 1}-${Math.floor((b.scored!.score - 1) / 10) * 10 + 10}`; hist[k] = (hist[k] ?? 0) + 1; }
    return {
      open: open.length,
      scored: scored.length,
      histogram: hist,
      clusters: sizes.size,
      largest: [...sizes.values()].sort((a, b) => b.size - a.size).slice(0, 25),
      rows: scored.map((b) => ({ short_id: b.short_id, score: b.scored!.score, h: b.scored!.harm, r: b.scored!.reach, f: b.scored!.fixability, signals: b.signal_count, reason: b.scored!.reason, root_cause: b.scored!.root_cause, cluster: b.scored!.cluster_key ?? null, title: b.title })),
    };
  },
});
