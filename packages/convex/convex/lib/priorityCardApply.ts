// Answering a priority change card (shared/contracts/priorityCard.ts),
// called from sessionDecisions settleResolution beside settleExpectationCard.
// Only the person the card asked settles it. Each merge they tick is their
// own merge (priorityWrite doMerge), of the absorbed priority as it stands
// then, unless either priority was merged by hand, deleted or set aside
// since; a merge into a priority the run would have created makes it first
// (lib/priorityCard planForAccepted, then priorityPassRun writePlan). Words
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
import { doCorrect, doMerge } from "../priorityWrite";
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

/** One of the person's priorities in this workspace, by short id, or null. */
async function ownedRow(ctx: Ctx, userId: Id<"users">, workspace: string, shortId: string): Promise<Doc<"priorities"> | null> {
  const p: Doc<"priorities"> | null = await ctx.db.query("priorities").withIndex("by_short_id", (q: any) => q.eq("short_id", shortId)).first();
  return p && String(p.user_id) === String(userId) && p.workspace === workspace ? p : null;
}

/** Makes the new priority a merge waited on (`parent`, its new_priority change), as the run would have, against the rows as they are now; null when it no longer applies. */
async function createWaiting(ctx: Ctx, userId: Id<"users">, card: PriorityCard, held: Held, parent: string, now: number): Promise<Doc<"priorities"> | null> {
  const rowsNow: Doc<"priorities">[] = await ctx.db
    .query("priorities")
    .withIndex("by_user_workspace_active", (q: any) => q.eq("user_id", userId).eq("workspace", card.workspace))
    .order("desc")
    .take(OWN_SCAN_READ);
  const create = new Set([parent, ...held.changes.filter((c) => c.parent === parent && c.kind === "new_milestone").map((c) => c.id)]);
  const answer = planForAccepted(held, create, rowsNow as unknown as CardRow[], now);
  if (answer.skipped.includes(parent)) return null;
  const { created } = await writePlan(ctx as any, { user_id: userId, workspace: card.workspace }, answer.plan, { conversations: held.conversations });
  const ref = held.changes.find((c) => c.id === parent)?.priority;
  return ref && created[ref] ? ownedRow(ctx, userId, card.workspace, created[ref]) : null;
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

  const skipped: string[] = [];
  const held = card.held as Held;
  for (const id of accepted) {
    const c = held.changes.find((x) => x.id === id);
    // A merge stands when neither priority was merged by hand, deleted or set aside since (and the absorbed one is not the person's done).
    const gone = c?.kind === "merge" && c.target ? await ownedRow(ctx, person, card.workspace, c.target) : null;
    if (!c || !gone || gone.status === "merged" || gone.status === "set_aside" || gone.status_set_by === "person") { skipped.push(id); continue; }
    // A merge into a priority the run would have created makes it now, with the milestones and sessions the run gave it.
    const into = c.parent ? await createWaiting(ctx, person, card, held, c.parent, now) : await ownedRow(ctx, person, card.workspace, c.priority);
    if (!into || into.status === "merged" || into.status === "set_aside") { skipped.push(id); continue; }
    // Then it is the person's own merge, of the absorbed priority as it stands now.
    const merged = await doMerge(ctx as any, person, gone.short_id, into.short_id, { joinSameTitles: true });
    if ("error" in merged) skipped.push(id);
  }
  // Words with the answer go to the next pass as a correction, on the card's first priority that exists.
  if (text) {
    const target = await correctionTarget(ctx, person, card);
    if (target) await doCorrect(ctx as any, person, target, correctionText(row, card, text), undefined);
  }
  const outcome: NonNullable<PriorityCard["outcome"]> = { accepted: accepted.filter((id) => !skipped.includes(id)), skipped, at: now, ...(text ? { text } : {}) };
  await ctx.db.patch(row._id, { priority_card: { ...card, outcome } });
}
