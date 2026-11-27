// What a priorities pass run writes at once and what it puts on its card: the
// run without its merges (planWithoutMerges), and the merges the core split
// out of its plan (lib/priorityCard.ts splitPlan) with their evidence, the
// share of what the person typed by priority, the repeats an open card holds,
// the merges the person declined, and the card's words. Pure:
// priorityCardPost.ts writes the card.

import type { PriorityCard, PriorityCardGroup, PriorityChange, PriorityEvidence } from "@codecast/shared/contracts/priorityCard";
import type { PriorityPassOutput, PriorityProposal, PriorityStep } from "@codecast/shared/contracts/priorities";
import { findQuote, type HeldPlan, type SplitPlan } from "./priorityCard";
import { mergePriorities, type MergePlan, type PriorityPassInput } from "./priorityPass";
import { matchSteps, repeatsDropped } from "./priorityPassSteps";

const MILESTONE_KINDS = new Set<PriorityChange["kind"]>(["new_milestone", "rename_milestone", "to_critical", "to_polish", "milestone_done", "milestone_reopen", "drop_milestone"]);
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Each reply proposal under the plan's name for its priority: its short id, or "new-N" as mergePriorities numbers new ones. */
function proposalsByTarget(input: PriorityPassInput, output: PriorityPassOutput): Map<string, PriorityProposal> {
  const existing = new Set(input.priorities.map((p) => p.short_id));
  const out = new Map<string, PriorityProposal>();
  let made = 0;
  for (const prop of output.priorities) out.set(prop.short_id && existing.has(prop.short_id) ? prop.short_id : `new-${++made}`, prop);
  return out;
}

/** The plan's milestones of a priority (the update's, or the new priority's). */
const planSteps = (plan: MergePlan, priority: string): PriorityStep[] =>
  plan.updates.find((u) => u.short_id === priority)?.patch.steps ?? plan.creates.find((c) => c.ref === priority)?.steps ?? [];

/**
 * Each change with its evidence. A priority-level change takes its
 * priority's `why`, a milestone change its milestone's; an excerpt not found
 * verbatim in what the person typed or a call's action items is dropped. A
 * milestone (or priority) the change marks done, whose tasks closed or pull
 * requests merged in the input, gets an event for each. A `serves` change
 * names its goals by title.
 */
export function withEvidence(changes: PriorityChange[], plan: MergePlan, input: PriorityPassInput, output: PriorityPassOutput): PriorityChange[] {
  const props = proposalsByTarget(input, output);
  const taskTitle = new Map<string, string>();
  const taskDone = new Set<string>();
  for (const t of [...input.step_tasks, ...input.sessions.flatMap((s) => s.tasks)]) {
    taskTitle.set(t.short_id, t.title);
    if (t.status === "done") taskDone.add(t.short_id);
  }
  const merged = new Set(input.sessions.flatMap((s) => s.prs.filter((p) => p.merged).map((p) => p.ref)));
  const goal = new Map(input.initiatives.map((i) => [i.short_id, i.title]));
  const goalTitle = (v: PriorityChange["to"]) => (typeof v === "string" ? goal.get(v) ?? v : v ?? null);

  const quotes = (texts: string[]): PriorityEvidence[] =>
    texts.flatMap((text): PriorityEvidence[] => {
      const found = findQuote(text, input.sessions, input.calls);
      if (!found) return [];
      if (found.kind === "session") return [{ kind: "quote", text: found.text, session: found.session, session_title: found.title, at: found.at }];
      return [{ kind: "event", text: `Action item on “${found.title}”: ${found.action_item}`, ref: found.call, at: found.at }];
    });
  const records = (steps: PriorityStep[]): PriorityEvidence[] =>
    steps.flatMap((st) => st.refs.flatMap((r): PriorityEvidence[] => {
      if (r.kind === "task" && taskDone.has(r.id)) return [{ kind: "event", text: `Task ${r.id} “${taskTitle.get(r.id) ?? r.id}” closed`, ref: r.id }];
      if (r.kind === "pr" && merged.has(r.id)) return [{ kind: "event", text: `Pull request ${r.id} merged`, ref: r.id }];
      return [];
    }));

  return changes.map((c) => {
    const prop = props.get(c.priority);
    const steps = planSteps(plan, c.priority);
    let evidence: PriorityEvidence[];
    if (MILESTONE_KINDS.has(c.kind)) {
      const st = steps.find((s) => s.key === c.step_key);
      const said = prop?.steps.find((s) => s.key === c.step_key || s.key === `${c.priority}/${c.step_key}` || (st && sameTitle(s.title, st.title)) || (typeof c.to === "string" && sameTitle(s.title, c.to)));
      evidence = [...quotes(said?.why ?? []), ...((c.kind === "milestone_done" || (c.kind === "new_milestone" && st?.done)) && st ? records([st]) : [])];
    } else {
      evidence = [...quotes(prop?.why ?? []), ...(c.kind === "done" ? records(steps.filter((s) => s.tier === "critical" && !s.dropped && s.done)) : [])];
    }
    const seen = new Set<string>();
    evidence = evidence.filter((e) => !seen.has(e.text) && !!seen.add(e.text));
    return { ...c, ...(c.kind === "serves" ? { from: goalTitle(c.from), to: goalTitle(c.to) } : {}), evidence };
  });
}

/**
 * Characters the person typed in the run's sessions, by the priority each
 * session sits on once `direct` is written (null: none). A session waiting
 * on the card for a new priority stays where it is until the card lands.
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

/** What the pass run hands its write: the card's changes and what answering it writes from; priorityCardPost adds the rest. */
export type CardDraft = {
  changes: PriorityChange[];
  groups: PriorityCardGroup[];
  held: HeldPlan;
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
 *   priority stays there (one it moves anywhere else moves);
 * - a new priority that absorbs one waits whole: it is not created now.
 */
export function planWithoutMerges(input: PriorityPassInput, output: PriorityPassOutput, plan: MergePlan): MergePlan {
  const byId = new Map(input.priorities.map((p) => [p.short_id, p]));
  const into = new Map(plan.merges.map((m) => [m.short_id, m.merged_into]));
  const targets = targetsOf(input, output);
  const waitingWhole = new Set<string>();
  const priorities = output.priorities.map((prop, i) => {
    const target = targets[i];
    if (!prop.merges) return prop;
    const { merges: _, ...rest } = prop;
    const absorbed = prop.merges.filter((id) => into.get(id) === target).map((id) => byId.get(id)!);
    if (!absorbed.length) return rest;
    if (!byId.has(target)) waitingWhole.add(target);
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
  const direct = mergePriorities(input, { ...output, priorities });
  if (!waitingWhole.size) return direct;
  return { ...direct, creates: direct.creates.filter((c) => !waitingWhole.has(c.ref)), sessions: direct.sessions.filter((s) => !waitingWhole.has(s.priority)) };
}

/**
 * The card for a run's merges: its merge rows (with their evidence) and what
 * accepting each writes. Everything else the run wrote at once. A merge into
 * an existing priority is the person's own merge when accepted, of the
 * absorbed priority as it stands then (lib/priorityCardApply), so it holds
 * nothing more. A merge into a priority the run would create holds that
 * create whole (its milestones and the sessions the run put on it), made
 * when the merge is accepted and never otherwise.
 */
export function mergeCardDraft(split: SplitPlan, plan: MergePlan, direct: MergePlan, input: PriorityPassInput, output: PriorityPassOutput): CardDraft {
  const merges = split.changes.filter((c) => c.kind === "merge");
  const parents = new Set(merges.flatMap((c) => (c.parent ? [c.parent] : [])));
  const kept = new Set([...merges.map((c) => c.id), ...parents]);
  for (const c of split.held.changes) if (c.parent && parents.has(c.parent) && c.kind === "new_milestone") kept.add(c.id);
  const createRefs = new Set(split.held.changes.filter((c) => parents.has(c.id)).map((c) => c.priority));
  const unparented = <T extends { parent?: string }>({ parent: _, ...c }: T): Omit<T, "parent"> => c;
  return {
    changes: withEvidence(merges.map(unparented), plan, input, output),
    groups: split.groups.map((g) => ({ ...g, changes: g.changes.filter((id) => merges.some((c) => c.id === id)) })).filter((g) => g.changes.length),
    held: {
      ...split.held,
      creates: split.held.creates.filter((c) => createRefs.has(c.ref)),
      changes: split.held.changes.filter((c) => kept.has(c.id)),
      // The sessions the run put on a new priority that waits: placed when it is made. Those of an absorbed one move with the merge.
      sessions: split.held.sessions
        .filter((s) => s.needs.length > 0 && s.needs.every((id) => parents.has(id)))
        .map((s) => ({ ...s, step_from: s.step_from !== null && kept.has(s.step_from) ? s.step_from : null })),
    },
    typed: typedByPriority(input, direct),
    sessions: input.sessions.length,
    calls: input.calls.length,
  };
}

/** A merge of two priorities, whichever way round: the person declined it once, and it is never proposed again. */
export const mergePairKey = (a: string, b: string) => [a, b].sort().join("|");

/**
 * The merges the person declined on these answered or dismissed cards: every
 * merge row they did not tick (one that no longer applied counts as ticked).
 * A survivor the card would have created is named by its title ("new:<title>").
 */
export function declinedMerges(cards: ReadonlyArray<{ status: string; card: Pick<PriorityCard, "changes" | "outcome" | "held"> }>): Array<{ absorbed: string; into: string }> {
  const out = new Map<string, { absorbed: string; into: string }>();
  for (const { status, card } of cards) {
    if (status === "answered" && !card.outcome) continue;
    const ticked = new Set(status === "answered" ? [...(card.outcome?.accepted ?? []), ...(card.outcome?.skipped ?? [])] : []);
    for (const c of card.changes) {
      if (c.kind !== "merge" || !c.target || ticked.has(c.id)) continue;
      const into = priorityIdentity(card, c.priority);
      out.set(mergePairKey(c.target, into), { absorbed: c.target, into });
    }
  }
  return [...out.values()];
}

/**
 * The draft without the merges the person declined (held back from the run
 * like any other merge, and never proposed again), and without the groups
 * left empty. What only they held stays in `held`, inert: answering acts on
 * the card's changes alone.
 */
export function dropDeclined(draft: CardDraft, declined: ReadonlyArray<{ absorbed: string; into: string }>): CardDraft {
  const pairs = new Set(declined.map((d) => mergePairKey(d.absorbed, d.into)));
  const gone = new Set(draft.changes.filter((c) => c.kind === "merge" && c.target && pairs.has(mergePairKey(c.target, priorityIdentity(draft, c.priority)))).map((c) => c.id));
  if (!gone.size) return draft;
  return {
    ...draft,
    changes: draft.changes.filter((c) => !gone.has(c.id)),
    groups: draft.groups.map((g) => ({ ...g, changes: g.changes.filter((id) => !gone.has(id)) })).filter((g) => g.changes.length),
  };
}

// ---------------------------------------------------------------- repeats

/** A priority as two cards can agree on it: an existing one by short id, one a card creates by its title. */
function priorityIdentity(card: Pick<PriorityCard, "held">, priority: string): string {
  const create = (card.held as HeldPlan | undefined)?.creates?.find((c) => c.ref === priority);
  return create ? `new:${create.title.trim().toLowerCase()}` : priority;
}

/** What makes two changes the same: kind, priority, milestone and where it goes. A milestone a card adds is named by its title, as its plan key is the run's own. */
function changeKey(card: Pick<PriorityCard, "held">, c: PriorityChange): string {
  const step = c.kind === "new_milestone" ? "" : c.step_key ?? "";
  const to = typeof c.to === "string" ? c.to.trim().toLowerCase() : c.to ?? null;
  return JSON.stringify([c.kind, priorityIdentity(card, c.priority), step, to, c.target ?? null]);
}

/**
 * The draft without the changes an open card already proposes (a change
 * hanging off a parent that goes, goes with it), and without the groups left
 * empty. Ids stay as they were: option i is still changes[i].
 */
export function dropRepeats(draft: CardDraft, open: ReadonlyArray<Pick<PriorityCard, "held" | "changes">>): CardDraft {
  const pending = new Set(open.flatMap((card) => card.changes.map((c) => changeKey(card, c))));
  const gone = new Set<string>();
  for (const c of draft.changes) if (pending.has(changeKey(draft, c)) || (c.parent && gone.has(c.parent))) gone.add(c.id);
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
