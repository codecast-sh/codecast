// Grouping findings into problems by what happened (docs/architecture/
// learning-loop.md LL9), for products that bring moments. A codecast judge's
// finding says in words what happened against which expectation. Grouping
// embeds those words and looks for the open problems whose findings of the
// same expectation read the same: one close enough joins it outright, a few
// near ones go to the attach judge (signals.ts) to decide, and none opens a
// new problem. Products that bring findings keep their own issue keys and
// never come here.
//
// The embedding and any judge call are charged to the team's model budget as
// grouping; with no room, a finding groups only by its key.

import { v } from "convex/values";
import { internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { resolveWorkspaceProject } from "./lib/projectRef";
import { embedText, embeddingWorstCase } from "./lib/embeddings";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import type { CallScope } from "./modelCalls";

/**
 * Cosine similarity of two findings' words (text-embedding-3-small). At or
 * above `attach` they say the same thing in other words and join without a
 * question; from `ask` up they are near enough for the attach judge to
 * decide; below, they are different problems.
 */
export const GROUPING = { attach: 0.86, ask: 0.6, hits: 16, candidates: 5 } as const;

export type ScoredCandidate = {
  task_id: Id<"tasks">;
  short_id: string;
  title: string;
  subjects: string[];
  signal_count: number;
  score: number;
};

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
  },
  handler: async (ctx, args): Promise<ScoredCandidate[]> => {
    const best = new Map<string, { task: Doc<"tasks">; score: number; subjects: Set<string> }>();
    for (const hit of args.hits) {
      const row = await ctx.db.get(hit.id);
      const signal = row ? await ctx.db.get(row.signal_id) : null;
      if (!signal?.task_id || signal.workspace !== args.workspace) continue;
      const key = String(signal.task_id);
      const seen = best.get(key);
      if (seen) {
        if (signal.subject) seen.subjects.add(signal.subject);
        seen.score = Math.max(seen.score, hit.score);
        continue;
      }
      const task = await ctx.db.get(signal.task_id);
      if (!task || task.workspace !== args.workspace || isTerminalTaskStatus(task.status)) continue;
      if (args.project_id && task.project_id !== args.project_id) continue;
      best.set(key, { task, score: hit.score, subjects: new Set(signal.subject ? [signal.subject] : []) });
    }
    return [...best.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, GROUPING.candidates)
      .map(({ task, score, subjects }) => ({
        task_id: task._id,
        short_id: task.short_id,
        title: task.title,
        subjects: [...subjects],
        signal_count: task.cause?.signal_count ?? 0,
        score,
      }));
  },
});

/**
 * The finding's embedding and the open problems whose findings of the same
 * expectation read most like it. Empty when the budget has no room or the
 * embedding fails; the finding then groups by its key alone.
 */
export async function similarCandidates(
  ctx: { runQuery: any; runMutation: any; vectorSearch: any },
  filer: { api_token: string } | { user_id: Id<"users"> },
  signal: { similar_text?: string; subject?: string },
  scope: Record<string, unknown>,
): Promise<{ scope: CallScope | null; vector?: number[]; candidates: ScoredCandidate[] }> {
  if (!signal.similar_text || !signal.subject) return { scope: null, candidates: [] };
  const where: CallScope & { project_id?: Id<"projects"> } = await ctx.runQuery(internal.findingGroups.scopeOf, { ...filer, ...scope });
  const held = embeddingWorstCase(signal.similar_text);
  const room: boolean = await ctx.runMutation(internal.modelCalls.reserve, { workspace: where.workspace, team_id: where.team_id, amount: held });
  if (!room) return { scope: where, candidates: [] };
  let embedded: Awaited<ReturnType<typeof embedText>> = null;
  try {
    embedded = await embedText(signal.similar_text);
  } finally {
    await ctx.runMutation(internal.modelCalls.settle, { workspace: where.workspace, purpose: "grouping", held, cost: embedded?.cost_usd ?? 0 });
  }
  if (!embedded) return { scope: where, candidates: [] };
  const hits: Array<{ _id: Id<"signal_vectors">; _score: number }> = await ctx.vectorSearch("signal_vectors", "by_embedding", {
    vector: embedded.vector,
    limit: GROUPING.hits,
    filter: (q: any) => q.eq("scope", vectorScope(where.workspace, signal.subject!)),
  });
  const candidates: ScoredCandidate[] = hits.length
    ? await ctx.runQuery(internal.findingGroups.causesForHits, { workspace: where.workspace, project_id: where.project_id, hits: hits.map((h) => ({ id: h._id, score: h._score })) })
    : [];
  return { scope: where, vector: embedded.vector, candidates };
}

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
