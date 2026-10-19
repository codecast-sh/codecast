// What stands behind a trial problem now (lineTrial.ts reads it for each
// card): its live findings, or how each one that left went and where.

import type { Doc, Id } from "../_generated/dataModel";
import { findingConversation } from "@codecast/shared/contracts/judges";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { parseMoveTally } from "./moveTally";
import { BEFORE_LINE, CLOSED_WITH } from "../findingGroups";
import { quoteOfDetail } from "../judgeRetire";

type Ctx = { db: any };

/** How a finding left its problem: judged again and not found, the same message as a finding kept elsewhere, found wrong by a fix run's proof, or moved. */
/** `history`, `coaching`, `closed`: retired when a line closed the problem it sat on (findingGroups.retireOnClose). */
export type FindingFate = "rejudged" | "duplicate" | "found_wrong" | "moved" | "history" | "coaching" | "closed" | "other";

/** A finding that left an emptied problem, and where it went: `to` names an open problem that holds it now. */
export type WithdrawnFinding = { short_id: string; title: string; quote?: string; at: number; fate: FindingFate; to?: string };

export type ProblemEvidence = { findings: number; conversations: number; withdrawn: number; moved_to: string[]; gone?: WithdrawnFinding[] };

const GONE_SHOWN = 20;

/** The fate a retire reason records (judgeRetire, findingKeyMerge, judgeReview), and the keeper a duplicate names. */
export function fateOf(reason: string): { fate: FindingFate; keeper?: string } {
  const dup = /^the same message as (sg-\d+)/.exec(reason);
  if (dup) return { fate: "duplicate", keeper: dup[1] };
  if (reason.startsWith(BEFORE_LINE)) return { fate: "history" };
  if (/^judged again\b/.test(reason)) return { fate: "rejudged" };
  if (/^found wrong\b/.test(reason)) return { fate: "found_wrong" };
  const closed = CLOSED_WITH.exec(reason);
  if (closed) return { fate: closed[2]?.startsWith(", from before") ? "history" : closed[2]?.startsWith(" for coaching") ? "coaching" : "closed" };
  return { fate: "other" };
}

/**
 * What stands behind a problem now, read live (a card's own count is frozen
 * when it is built): its findings and the conversations they come from.
 *
 * With none left, each finding that left says how it went, read from its own
 * record, never from what else was filed about the same contact: a re-judged
 * finding moved only when the same key (subject, expectation and message) is
 * live on another problem; a duplicate went to its keeper's problem; and
 * findings a person moved off after `since` (the card's build) went where the
 * problem's move note says. Only open problems count as where it went: one
 * that was dropped or closed holds nothing left to fix.
 */
export async function problemEvidence(ctx: Ctx, task: Doc<"tasks">, since?: number): Promise<ProblemEvidence> {
  const live: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", task._id)).collect();
  if (live.length) return { findings: live.length, conversations: new Set(live.map((s) => findingConversation({ ...s, _id: String(s._id) }))).size, withdrawn: 0, moved_to: [] };
  const tasks = new Map<string, Doc<"tasks"> | null>();
  const taskById = async (id: Id<"tasks">) => {
    if (!tasks.has(String(id))) tasks.set(String(id), await ctx.db.get(id));
    return tasks.get(String(id)) ?? null;
  };
  /** The open problem a finding sits on now, other than this one. */
  const openHome = async (s: Doc<"signals"> | null | undefined): Promise<string | undefined> => {
    if (!s?.task_id || s.task_id === task._id) return undefined;
    const t = await taskById(s.task_id);
    return t && !isTerminalTaskStatus(t.status) ? t.short_id : undefined;
  };
  const retired: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_retired_task", (q: any) => q.eq("retired.task_id", task._id)).take(100);
  const gone: WithdrawnFinding[] = [];
  for (const s of retired.sort((a, b) => (b.retired?.at ?? 0) - (a.retired?.at ?? 0))) {
    const { fate, keeper } = fateOf(s.retired?.reason ?? "");
    let to: string | undefined;
    if (keeper) {
      const k: Doc<"signals"> | null = await ctx.db.query("signals").withIndex("by_short_id", (q: any) => q.eq("short_id", keeper)).first();
      to = await openHome(k);
    } else if (fate === "rejudged") {
      // Found again under the very same key from another moment: the finding lives on there.
      const same: Doc<"signals">[] = await ctx.db.query("signals").withIndex("by_workspace_fingerprint", (q: any) => q.eq("workspace", task.workspace).eq("fingerprint", s.fingerprint)).take(10);
      for (const o of same) if (!o.retired && (to = await openHome(o))) break;
    }
    gone.push({ short_id: s.short_id, title: s.title, quote: quoteOfDetail(s.detail_md) || undefined, at: s.retired?.at ?? s.created_at, fate: to ? "moved" : fate, ...(to ? { to } : {}) });
  }
  // Moves a person made off this problem after the card was built: the move note names where they went.
  const moved = new Set(gone.flatMap((g) => (g.to ? [g.to] : [])));
  const notes: Doc<"task_comments">[] = await ctx.db.query("task_comments")
    .withIndex("by_task_created", (q: any) => q.eq("task_id", task._id).gte("created_at", since ?? 0)).order("desc").take(100);
  const out = new Map<string, number>();
  for (const n of notes) {
    const tally = n.author === "line" ? parseMoveTally(n.text) : null;
    for (const [ct, k] of tally?.out ?? []) out.set(ct, (out.get(ct) ?? 0) + k);
  }
  if (task.cause?.merged_into) {
    const into = await taskById(task.cause.merged_into);
    if (into) out.set(into.short_id, out.get(into.short_id) ?? 0);
  }
  for (const ct of out.keys()) {
    const t: Doc<"tasks"> | null = await ctx.db.query("tasks").withIndex("by_short_id", (q: any) => q.eq("short_id", ct)).first();
    if (t && !isTerminalTaskStatus(t.status)) moved.add(ct);
  }
  const movedOff = [...out.values()].reduce((a, b) => a + b, 0);
  return { findings: 0, conversations: 0, withdrawn: retired.length + movedOff, moved_to: [...moved].sort(), gone: gone.slice(0, GONE_SHOWN) };
}
