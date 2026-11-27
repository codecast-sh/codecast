// What a priorities pass run adds to the card the core split out of its plan
// (lib/priorityCard.ts splitPlan): each change's evidence, the share of what
// the person typed by priority, the changes an open card already proposes,
// and the card's words. Pure: priorityCardPost.ts writes the card.

import type { PriorityCard, PriorityCardGroup, PriorityChange, PriorityEvidence } from "@codecast/shared/contracts/priorityCard";
import type { PriorityPassOutput, PriorityProposal, PriorityStep } from "@codecast/shared/contracts/priorities";
import { findQuote, type HeldPlan, type SplitPlan } from "./priorityCard";
import type { MergePlan, PriorityPassInput } from "./priorityPass";

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
      if (found.kind === "session") return [{ kind: "quote", text: text.replace(/\s+/g, " ").trim(), session: found.session, session_title: found.title, at: found.at }];
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

export function cardDraft(split: SplitPlan, plan: MergePlan, input: PriorityPassInput, output: PriorityPassOutput): CardDraft {
  return {
    changes: withEvidence(split.changes, plan, input, output),
    groups: split.groups,
    held: split.held,
    typed: typedByPriority(input, split.direct),
    sessions: input.sessions.length,
    calls: input.calls.length,
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

export const cardQuestion = (window: { from: number; to: number }) => `Should your priorities follow your last ${spanWords(window.to - window.from)} of work?`;

export function cardContext(n: number, run: { sessions: number; calls: number }): string {
  const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  const read = [plural(run.sessions, "session"), ...(run.calls ? [plural(run.calls, "call")] : [])].join(" and ");
  return `The priorities pass read ${read} and proposes ${plural(n, "change")}. Only the changes you keep ticked are written, against your priorities as they are when you answer.`;
}
