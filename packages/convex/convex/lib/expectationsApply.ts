// Applying an expectations proposal (docs/architecture/the-line-model.md LM5),
// shared by the three ways one lands: on its own (it only adds lines in a
// person's own quoted words), by a person at the CLI, and by a person
// answering its card. A leaf
// module: sessionDecisions calls the card half from the one settle path every
// answer takes, so it imports nothing that imports sessionDecisions.
import type { Id } from "../_generated/dataModel";
import { applyOps, expectationPrefix } from "@codecast/shared/contracts/expectations";

type Ctx = { db: any };

/** The card's two answers, in order; Apply is index 0. */
export const EXPECTATION_CARD_OPTIONS = ["Apply", "Drop"] as const;

/** The project's current document: its highest version, or null before version 1. */
export async function latestExpectations(ctx: Ctx, projectId: Id<"projects">): Promise<any | null> {
  return await ctx.db.query("project_expectations").withIndex("by_project_version", (q: any) => q.eq("project_id", projectId)).order("desc").first();
}

/** A prefix no other project in the workspace uses, so an id names one line. */
async function freePrefix(ctx: Ctx, workspace: string, title: string): Promise<string> {
  const base = expectationPrefix(title);
  for (let n = 1; ; n++) {
    const prefix = n === 1 ? base : `${base}${n}`;
    const taken = await ctx.db.query("project_expectations").withIndex("by_workspace_prefix", (q: any) => q.eq("workspace", workspace).eq("prefix", prefix)).first();
    if (!taken) return prefix;
  }
}

/**
 * Apply an open proposal onto the current document as a new version, applied
 * by `userId`. Refuses, and leaves the proposal open with the reason, when the
 * document moved under it in a way that touches its changes.
 */
export async function performApply(ctx: Ctx, proposal: any, userId: Id<"users">, how: "person" | "auto", now: number): Promise<{ ok: true; version: number } | { ok: false; error: string }> {
  if (proposal.status !== "open") return { ok: false, error: `${proposal.short_id} is ${proposal.status}` };
  const project = await ctx.db.get(proposal.project_id);
  if (!project) return { ok: false, error: "The project is gone" };
  const latest = await latestExpectations(ctx, project._id);
  const version = (latest?.version ?? 0) + 1;
  const prefix = latest?.prefix ?? (await freePrefix(ctx, proposal.workspace, project.title));
  const result = applyOps({ items: latest?.items ?? [], prefix, next_n: latest?.next_n ?? 1 }, proposal.ops, version, proposal.base_version);
  if (!result.ok) {
    const error = result.errors.join("\n");
    await ctx.db.patch(proposal._id, { refused: error, updated_at: now });
    return { ok: false, error };
  }
  await ctx.db.insert("project_expectations", {
    project_id: project._id,
    user_id: userId,
    team_id: proposal.team_id,
    workspace: proposal.workspace,
    version,
    prefix,
    next_n: result.next_n,
    items: result.items,
    summary: proposal.summary,
    how,
    proposal_id: proposal._id,
    created_at: now,
  });
  await ctx.db.patch(proposal._id, { status: "applied", applied_version: version, resolved_by: userId, resolved_at: now, refused: undefined, updated_at: now });
  return { ok: true, version };
}

/**
 * A person answered a proposal's card: Apply lands it, Drop or a dismissal
 * closes it. Only a person's answer applies (LM5: the project's person decides
 * what changes a line); a withdrawal, or an answer by anyone else, leaves it.
 */
export async function settleExpectationCard(
  ctx: Ctx,
  row: { _id: Id<"session_decisions"> },
  verdict: { status: string; answer_index?: number },
  by: { kind: string; user_id?: Id<"users"> },
  now: number,
): Promise<void> {
  const proposal = await ctx.db.query("expectation_proposals").withIndex("by_decision", (q: any) => q.eq("decision_id", row._id)).first();
  if (!proposal || proposal.status !== "open" || by.kind !== "user" || !by.user_id) return;
  if (verdict.status === "answered" && verdict.answer_index === 0) {
    await performApply(ctx, proposal, by.user_id, "person", now);
    return;
  }
  if (verdict.status === "answered" || verdict.status === "dismissed") {
    await ctx.db.patch(proposal._id, { status: "dropped", resolved_by: by.user_id, resolved_at: now, updated_at: now });
  }
}
