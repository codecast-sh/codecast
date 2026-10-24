// Agent review repairs: the run.sh tools that re-file, relist and retire an
// agent judge's findings after the fact, and count what it filed
// (agentReviews.ts files them the first time).

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { sourceFilingScope } from "./lib/ingestScope";
import { retireSignals } from "./judgeRetire";
import { embedFinding } from "./findingGroups";
import { firstSentence } from "@codecast/shared/contracts/judges";
import { agentFindingSignal, agentSimilarText, parseAgentFindings, type AgentFinding } from "@codecast/shared/contracts/agentJudges";

/**
 * Findings an agent judge filed while no line profile let its source open
 * problems (signals.opensCause) sit held. Once a profile declares the finder,
 * this files each again through the door, where grouping places it, and
 * retires the held copy; the run that filed it points at the new one. One page
 * per call (run with packages/convex/run.sh); `left` says whether to call again.
 */
export const refileHeld = internalAction({
  // unembedded: the live findings that were filed with no words to group by (no kept embedding), which grouping never placed.
  args: { workspace: v.string(), judge: v.string(), limit: v.optional(v.number()), unembedded: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ refiled: number; left: boolean; tasks: string[] }> => {
    const page: Array<Doc<"signals">> = await ctx.runQuery(internal.agentReviewsRepair.heldFindings, { workspace: args.workspace, judge: args.judge, limit: Math.min(args.limit ?? 25, 100), ...(args.unembedded ? { unembedded: true } : {}) });
    const tasks = new Set<string>();
    for (const row of page) {
      const source = await ctx.runQuery(internal.agentReviewsRepair.sourceOfMoment, { moment: row.moment ?? "" });
      if (!source) continue;
      await ctx.runMutation(internal.agentReviewsRepair.retireHeld, { signal_id: row._id, judge: args.judge, actor: source.owner_user_id, ...(args.unembedded ? { reason: "filed again with the words grouping compares, which its first filing lacked" } : {}) });
      const result = await ctx.runAction(internal.signals.ingestAs, {
        user_id: source.owner_user_id,
        source: row.source, kind: row.kind, fingerprint: row.fingerprint, title: row.title, subject: row.subject,
        ...(row.detail_md ? { detail_md: row.detail_md } : {}), ...(row.evidence_url ? { evidence_url: row.evidence_url } : {}),
        ...(row.judge ? { judge: row.judge } : {}), ...(row.judge_version ? { judge_version: row.judge_version } : {}),
        ...(typeof row.severity === "number" ? { severity: row.severity } : {}), ...(row.moment ? { moment: row.moment } : {}),
        // The words grouping compares are not kept on a signal: rebuilt from the run's finding of the same key.
        ...(await (async () => {
          const found: { subject: string; findings: AgentFinding[] } = await ctx.runQuery(internal.agentReviewsRepair.runFindings, { moment: row.moment ?? "", judge: args.judge });
          const f = found.findings.find((x) => agentFindingSignal(x, { judge: args.judge, judge_version: row.judge_version ?? "", moment: row.moment ?? "", subject: found.subject }).fingerprint === row.fingerprint);
          return f ? { similar_text: agentSimilarText(f) } : {};
        })()),
        observed_at: row.observed_at,
        ...(row.happened_after !== undefined ? { happened_after: row.happened_after } : {}),
        ...sourceFilingScope(source),
        ...(row.project_id ? { project: String(row.project_id) } : {}),
      });
      await ctx.runMutation(internal.agentReviewsRepair.repointRun, { old: row._id, signal_id: result.signal_id, moment: row.moment ?? "" });
      if (result.task_short_id) tasks.add(result.task_short_id);
    }
    return { refiled: page.length, left: page.length === Math.min(args.limit ?? 25, 100), tasks: [...tasks] };
  },
});

/** The findings an agent judge's newest run on a moment recorded, and the moment's subject. */
/**
 * One filed finding that named several causes, listed again one cause per
 * finding (the findings turn's own rule): each new finding files through the
 * door, where grouping places it, and the original retires naming the
 * findings it became. A relist of one item changes nothing. Run with
 * packages/convex/run.sh; `findings` is the relist's JSON reply.
 */
export const relistFinding = internalAction({
  args: { signal: v.string(), findings: v.string() },
  handler: async (ctx, args): Promise<{ signal: string; relisted: string[]; tasks: string[] }> => {
    const row: Doc<"signals"> | null = await ctx.runQuery(internal.agentReviewsRepair.signalByShortId, { signal: args.signal });
    if (!row || row.retired || row.merged_into || !row.source.startsWith("judge:") || !row.moment) throw new Error(`${args.signal} is not a live judge finding`);
    const findings = parseAgentFindings(args.findings) ?? [];
    if (findings.length < 2) return { signal: args.signal, relisted: [], tasks: [] };
    const moment = row.moment;
    const judge = row.subject ?? row.source.slice("judge:".length);
    const source = await ctx.runQuery(internal.agentReviewsRepair.sourceOfMoment, { moment });
    if (!source) throw new Error(`${row.moment} has no source`);
    const { subject } = await ctx.runQuery(internal.agentReviewsRepair.runFindings, { moment, judge });
    const relisted: string[] = [];
    const tasks = new Set<string>();
    for (const f of findings) {
      const signal = agentFindingSignal(f, { judge, judge_version: row.judge_version ?? "", moment, subject }, row.evidence_url);
      const result = await ctx.runAction(internal.signals.ingestAs, { user_id: source.owner_user_id, ...signal, observed_at: row.observed_at, ...(row.happened_after !== undefined ? { happened_after: row.happened_after } : {}), ...sourceFilingScope(source), ...(row.project_id ? { project: String(row.project_id) } : {}) });
      relisted.push(result.short_id);
      if (result.task_short_id) tasks.add(result.task_short_id);
    }
    await ctx.runMutation(internal.agentReviewsRepair.retireRelisted, { signal_id: row._id, into: relisted, actor: source.owner_user_id });
    return { signal: args.signal, relisted, tasks: [...tasks] };
  },
});

/**
 * A done review whose filing lost findings (a door error before the retry
 * existed), filed again (run with packages/convex/run.sh): its run record
 * goes, its findings wait on it again, and the filing skips the ones already
 * filed under their key, so only the missing ones are filed.
 */
export const refileReview = internalMutation({
  args: { review: v.string(), findings: v.string() },
  handler: async (ctx, args) => {
    const review = await ctx.db.query("agent_reviews").withIndex("by_short_id", (q: any) => q.eq("short_id", args.review)).first();
    if (!review || review.status !== "done" || !review.run_id) throw new Error(`${args.review} is not a filed review`);
    await ctx.db.delete(review.run_id);
    await ctx.db.patch(review._id, { run_id: undefined, filed: undefined, file: args.findings, updated_at: Date.now() });
    await ctx.scheduler.runAfter(0, internal.agentReviews.fileReview, { review_id: review._id });
  },
});

export const signalByShortId = internalQuery({
  args: { signal: v.string() },
  handler: async (ctx, args) => await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", args.signal)).first(),
});

export const retireRelisted = internalMutation({
  args: { signal_id: v.id("signals"), into: v.array(v.string()), actor: v.id("users") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.signal_id);
    if (row && !row.retired && !row.merged_into) await retireSignals(ctx, [row], { reason: `listed again one cause per finding: ${args.into.join(", ")}`, actor: args.actor });
  },
});

export const runFindings = internalQuery({
  args: { moment: v.string(), judge: v.string() },
  handler: async (ctx, args): Promise<{ subject: string; findings: AgentFinding[] }> => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    const runs: Doc<"judge_runs">[] = m ? (await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect()).filter((r: Doc<"judge_runs">) => r.judge === args.judge && r.status === "ok") : [];
    const findings: AgentFinding[] = runs.flatMap((r) => { try { return JSON.parse(r.findings_json ?? "[]"); } catch { return []; } });
    return { subject: m?.subject ?? "", findings };
  },
});

export const heldFindings = internalQuery({
  args: { workspace: v.string(), judge: v.string(), limit: v.number(), unembedded: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Doc<"signals">[]> => {
    const rows: Doc<"signals">[] = (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into);
    const out: Doc<"signals">[] = [];
    for (const r of rows) {
      if (out.length >= args.limit) break;
      if (!args.unembedded ? !r.task_id : !(await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", r._id)).first())) out.push(r);
    }
    return out;
  },
});

export const sourceOfMoment = internalQuery({
  args: { moment: v.string() },
  handler: async (ctx, args): Promise<Doc<"event_sources"> | null> => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    return m ? await ctx.db.get(m.source_id) : null;
  },
});

export const retireHeld = internalMutation({
  args: { signal_id: v.id("signals"), judge: v.string(), actor: v.id("users"), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.signal_id);
    if (row && !row.retired) await retireSignals(ctx, [row], { reason: args.reason ?? `filed again once judge:${args.judge} could open problems`, actor: args.actor });
  },
});

export const repointRun = internalMutation({
  args: { old: v.id("signals"), signal_id: v.id("signals"), moment: v.string() },
  handler: async (ctx, args) => {
    const m = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", args.moment)).first();
    if (!m) return;
    for (const r of await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect()) {
      if (r.signal_ids?.some((id) => id === args.old)) await ctx.db.patch(r._id, { signal_ids: r.signal_ids.map((id) => (id === args.old ? args.signal_id : id)) });
    }
  },
});

/**
 * Findings of one agent judge filed twice under one key (a hand back sent
 * again while the first was still filing, before settle became the one gate):
 * the first stands, the rest retire, and each run points at the one standing.
 */
export const retireDoubles = internalMutation({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into);
    const byKey = new Map<string, Doc<"signals">[]>();
    for (const r of rows) byKey.set(r.fingerprint, [...(byKey.get(r.fingerprint) ?? []), r]);
    const extra = [...byKey.values()].flatMap((rs) => rs.sort((a, b) => a.created_at - b.created_at).slice(1).map((r) => ({ r, keep: rs[0]! })));
    if (!extra.length) return { retired: 0 };
    const source = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q: any) => q.eq("workspace", args.workspace)).first();
    await retireSignals(ctx, extra.map((x) => x.r), { reason: "filed twice under one key; the first stands", actor: source!.owner_user_id });
    for (const { r, keep } of extra) {
      const m = r.moment ? await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", r.moment)).first() : null;
      for (const run of m ? await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect() : []) {
        if (run.signal_ids?.includes(r._id)) await ctx.db.patch(run._id, { signal_ids: [...new Set(run.signal_ids.map((id) => (id === r._id ? keep._id : id)))] });
      }
    }
    return { retired: extra.length };
  },
});

/**
 * What text an agent finding should be grouped by, measured (run with
 * packages/convex/run.sh): every live finding of the judge embedded once per
 * variant of its words, and for each pair a person judged the same problem,
 * where the partner ranks among the finding's nearest and at what cosine.
 * The embeddings are charged to the team's grouping budget.
 */
export const groupingProbe = internalAction({
  args: { workspace: v.string(), judge: v.string(), pairs: v.array(v.array(v.string())) },
  handler: async (ctx, args) => {
    const rows: Doc<"signals">[] = await ctx.runQuery(internal.agentReviewsRepair.liveFindings, { workspace: args.workspace, judge: args.judge });
    const byMoment = new Map<string, { subject: string; findings: AgentFinding[] }>();
    const items: Array<{ id: string; f: AgentFinding }> = [];
    for (const r of rows) {
      if (!r.moment) continue;
      if (!byMoment.has(r.moment)) byMoment.set(r.moment, await ctx.runQuery(internal.agentReviewsRepair.runFindings, { moment: r.moment, judge: args.judge }));
      const found = byMoment.get(r.moment)!;
      const f = found.findings.find((x) => agentFindingSignal(x, { judge: args.judge, judge_version: "", moment: r.moment!, subject: found.subject }).fingerprint === r.fingerprint);
      if (f) items.push({ id: r.short_id, f });
    }
    const variants: Record<string, (f: AgentFinding) => string> = {
      cause_first: agentSimilarText,
      problem: (f) => firstSentence(f.what),
      problem_then_cause: (f) => (f.cause ? `${firstSentence(f.what)}\n${f.cause}` : firstSentence(f.what)),
    };
    const scope = { workspace: args.workspace };
    const out: Record<string, unknown> = { findings: items.length };
    for (const [name, text] of Object.entries(variants)) {
      const vecs = new Map<string, number[]>();
      // One at a time: each settles the team's budget row, and side by side they conflict on it.
      for (const it of items) {
        const e = await embedFinding(ctx, scope, text(it.f));
        if (e) vecs.set(it.id, e.vector);
      }
      const cos = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0) / Math.sqrt(a.reduce((s, x) => s + x * x, 0) * b.reduce((s, x) => s + x * x, 0));
      const pairs = args.pairs.flatMap(([a, b]) => {
        const va = vecs.get(a!), vb = vecs.get(b!);
        if (!va || !vb) return [];
        const ranked = [...vecs.entries()].filter(([id]) => id !== a).map(([id, v]) => ({ id, c: cos(va, v) })).sort((x, y) => y.c - x.c);
        return [{ a, b, cos: Math.round(cos(va, vb) * 1000) / 1000, rank: ranked.findIndex((x) => x.id === b) + 1 }];
      });
      // How far apart findings of different problems sit: the mean of every finding's nearest other finding outside its pairs.
      out[name] = { pairs, mean_rank: pairs.reduce((s, p) => s + p.rank, 0) / Math.max(1, pairs.length), top5: pairs.filter((p) => p.rank <= 5).length, of: pairs.length };
    }
    return out;
  },
});

export const liveFindings = internalQuery({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args): Promise<Doc<"signals">[]> =>
    (await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).collect())
      .filter((r: Doc<"signals">) => r.source === `judge:${args.judge}` && !r.retired && !r.merged_into),
});

/**
 * Costs handed back before the machine read a resumed turn's cost as the
 * session's total so far (it reports the first turn's cost again): such a
 * review's notional_usd counted the first turn twice. With the findings
 * turn's figure (then that cumulative total) the session's cost is exactly
 * it; without, half the sum, short by half the findings turn (about 5 cents).
 * One page per call (run with packages/convex/run.sh).
 */
export const correctDoubledCosts = internalMutation({
  args: { before: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("agent_reviews").withIndex("by_status_created", (q: any) => q.eq("status", "done")).paginate({ cursor: args.cursor ?? null, numItems: 300 });
    let fixed = 0;
    for (const r of page.page as Doc<"agent_reviews">[]) {
      if (r.notional_usd == null || (r.finished_at ?? 0) >= args.before || r.cost_corrected) continue;
      const total = r.findings_turn_usd != null ? r.findings_turn_usd : r.notional_usd / 2;
      const turn = r.findings_turn_usd != null ? Math.max(0, 2 * r.findings_turn_usd - r.notional_usd) : undefined;
      await ctx.db.patch(r._id, { notional_usd: Math.round(total * 10_000) / 10_000, ...(turn !== undefined ? { findings_turn_usd: Math.round(turn * 10_000) / 10_000 } : {}), cost_corrected: true });
      fixed++;
    }
    return { fixed, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** An agent judge's filing so far, counted page by page (run with packages/convex/run.sh): live findings, the problems they sit in, held ones, keys filed twice. */
export const filingCounts = internalAction({
  args: { workspace: v.string(), judge: v.string() },
  handler: async (ctx, args) => {
    const tasks = new Set<string>();
    const keys = new Map<string, number>();
    let live = 0, held = 0, retired = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { rows: Array<{ task: string | null; key: string; retired: boolean }>; cursor: string | null } = await ctx.runQuery(internal.agentReviewsRepair.filingPage, { workspace: args.workspace, judge: args.judge, cursor });
      for (const r of page.rows) {
        if (r.retired) { retired++; continue; }
        live++;
        if (r.task) tasks.add(r.task); else held++;
        keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return { live, problems: tasks.size, held, retired, doubled: [...keys.values()].filter((n) => n > 1).length };
  },
});

export const filingPage = internalQuery({
  args: { workspace: v.string(), judge: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("signals").withIndex("by_workspace_subject", (q: any) => q.eq("workspace", args.workspace).eq("subject", args.judge)).paginate({ cursor: args.cursor, numItems: 400 });
    const rows = (page.page as Doc<"signals">[]).filter((r) => r.source === `judge:${args.judge}`).map((r) => ({ task: r.task_id ? String(r.task_id) : null, key: r.fingerprint, retired: !!r.retired || !!r.merged_into, at: r.created_at }));
    return { rows, cursor: page.isDone ? null : page.continueCursor };
  },
});

/** A bulk start's failed moments with why (run with packages/convex/run.sh), to retry once the cause is gone. */
export const failedMoments = internalQuery({
  args: { batch: v.string() },
  handler: async (ctx, args) =>
    (await ctx.db.query("moments").withIndex("by_status_due", (q: any) => q.eq("status", "failed")).collect())
      .filter((m: Doc<"moments">) => m.batch === args.batch)
      .map((m: Doc<"moments">) => ({ moment: m.short_id, subject: m.subject, error: (m.error ?? "").slice(0, 300) })),
});
