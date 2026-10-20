// Grouping findings into problems by what happened (docs/architecture/
// learning-loop.md LL9), for products that bring moments. A codecast judge's
// finding says in words what happened against which expectation. Grouping
// embeds those words and looks for the open problems (and the ones a line run
// dissolved: for evidence from before their fix, or from after it, which
// reopens them) whose findings of the same expectation read the same: one close enough joins it outright, a few
// near ones go to the attach judge (signals.ts) to decide, and none opens a
// new problem. Products that bring findings keep their own issue keys and
// never come here.
//
// The embedding and any judge call are charged to the team's model budget as
// grouping; with no room, a finding groups only by its key.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { embedText, embeddingWorstCase } from "./lib/embeddings";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { withinBudget, type CallScope } from "./modelCalls";
import { latestExpectations } from "./lib/expectationsApply";

/**
 * Cosine similarity of two findings' words (text-embedding-3-small). At or
 * above `attach` they say the same thing in other words and join without a
 * question; from `ask` up they are near enough for the attach judge to
 * decide; below, they are different problems. Measured on the AgentWatch
 * trial (pl-882): two findings of one plain miss under one expectation (a fee
 * answered as free, a cold email claiming a buyer Union lacks) scored 0.41 to
 * 0.89, median about 0.6, because each tells one person's story; `ask` sits
 * under that floor so the judge, not the cosine, tells near misses apart.
 * Checked against AgentWatch's clusters on 138 shared findings (ct-59219):
 * an adversarial panel preferred this grouping on most disagreeing pairs,
 * and moving `attach` between 0.75 and 0.92 or `ask` to 0.35 or 0.55 changed
 * less than the order findings arrive in does (about 10 points of agreement).
 * `hits` is wide because most of an expectation's findings are withdrawn
 * over time (334 of 406 under one trial expectation, 2026-10-12): sixteen
 * nearest hits left the problems of the live ones out of reach.
 *
 * Grouping stays inside one expectation. Offering the attach judge the
 * nearest problems under the project's OTHER lines was measured and left out
 * of filing (pl-882, clustering round 22; signals.regroupProbe `cross` still
 * asks that way): of 156 live findings the judge sent 4 to another line's
 * problem, each a different defect on reading, and the three pairs a person
 * had asked to see together (an open checkpoint and a callback handed back; a
 * prior decline and a pitch after a no) it kept apart every time.
 */
export const GROUPING = { attach: 0.86, ask: 0.45, hits: 64, candidates: 5, cross_ask: 0.5, cross_candidates: 3 } as const;

export type ScoredCandidate = {
  task_id: Id<"tasks">;
  short_id: string;
  title: string;
  subjects: string[];
  signal_count: number;
  score: number;
  /** Reached through another expectation's findings (nearCauses with `cross`): the attach judge decides, never the score. */
  cross?: boolean;
  /** Set on a problem a line run closed without a change: why. */
  closed?: string;
  /** Its first standing findings (sampleFindings). */
  findings?: Array<{ what: string; quote?: string }>;
};

/** How many of a problem's findings the attach judge reads beside its title. */
const SAMPLE_FINDINGS = 3;

/**
 * What a problem holds, as the attach judge reads it: its first standing
 * findings, each what happened and the line it quoted. A title is one run's
 * reading and narrows as the run works ("Callback contacts hear a stranger"
 * over 65 calls whose callers never named the persona), so the judge turned
 * away same-mechanism findings from it and opened problems beside it. The
 * first findings rather than the nearest: nearest members make every
 * candidate under one expectation read like the new finding. Measured on the
 * call intake (pl-882, clustering round 18, 6 reps): call findings judged
 * into their right home 90 of 114 to 110 of 114; the email controls under
 * one expectation 65 to 63 of 84 (not separated).
 */
export async function sampleFindings(ctx: { db: any }, taskId: Id<"tasks">): Promise<Array<{ what: string; quote?: string }>> {
  const rows: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", taskId)).take(SAMPLE_FINDINGS * 4);
  return rows
    .filter(standsAsEvidence)
    .slice(0, SAMPLE_FINDINGS)
    .map((row) => {
      const quote = (row.detail_md ?? "").split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").trim().slice(0, 200);
      return { what: row.title, ...(quote ? { quote } : {}) };
    });
}

/**
 * Why a line closed this problem without a change (`cast line dissolve`:
 * already fixed, the judge misread, another task owns the fix), or null for
 * any other problem.
 */
export function dissolvedReason(task: Doc<"tasks">): string | null {
  if (!isTerminalTaskStatus(task.status) || !task.cause?.dissolved) return null;
  return task.cause.dissolved.note.replace(/\s+/g, " ").trim().slice(0, 400) || "no reason recorded";
}

/**
 * Whether a closed problem still takes a finding: one a line run dissolved
 * keeps the evidence its reason already answers, so the same messages read
 * again do not open a fresh problem and a fresh run. That is evidence from
 * before the fix it named went live (`fixed_at`), else from before the line
 * closed it. Later evidence is a recurrence (recursAfterFix) or goes where it
 * would without the problem.
 */
export function absorbsFinding(task: Doc<"tasks">, observedAt: number | undefined): string | null {
  const dissolved = task.cause?.dissolved;
  const until = dissolved ? dissolved.fixed_at ?? dissolved.at : undefined;
  if (observedAt === undefined || !until || observedAt > until) return null;
  return dissolvedReason(task);
}

/**
 * Whether a finding shows a dissolved problem's fix did not hold: a line
 * closed it as fixed when a change went live (`fixed_at`), and this evidence
 * is from after. It reopens that problem (signals.ts reopenAfterFix) rather
 * than sitting in it closed or opening a second problem beside it.
 */
export function recursAfterFix(task: Doc<"tasks">, observedAt: number | undefined): boolean {
  const fixed = task.cause?.dissolved?.fixed_at;
  return isTerminalTaskStatus(task.status) && !!fixed && observedAt !== undefined && observedAt > fixed;
}

/** Every reason closeRetireReason writes starts so; lib/problemEvidence.fateOf and judgeRetire.refound read it. */
export const CLOSED_WITH = /^closed with (ct-\d+)(, from before its fix| for coaching|: dropped)?/;

/** How a finding's reason opens when the moment it read came before its line was in force (judgeRetire.settleRun): history, read so by lib/problemEvidence.fateOf. */
export const BEFORE_LINE = "from before its line was in force:";

/**
 * Why a closed problem's findings leave it (LL13): a problem a line dissolved
 * decided its outcome, so what it still holds is no longer live. Evidence from
 * before its fix is history; a coaching close hands it to the role that
 * coaches; a drop closes it. Null for an open problem, or one a line did not
 * dissolve (a shipped fix in watch keeps its findings).
 */
export function closeRetireReason(task: Pick<Doc<"tasks">, "status" | "short_id" | "cause">): string | null {
  const d = task.cause?.dissolved;
  if (!d || !isTerminalTaskStatus(task.status)) return null;
  if (d.coaching) return `closed with ${task.short_id} for coaching by ${d.coaching.owner}`;
  if (task.status === "dropped") return `closed with ${task.short_id}: dropped`;
  const live = d.fixed_at ? ` live ${new Date(d.fixed_at).toISOString().slice(0, 10)}` : "";
  return `closed with ${task.short_id}, from before its fix${live}`;
}

/**
 * Retire what a closed problem holds (all of it, or `only` these rows): each
 * keeps the problem in `retired.task_id`, so grouping still reads it as that
 * problem's evidence (causesForHits) and a re-judge finding it again files no
 * copy (judgeRetire.refound), while counts, the dispatcher and the trial lanes
 * read only live findings on open problems. How many it retired.
 */
export async function retireOnClose(ctx: { db: any }, task: Doc<"tasks">, now: number, only?: Array<Id<"signals">>): Promise<number> {
  const reason = closeRetireReason(task);
  if (!reason) return 0;
  const held: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  const pick = only ? new Set(only.map(String)) : null;
  const rows = held.filter((r) => !pick || pick.has(String(r._id)));
  for (const r of rows) await ctx.db.patch(r._id, { task_id: undefined, retired: { at: now, reason, task_id: task._id } });
  if (rows.length && task.cause) await ctx.db.patch(task._id, { cause: { ...task.cause, signal_count: held.length - rows.length }, updated_at: now });
  return rows.length;
}

/** A finding that still stands as evidence: not withdrawn, merged into another key, marked wrong, or a case against a judge. */
export const standsAsEvidence = (row: Doc<"signals">) => !row.retired && !row.merged_into && !row.case_of && !row.judge_review;

/**
 * Whether a judge's finding came from the version of its judge that is
 * published now. One from an older version is due to be judged again, which
 * may withdraw it (judgeRetire), so it is no ground to pull another finding
 * after it. A finding without a judge or a moment is current.
 */
export async function judgedByCurrentVersion(ctx: { db: any }, row: Doc<"signals">, published = new Map<string, string | null>()): Promise<boolean> {
  if (!row.judge || !row.moment || !row.judge_version) return true;
  const key = `${row.moment}|${row.judge}`;
  if (!published.has(key)) {
    const moment: Doc<"moments"> | null = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", row.moment)).first();
    const judge: Doc<"judges"> | null = moment
      ? await ctx.db.query("judges").withIndex("by_source_name", (q: any) => q.eq("source_id", moment.source_id).eq("name", row.judge)).first()
      : null;
    published.set(key, judge && !judge.removed_at ? judge.version : null);
  }
  const version = published.get(key);
  return !version || version === row.judge_version;
}

/** The vector filter's one equality: findings group only with findings of the same expectation in the same workspace. */
export const vectorScope = (workspace: string, subject: string) => `${workspace}|${subject}`;

export const scopeOf = internalQuery({
  args: {
    api_token: v.optional(v.string()),
    user_id: v.optional(v.id("users")),
    workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))),
    team_id: v.optional(v.id("teams")),
    project_path: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    project: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<CallScope & { project_id?: Id<"projects"> }> => {
    const userId = args.user_id ?? (await verifyApiToken(ctx, args.api_token ?? ""))?.userId;
    if (!userId) throw new Error("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId, workspace: args.workspace, team_id: args.team_id, project_path: args.project_path, conversation_id: args.conversation_id });
    const project = await resolveWorkspaceProject(ctx, db.workspaceKey, args.project);
    return { workspace: db.workspaceKey, ...(db.axes.team_id ? { team_id: db.axes.team_id } : {}), ...(project ? { project_id: project._id } : {}) };
  },
});

/** The open problems the nearest findings reached, best score per problem, best first. */
export const causesForHits = internalQuery({
  args: {
    workspace: v.string(),
    project_id: v.optional(v.id("projects")),
    hits: v.array(v.object({ id: v.id("signal_vectors"), score: v.number() })),
    // When the finding was observed: a dissolved problem is a candidate for the evidence it answers, or that reopens it.
    observed_at: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ScoredCandidate[]> => {
    const best = new Map<string, { task: Doc<"tasks">; score: number; subjects: Set<string>; closed?: string }>();
    for (const hit of args.hits) {
      const row = await ctx.db.get(hit.id);
      const signal = row ? await ctx.db.get(row.signal_id) : null;
      // A withdrawn finding still speaks for the problem it was on (retired.task_id):
      // a problem in review whose findings a newer judge withdrew keeps its card
      // and stays the home of what reads the same, rather than vanishing from the
      // candidates and leaving the next such finding to open a problem beside it.
      const taskId = signal?.task_id ?? signal?.retired?.task_id;
      if (!signal || !taskId || signal.merged_into || signal.case_of || signal.workspace !== args.workspace) continue;
      const key = String(taskId);
      const seen = best.get(key);
      if (seen) {
        if (signal.subject) seen.subjects.add(signal.subject);
        seen.score = Math.max(seen.score, hit.score);
        continue;
      }
      const task = await ctx.db.get(taskId);
      if (!task || task.workspace !== args.workspace) continue;
      // A recurrence reads as an open problem: attaching it reopens the problem.
      const closed = isTerminalTaskStatus(task.status) && !recursAfterFix(task, args.observed_at) ? absorbsFinding(task, args.observed_at) : undefined;
      if (closed === null) continue;
      if (args.project_id && task.project_id !== args.project_id) continue;
      best.set(key, { task, score: hit.score, subjects: new Set(signal.subject ? [signal.subject] : []), ...(closed ? { closed } : {}) });
    }
    const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, GROUPING.candidates);
    const out: ScoredCandidate[] = [];
    for (const { task, score, subjects, closed } of top) {
      const findings = await sampleFindings(ctx, task._id);
      out.push({
        task_id: task._id,
        short_id: task.short_id,
        title: task.title,
        subjects: [...subjects],
        signal_count: task.cause?.signal_count ?? 0,
        score,
        ...(closed ? { closed } : {}),
        ...(findings.length ? { findings } : {}),
      });
    }
    return out;
  },
});

/** The vector scopes of a project's other active expectations: where a cross-expectation search looks. */
export const otherScopes = internalQuery({
  args: { workspace: v.string(), project_id: v.id("projects"), subject: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const doc = await latestExpectations(ctx, args.project_id);
    return (doc?.items ?? [])
      .filter((e: { id: string; status?: string }) => e.status !== "retired" && e.id !== args.subject)
      .map((e: { id: string }) => vectorScope(args.workspace, e.id));
  },
});

/**
 * The open problems a finding's words reach under its own expectation
 * (`same`, best first) and, when `cross` is asked for (a probe; see GROUPING),
 * under the project's other expectations, leaving out any problem `same`
 * already holds. One search per side, so a line with hundreds of findings
 * cannot crowd the other lines out.
 */
export async function nearCauses(
  ctx: { runQuery: any; vectorSearch: any },
  where: { workspace: string; project_id?: Id<"projects"> },
  finding: { vector: number[]; subject: string; observed_at?: number },
  opts: { cross?: boolean } = {},
): Promise<{ same: ScoredCandidate[]; cross: ScoredCandidate[] }> {
  const reach = async (filter: (q: any) => any): Promise<ScoredCandidate[]> => {
    const hits: Array<{ _id: Id<"signal_vectors">; _score: number }> = await ctx.vectorSearch("signal_vectors", "by_embedding", { vector: finding.vector, limit: GROUPING.hits + 1, filter });
    return hits.length
      ? await ctx.runQuery(internal.findingGroups.causesForHits, { workspace: where.workspace, project_id: where.project_id, observed_at: finding.observed_at, hits: hits.map((h) => ({ id: h._id, score: h._score })) })
      : [];
  };
  const same = await reach((q) => q.eq("scope", vectorScope(where.workspace, finding.subject)));
  const scopes: string[] = opts.cross && where.project_id ? await ctx.runQuery(internal.findingGroups.otherScopes, { workspace: where.workspace, project_id: where.project_id, subject: finding.subject }) : [];
  if (!scopes.length) return { same, cross: [] };
  const held = new Set(same.map((c) => c.short_id));
  const cross = (await reach((q) => q.or(...scopes.map((scope) => q.eq("scope", scope)))))
    .filter((c) => !held.has(c.short_id) && !c.subjects.includes(finding.subject) && c.score >= GROUPING.cross_ask)
    .slice(0, GROUPING.cross_candidates)
    .map((c) => ({ ...c, cross: true }));
  return { same, cross };
}

/** The candidates the attach judge reads: the near ones of the finding's own expectation, then the other lines'. */
export const askCandidates = (near: { same: ScoredCandidate[]; cross: ScoredCandidate[] }): ScoredCandidate[] => [...near.same.filter((c) => c.score >= GROUPING.ask), ...near.cross];

/**
 * The finding's embedding and the open problems whose findings of the same
 * expectation read most like it. Empty when the budget has no room or the
 * embedding fails; the finding then groups by its key alone.
 */
export async function similarCandidates(
  ctx: { runQuery: any; runMutation: any; vectorSearch: any; scheduler: any },
  filer: { api_token: string } | { user_id: Id<"users"> },
  signal: { similar_text?: string; subject?: string; observed_at?: number },
  scope: Record<string, unknown>,
): Promise<{ scope: CallScope | null; vector?: number[]; candidates: ScoredCandidate[] }> {
  if (!signal.similar_text || !signal.subject) return { scope: null, candidates: [] };
  const where: CallScope & { project_id?: Id<"projects"> } = await ctx.runQuery(internal.findingGroups.scopeOf, { ...filer, ...scope });
  const embedded = await embedFinding(ctx, where, signal.similar_text);
  if (!embedded) return { scope: where, candidates: [] };
  const near = await nearCauses(ctx, where, { vector: embedded.vector, subject: signal.subject, observed_at: signal.observed_at });
  return { scope: where, vector: embedded.vector, candidates: near.same };
}

/** Embed a finding's words inside the team's grouping budget; null when there is no room or the embedding fails. */
export async function embedFinding(ctx: { runMutation: any; scheduler: any }, scope: CallScope, text: string) {
  const spent = await withinBudget(ctx, scope, "grouping", embeddingWorstCase(text), async (charge) => {
    const result = await embedText(text);
    charge(result?.cost_usd ?? 0);
    return result;
  });
  return spent.room ? spent.value : null;
}

/**
 * A finding that took a newer judge's words (judgeRetire.refound) is grouped
 * against by those words from now on: its kept embedding is replaced. Its
 * problem stays. False when the budget had no room or the embedding failed.
 */
export async function reembedFinding(ctx: { runMutation: any; scheduler: any }, scope: CallScope, finding: { signal_id: Id<"signals">; subject: string; text: string }): Promise<boolean> {
  const embedded = await embedFinding(ctx, scope, finding.text);
  if (!embedded) return false;
  await ctx.runMutation(internal.findingGroups.replaceVector, { workspace: scope.workspace, subject: finding.subject, signal_id: finding.signal_id, embedding: embedded.vector });
  return true;
}

export const replaceVector = internalMutation({
  args: { workspace: v.string(), subject: v.string(), signal_id: v.id("signals"), embedding: v.array(v.float64()) },
  handler: async (ctx, args) => {
    for (const old of await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", args.signal_id)).collect()) await ctx.db.delete(old._id);
    await ctx.db.insert("signal_vectors", { workspace: args.workspace, scope: vectorScope(args.workspace, args.subject), signal_id: args.signal_id, embedding: args.embedding });
  },
});

/**
 * After the commit, in its transaction: a problem grouping named reads as
 * attached by similarity, and the finding's embedding is kept for the next.
 */
export async function keepSimilarity<R extends { signal_id: Id<"signals">; attach: string }>(
  ctx: { db: any },
  workspace: string,
  signal: { subject?: string },
  result: R,
  args: { similar?: boolean; vector?: number[] },
): Promise<R> {
  let out = result;
  if (args.similar && result.attach === "judge") {
    await ctx.db.patch(result.signal_id, { attach: "similar" });
    out = { ...result, attach: "similar" };
  }
  if (args.vector?.length && signal.subject) {
    await ctx.db.insert("signal_vectors", { workspace, scope: vectorScope(workspace, signal.subject), signal_id: result.signal_id, embedding: args.vector });
  }
  return out;
}

export type ProbeInputs = {
  signal_id: Id<"signals">;
  short_id: string;
  fingerprint: string;
  source: string;
  kind: Doc<"signals">["kind"];
  title: string;
  subject: string;
  detail_md?: string;
  observed_at: number;
  task_short_id: string | null;
  task_id: Id<"tasks"> | null;
  project_id: Id<"projects"> | null;
  team_id: Id<"teams"> | null;
  embedding: number[] | null;
};

/** What a regroup probe needs of one finding: its words, its kept embedding, and where it sits. */
export const probeInputs = internalQuery({
  args: { workspace: v.string(), signal: v.string() },
  handler: async (ctx, args): Promise<ProbeInputs | null> => {
    const row: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", args.signal)).first();
    if (!row || row.workspace !== args.workspace || !row.subject) return null;
    const kept = await ctx.db.query("signal_vectors").withIndex("by_signal", (q: any) => q.eq("signal_id", row._id)).first();
    const task: Doc<"tasks"> | null = row.task_id ? await ctx.db.get(row.task_id) : null;
    return {
      signal_id: row._id,
      short_id: row.short_id,
      fingerprint: row.fingerprint,
      source: row.source,
      kind: row.kind,
      title: row.title,
      subject: row.subject,
      detail_md: row.detail_md,
      observed_at: row.observed_at,
      task_short_id: task?.short_id ?? null,
      task_id: row.task_id ?? null,
      project_id: task?.project_id ?? row.project_id ?? null,
      team_id: row.team_id ?? null,
      embedding: kept?.embedding ?? null,
    };
  },
});
