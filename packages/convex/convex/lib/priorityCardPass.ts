// What a priorities pass run writes at once and what it puts on its card: the
// run without its merges (planWithoutMerges), and its merges' rows
// (lib/priorityCard.ts mergeRows) with their evidence, the share of what the
// person typed by priority, the repeats an open card holds, the merges the
// person declined, and the card's words. Pure: priorityCardPost.ts writes the
// card.

import type { PriorityCard, PriorityCardGroup, PriorityChange, PriorityEvidence } from "@codecast/shared/contracts/priorityCard";
import type { PriorityPassOutput, PriorityStep } from "@codecast/shared/contracts/priorities";
import { findQuote, mergeRows } from "./priorityCard";
import { mergePriorities, type MergePlan, type PriorityPassInput } from "./priorityPass";
import { matchSteps, repeatsDropped } from "./priorityPassSteps";

/**
 * Each merge row with its evidence: the survivor's `why` in the reply, each
 * excerpt where it was said (findQuote): a line the person typed, or a
 * call's action item; one not found verbatim is dropped.
 */
export function withEvidence(changes: PriorityChange[], input: PriorityPassInput, output: PriorityPassOutput): PriorityChange[] {
  const targets = targetsOf(input, output);
  const why = new Map(output.priorities.map((p, i) => [targets[i], p.why ?? []]));
  return changes.map((c) => {
    const seen = new Set<string>();
    const evidence = (why.get(c.priority) ?? []).flatMap((text): PriorityEvidence[] => {
      const found = findQuote(text, input.sessions, input.calls);
      if (!found) return [];
      if (found.kind === "session") return [{ kind: "quote", text: found.text, session: found.session, session_title: found.title, at: found.at }];
      return [{ kind: "event", text: `Action item on “${found.title}”: ${found.action_item}`, ref: found.call, at: found.at }];
    }).filter((e) => !seen.has(e.text) && !!seen.add(e.text));
    return { ...c, evidence };
  });
}

/**
 * Characters the person typed in the run's sessions, by the priority each
 * session sits on once `direct` is written (null: none). A session waiting
 * on a merge stays where it is until the merge lands.
 */
export function typedByPriority(input: PriorityPassInput, direct: MergePlan): Array<{ priority: string | null; chars: number }> {
  const holder = new Map<string, string | null>();
  for (const p of input.priorities) for (const s of p.sessions) holder.set(s.id, p.short_id);
  for (const s of input.sessions) if (s.placed && !holder.has(s.id)) holder.set(s.id, s.placed.priority);
  for (const id of direct.unmap) holder.set(id, null);
  for (const m of direct.sessions) holder.set(m.session, m.priority);
  const chars = new Map<string | null, number>();
  for (const s of input.sessions) {
    const n = s.typed.reduce((sum, m) => sum + m.text.length, 0);
    if (!n) continue;
    const p = holder.get(s.id) ?? null;
    chars.set(p, (chars.get(p) ?? 0) + n);
  }
  return [...chars].map(([priority, n]) => ({ priority, chars: n }));
}

/** What the pass run hands its write: the card's merge rows and groups; priorityCardPost adds the rest. */
export type CardDraft = {
  changes: PriorityChange[];
  groups: PriorityCardGroup[];
  typed: Array<{ priority: string | null; chars: number }>;
  sessions: number;
  calls: number;
};

// ---------------------------------------------------------------- merges wait, the rest is written

/** Each reply proposal's plan target, numbered as mergePriorities numbers new ones. */
function targetsOf(input: PriorityPassInput, output: PriorityPassOutput): string[] {
  const existing = new Set(input.priorities.map((p) => p.short_id));
  let made = 0;
  return output.priorities.map((p) => (p.short_id && existing.has(p.short_id) ? p.short_id : `new-${++made}`));
}

/**
 * What a run with the priority cards experiment writes at once when its plan
 * merges (sd-5035: only merges wait on the person): the reply's plan without
 * its merges, written exactly as a run without the experiment writes a reply.
 * Nothing of a merge happens before it is accepted:
 * - the absorbed priority is left as it is;
 * - a survivor proposes none of the milestones it would carry from it: each
 *   proposed milestone the full plan matched to one of the absorbed one's
 *   (the same matcher, matchSteps, over the same pool), and each new one
 *   repeating a milestone the person dropped there;
 * - a session the reply puts on the survivor while it sits on the absorbed
 *   priority stays there (one it moves anywhere else moves).
 * A new priority that would absorb one is created now, as it is without the
 * merge; the card's merge names it once it has its short id.
 */
export function planWithoutMerges(input: PriorityPassInput, output: PriorityPassOutput, plan: MergePlan): MergePlan {
  const byId = new Map(input.priorities.map((p) => [p.short_id, p]));
  const into = new Map(plan.merges.map((m) => [m.short_id, m.merged_into]));
  const targets = targetsOf(input, output);
  const priorities = output.priorities.map((prop, i) => {
    const target = targets[i];
    if (!prop.merges) return prop;
    const { merges: _, ...rest } = prop;
    const absorbed = prop.merges.filter((id) => into.get(id) === target).map((id) => byId.get(id)!);
    if (!absorbed.length) return rest;
    const ownerOf = new Map<PriorityStep, string>();
    for (const a of absorbed) for (const s of a.steps) ownerOf.set(s, a.short_id);
    const pool = [...(byId.get(target)?.steps ?? []), ...ownerOf.keys()];
    const matched = matchSteps(pool, prop.steps, pool.map((s) => ownerOf.get(s) ?? target), target);
    const droppedThere = [...ownerOf.keys()].filter((s) => s.dropped);
    const waiting = new Set(absorbed.flatMap((a) => a.sessions.map((s) => s.id)));
    const steps = prop.steps
      .filter((s, k) => !(matched[k] && ownerOf.has(matched[k]!)) && !(!matched[k] && droppedThere.some((d) => repeatsDropped(d.title, s.title))))
      .map((s) => ({ ...s, refs: s.refs.filter((r) => !(r.kind === "session" && waiting.has(r.id))) }));
    return { ...rest, steps, sessions: prop.sessions.filter((s) => !waiting.has(s.session)) };
  });
  return mergePriorities(input, { ...output, priorities });
}

/**
 * The card for a run's merges: its merge rows (lib/priorityCard mergeRows)
 * with their evidence, all it holds. Accepting one is the person's own merge,
 * of the absorbed priority as it stands then (lib/priorityCardApply). A merge
 * into a priority the run created names it by its plan ref ("new-1") until
 * the post names its short id (withCreatedIds).
 */
export function mergeCardDraft(plan: MergePlan, direct: MergePlan, input: PriorityPassInput, output: PriorityPassOutput): CardDraft {
  const { changes, groups } = mergeRows(plan, input);
  return {
    changes: withEvidence(changes, input, output),
    groups,
    typed: typedByPriority(input, direct),
    sessions: input.sessions.length,
    calls: input.calls.length,
  };
}

/** The draft with each priority the run created named by its short id (`created`: plan ref -> short id). */
export function withCreatedIds(draft: CardDraft, created: Record<string, string>): CardDraft {
  const real = (p: string) => created[p] ?? p;
  return {
    ...draft,
    changes: draft.changes.map((c) => ({ ...c, priority: real(c.priority) })),
    groups: draft.groups.map((g) => ({ ...g, priority: real(g.priority) })),
    typed: draft.typed.map((t) => ({ ...t, priority: t.priority && real(t.priority) })),
  };
}

// ---------------------------------------------------------------- declined merges

/** A merge of two priorities, whichever way round: the person declined it once, and it is never proposed again. */
export const mergePairKey = (a: string, b: string) => [a, b].sort().join("|");

/**
 * A declined merge lives as a correction on the absorbed priority, in these
 * words: every pass reads it, and the card's filter parses it back
 * (declinedFromCorrections). Deleting the correction allows the merge again.
 */
export const declinedMergeText = (into: string, title: string) => `Not part of ${into} “${title}”: you declined merging them on a priority card.`;
const DECLINED = /^Not part of (pri-\d+) “/;

/** The merges the person declined, from their corrections (not deleted): each one's priority with the one its words name. */
export function declinedFromCorrections(rows: ReadonlyArray<{ text: string; snapshot: { short_id: string }; deleted_at?: number }>): Array<{ absorbed: string; into: string }> {
  return rows.flatMap((r) => {
    const m = r.deleted_at ? null : DECLINED.exec(r.text);
    return m ? [{ absorbed: r.snapshot.short_id, into: m[1] }] : [];
  });
}

/** The draft without the merges the person declined (held back from the run like any other merge, and never proposed again), and without the groups left empty. */
export function dropDeclined(draft: CardDraft, declined: ReadonlyArray<{ absorbed: string; into: string }>): CardDraft {
  const pairs = new Set(declined.map((d) => mergePairKey(d.absorbed, d.into)));
  const gone = new Set(draft.changes.filter((c) => c.kind === "merge" && c.target && pairs.has(mergePairKey(c.target, c.priority))).map((c) => c.id));
  if (!gone.size) return draft;
  return {
    ...draft,
    changes: draft.changes.filter((c) => !gone.has(c.id)),
    groups: draft.groups.map((g) => ({ ...g, changes: g.changes.filter((id) => !gone.has(id)) })).filter((g) => g.changes.length),
  };
}

// ---------------------------------------------------------------- repeats

/** What makes two merges the same: the same priority absorbed into the same one. */
const changeKey = (c: PriorityChange) => JSON.stringify([c.kind, c.priority, c.target ?? null]);

/** The draft without the merges an open card already proposes, and without the groups left empty. Ids stay as they were: option i is still changes[i]. */
export function dropRepeats(draft: CardDraft, open: ReadonlyArray<Pick<PriorityCard, "changes">>): CardDraft {
  const pending = new Set(open.flatMap((card) => card.changes.map(changeKey)));
  const gone = new Set<string>();
  for (const c of draft.changes) if (pending.has(changeKey(c))) gone.add(c.id);
  if (!gone.size) return draft;
  const changes = draft.changes.filter((c) => !gone.has(c.id));
  const groups = draft.groups.map((g) => ({ ...g, changes: g.changes.filter((id) => !gone.has(id)) })).filter((g) => g.changes.length);
  return { ...draft, changes, groups };
}

// ---------------------------------------------------------------- words

/** "hour", "3 hours", "2 days": how much work the run read. */
export function spanWords(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours <= 1) return "hour";
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "Merge “Grader” into “Trusted evals”?", or "Merge 2 pairs of your priorities?" */
export function cardQuestion(changes: ReadonlyArray<PriorityChange>, titleOf: (priority: string) => string): string {
  const merges = changes.filter((c) => c.kind === "merge");
  if (merges.length === 1) return `Merge “${merges[0].from}” into “${titleOf(merges[0].priority)}”?`;
  return `Merge ${merges.length} pairs of your priorities?`;
}

export function cardContext(run: { sessions: number; calls: number; window: { from: number; to: number } }): string {
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const read = [plural(run.sessions, "session"), ...(run.calls ? [plural(run.calls, "call")] : [])].join(" and ");
  return `The priorities pass read ${read} from your last ${spanWords(run.window.to - run.window.from)} and wrote its other changes. Nothing of a merge happens until you tick it: the priority it absorbs keeps its milestones and sessions until then.`;
}
