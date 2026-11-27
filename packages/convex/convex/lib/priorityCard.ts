// The pure core of priority change cards (shared/contracts/priorityCard.ts):
// the card's rows for a pass plan's merges (mergeRows), and where a quote
// the reply gave as evidence was said (findQuote). Everything else a run
// plans it writes at once (lib/priorityCardPass planWithoutMerges); accepting
// a merge is the person's own merge (lib/priorityCardApply). No ctx, no db.

import type { PriorityCardGroup, PriorityChange } from "@codecast/shared/contracts/priorityCard";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import type { MergePlan, PassCall, PassSession, PriorityPassInput } from "./priorityPass";

/** `text`: the words as the person wrote them, the slice of their message (or action item) the quote matched. */
export type QuoteSource =
  | { kind: "session"; session: string; title: string; at: number; text: string }
  | { kind: "call"; call: string; title: string; action_item: string; at: number; text: string };

/** A quote this short is found almost anywhere: it says nothing. */
export const QUOTE_MIN_WORDS = 4;

/**
 * `s` folded for comparing: whitespace runs as one space (none leading or
 * trailing), each character lower-cased on its own, never the string at once,
 * so a quote and the message it came from fold alike whatever their context
 * (a whole-string lower-case writes a Greek final sigma only at a word's end;
 * a final sigma folds to the plain one, as an upper-case sigma does).
 * `at[i]` is the index in `s` of folded character i.
 */
function fold(s: string): { flat: string; at: number[] } {
  let flat = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i])) {
      if (flat && !flat.endsWith(" ")) { flat += " "; at.push(i); }
      continue;
    }
    for (const ch of s[i].toLowerCase()) { flat += ch === "ς" ? "σ" : ch; at.push(i); }
  }
  if (flat.endsWith(" ")) { flat = flat.slice(0, -1); at.pop(); }
  return { flat, at };
}

/** The slice of `hay` that the folded quote `q` matches, or null. */
function sliceOf(hay: string, q: string): string | null {
  const { flat, at } = fold(hay);
  const i = flat.indexOf(q);
  return i < 0 ? null : hay.slice(at[i], at[i + q.length - 1] + 1);
}

/**
 * Where `text` was said (whitespace collapsed, case ignored, at least
 * QUOTE_MIN_WORDS words): a message the person typed in one of the run's
 * sessions, or an action item of one of its calls, with the words as they
 * wrote them. Null when it was not, and a quote that was not said is dropped.
 */
export function findQuote(text: string, sessions: ReadonlyArray<Pick<PassSession, "id" | "title" | "typed">>, calls: ReadonlyArray<Pick<PassCall, "id" | "title" | "at" | "action_items">>): QuoteSource | null {
  const q = fold(text).flat;
  if (!q || q.split(" ").length < QUOTE_MIN_WORDS) return null;
  for (const s of sessions) for (const m of s.typed) {
    const said = sliceOf(m.text, q);
    if (said !== null) return { kind: "session", session: s.id, title: s.title, at: m.at, text: said };
  }
  for (const c of calls) for (const a of c.action_items) {
    const said = sliceOf(a, q);
    if (said !== null) return { kind: "call", call: c.id, title: c.title, action_item: a, at: c.at, text: said };
  }
  return null;
}

/**
 * The card's rows for a plan's merges (without evidence): one row per
 * absorbed priority, under the priority it goes into, an existing one by
 * its short id or one the run creates by its plan ref ("new-1"). Groups:
 * existing survivors by their place now (the rest after, as the input lists
 * them), then new ones in plan order; row ids ("c1", "c2", …) follow them.
 */
export function mergeRows(plan: MergePlan, input: PriorityPassInput): { changes: PriorityChange[]; groups: PriorityCardGroup[] } {
  const byId = new Map(input.priorities.map((p) => [p.short_id, p]));
  const order = effectivePriorityOrder(input.priorities).map((p) => p.short_id);
  const rankOf = (id: string) => (order.includes(id) ? order.indexOf(id) + 1 : null);
  const into = [...new Set(plan.merges.map((m) => m.merged_into))];
  const listed = (id: string) => input.priorities.findIndex((p) => p.short_id === id);
  const existing = into.filter((id) => byId.has(id)).sort((a, b) => (rankOf(a) ?? Infinity) - (rankOf(b) ?? Infinity) || listed(a) - listed(b));
  const created = plan.creates.map((c) => c.ref).filter((ref) => into.includes(ref));
  const changes: PriorityChange[] = [];
  const groups: PriorityCardGroup[] = [];
  for (const id of [...existing, ...created]) {
    const ids: string[] = [];
    for (const m of plan.merges.filter((x) => x.merged_into === id)) {
      const row: PriorityChange = { id: `c${changes.length + 1}`, kind: "merge", priority: id, target: m.short_id, from: byId.get(m.short_id)!.title, evidence: [] };
      changes.push(row);
      ids.push(row.id);
    }
    const create = plan.creates.find((c) => c.ref === id);
    const title = create ? create.title : (plan.rewritten.includes(id) && plan.updates.find((u) => u.short_id === id)?.patch.title) || byId.get(id)!.title;
    groups.push({ priority: id, rank: create ? null : rankOf(id), title, changes: ids });
  }
  return { changes, groups };
}
