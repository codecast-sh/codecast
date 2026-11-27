// Answering a priority change card (shared/contracts/priorityCard.ts),
// called from sessionDecisions settleResolution beside settleExpectationCard.
// Only the person the card asked settles it: the changes they ticked are
// written against their priorities as they stand now (lib/priorityCard
// planForAccepted, then priorityPassRun writePlan without any run
// bookkeeping), and its moves land as their own (priorityWrite doMove). Words
// with no ticks ("Something else…") write nothing to the priorities and are
// saved as a correction the next pass reads. A dismissal is the web's "Accept
// none": nothing is written. Every answer records its outcome on the card.

import type { Doc, Id } from "../_generated/dataModel";
import { changeLine, type PriorityCard } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import { planForAccepted, type CardRow, type HeldPlan } from "./priorityCard";
import { activeGroup } from "./priorityGroup";
import { priorityCardRefusal } from "./priorityCardAccess";
import { writePlan } from "../priorityPassRun";
import { doCorrect, doMove } from "../priorityWrite";
import { OWN_SCAN_READ } from "../priorityRead";

type Ctx = { db: any; scheduler?: any };

/** The most characters a correction holds (priorityWrite doCorrect). */
const CORRECTION_CHARS = 2_000;

/** What answering writes from: the core's held plan, with the conversations the run read its waiting sessions as. */
type Held = HeldPlan & { conversations?: Record<string, Id<"conversations">> };

/** The ticked option indexes of a multi answer. */
function ticked(verdict: { answer_index?: number; answer_json?: unknown }): number[] {
  if (Array.isArray(verdict.answer_json)) return verdict.answer_json.filter((i): i is number => Number.isInteger(i));
  return verdict.answer_index !== undefined ? [verdict.answer_index] : [];
}

/** The correction's words: which card and changes it answers, then what the person wrote. */
function correctionText(row: Pick<Doc<"session_decisions">, "short_id">, card: PriorityCard, text: string): string {
  const titleOf = (p: string) => card.groups.find((g) => g.priority === p)?.title ?? p;
  const words = text.slice(0, CORRECTION_CHARS - 200);
  let lines = card.changes.map((c) => `${titleOf(c.priority)}: ${changeLine(c, titleOf)}`).join("; ");
  const head = `On the priorities card ${row.short_id ?? ""}`.trim();
  const room = CORRECTION_CHARS - words.length - head.length - 20;
  if (lines.length > room) lines = `${lines.slice(0, Math.max(0, room - 1))}…`;
  return `${head} (it proposed: ${lines}), I said: ${words}`;
}

/** The priority a correction about the card is filed on: the card's first priority that exists, else the person's first active one here. */
async function correctionTarget(ctx: Ctx, userId: Id<"users">, card: PriorityCard): Promise<string | null> {
  for (const g of card.groups) {
    const p: Doc<"priorities"> | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", g.priority)).first();
    if (p && String(p.user_id) === String(userId) && p.workspace === card.workspace && p.status !== "merged") return p.short_id;
  }
  return effectivePriorityOrder(await activeGroup(ctx, userId, card.workspace))[0]?.short_id ?? null;
}

export async function settlePriorityCard(
  ctx: Ctx,
  row: Pick<Doc<"session_decisions">, "_id" | "short_id" | "user_id" | "priority_card">,
  verdict: { status: string; answer_index?: number; answer_text?: string; answer_json?: unknown },
  by: { kind: string; user_id?: Id<"users">; via?: unknown },
  now: number,
): Promise<void> {
  const card = row.priority_card as PriorityCard | undefined;
  if (!card || card.outcome || (verdict.status !== "answered" && verdict.status !== "dismissed")) return;
  // Its person, and only them (the rule, lib/priorityCardAccess): nobody can hand it to anyone else, so this is the whole check.
  const person = row.user_id;
  if (priorityCardRefusal(row, by)) return;
  // A dismissal is "Accept none" (a multi answer cannot be empty): nothing is written.
  const answered = verdict.status === "answered";
  const accepted = answered ? [...new Set(ticked(verdict).map((i) => card.changes[i]?.id).filter((id): id is string => !!id))] : [];
  const text = answered ? verdict.answer_text?.trim() : undefined;

  let skipped: string[] = [];
  if (accepted.length) {
    const held = card.held as Held;
    const rowsNow: Doc<"priorities">[] = await ctx.db
      .query("priorities")
      .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", person).eq("workspace", card.workspace))
      .order("desc")
      .take(OWN_SCAN_READ);
    const answer = planForAccepted(held, new Set(accepted), rowsNow as unknown as CardRow[], now);
    skipped = answer.skipped;
    await writePlan(ctx as any, { user_id: person, workspace: card.workspace }, answer.plan, { conversations: held.conversations });
    for (const m of answer.moves) {
      const moved = await doMove(ctx, person, m.short_id, m.to);
      const change = held.changes.find((c) => c.kind === "move" && c.priority === m.short_id);
      if ("error" in moved && change && !skipped.includes(change.id)) skipped.push(change.id);
    }
  }
  // Words with the answer go to the next pass as a correction, on the card's first priority that exists.
  if (text) {
    const target = await correctionTarget(ctx, person, card);
    if (target) await doCorrect(ctx as any, person, target, correctionText(row, card, text), undefined);
  }
  const outcome: NonNullable<PriorityCard["outcome"]> = { accepted: accepted.filter((id) => !skipped.includes(id)), skipped, at: now, ...(text ? { text } : {}) };
  await ctx.db.patch(row._id, { priority_card: { ...card, outcome } });
}
