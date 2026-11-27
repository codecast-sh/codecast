// The pure core of priority change cards (shared/contracts/priorityCard.ts).
// splitPlan takes a pass's MergePlan apart: what may be written at once
// (`direct`: session placements, summaries and bookkeeping) and every change
// to the person's priorities, one row each, for the card. planForAccepted
// turns the rows the person ticked back into a MergePlan applyPlan can write,
// against the priorities as they stand when the card is answered, and the
// moves the person's own move then makes. No ctx, no db.
//
// The plan already keeps what the person set (mergePriorities, holdPersonSteps),
// so a person-held field is never proposed; planForAccepted checks the rows
// again because the person may have changed them while the card waited.

import type { PriorityCardGroup, PriorityChange, PriorityChangeKind } from "@codecast/shared/contracts/priorityCard";
import type { PriorityOrderRow, PriorityPassOutput, PrioritySetBy, PriorityStatus, PriorityStep } from "@codecast/shared/contracts/priorities";
import { effectivePriorityOrder, lastPriorityKey } from "@codecast/shared/contracts/priorities";
import type { MergePlan, PassCall, PassSession, PriorityPassInput, PriorityWrite } from "./priorityPass";
import { criticalDone, isPersonHeld, repeatsDropped, stepKeyMax } from "./priorityPassSteps";

/** One change as answering needs it: the card's row without its evidence, plus what the write takes. */
export type HeldChange = {
  id: string;
  kind: PriorityChangeKind;
  priority: string;
  step_key?: string;
  parent?: string;
  target?: string;
  from?: string | number | null;
  to?: string | number | null;
  /** new_milestone: the milestone as the plan wrote it, and the plan key it follows (null: first). milestone_done/reopen: the plan's milestone, for its done time. */
  step?: PriorityStep;
  after?: string | null;
  /** merge: the absorbed priority's milestones as the plan carried them onto the survivor (survivor keys), and its key map (absorbed key -> survivor key). */
  carried?: PriorityStep[];
  step_keys?: Record<string, string>;
};

/** A session placement that waits on the card: it lands when every change in `needs` lands, and takes `step_key` only when `step_from` (the change adding that milestone) lands too. */
export type HeldSession = { session: string; priority: string; step_key: string | null; needs: string[]; step_from: string | null };

/** What answering the card writes from (PriorityCard.held). JSON. */
export type HeldPlan = {
  v: 1;
  /** The active priorities in the order the plan leaves them (short ids and the plan's new-N). An accepted move, new priority or reopen lands where it agrees with this order on the most priorities still active (bestSlot). */
  order: string[];
  /** The plan's new priorities, whole: answering keeps only their accepted milestones. */
  creates: MergePlan["creates"];
  changes: HeldChange[];
  sessions: HeldSession[];
};

export type SplitPlan = { direct: MergePlan; changes: PriorityChange[]; groups: PriorityCardGroup[]; held: HeldPlan };

/** A priority as it stands: the pass input's rows (PassPriority) and the stored rows (Doc<"priorities">) both fit. */
export type CardRow = PriorityOrderRow & {
  short_id: string;
  title: string;
  status_set_by?: PrioritySetBy | null;
  serves?: string | null;
  steps: PriorityStep[];
  step_key_max?: number | null;
};

// ---------------------------------------------------------------- order

/** A priority's place on the one scale, as shared/contracts/priorities reads it. */
const orderKey = (r: PriorityOrderRow): number | null => r.person_pos ?? (r.rank_set_by === "person" ? r.rank : null) ?? r.ai_rank ?? r.rank ?? null;

/**
 * Where `id` goes in `order` (which lacks it): the index that agrees with
 * `planned` on the relative order of the most priorities, the nearest to its
 * planned index on a tie. A priority the plan does not order counts for
 * nothing. So a ticked move lands where the card said among what stays, even
 * when a move beside it was left unticked.
 */
function bestSlot(order: readonly string[], id: string, planned: readonly string[]): number {
  const at = new Map(planned.map((x, i) => [x, i]));
  const mine = at.get(id) ?? planned.length;
  let best = 0, bestCost = Infinity;
  for (let i = 0; i <= order.length; i++) {
    let cost = 0;
    order.forEach((x, j) => {
      const p = at.get(x);
      if (p !== undefined && j < i !== p < mine) cost++;
    });
    if (cost < bestCost || (cost === bestCost && Math.abs(i - mine) < Math.abs(best - mine))) { best = i; bestCost = cost; }
  }
  return best;
}

/** A key strictly between two neighbours' keys (undefined: no neighbour on that side), as placePriority picks one; null when none fits (equal keys, or a neighbour with no key). */
function keyBetween(lo: number | null | undefined, hi: number | null | undefined): number | null {
  if (lo === null || hi === null) return null;
  if (lo === undefined && hi === undefined) return 1;
  if (lo === undefined) return hi! - 1;
  if (hi === undefined) return lo + 1;
  const mid = (lo + hi) / 2;
  return lo < mid && mid < hi ? mid : null;
}

/** The group still has rows the rank backfill has not rewritten: their keys do not say their order, so no key is chosen between them. */
const legacyGroup = (rows: readonly PriorityOrderRow[]) => rows.some((r) => r.status === "active" && r.rank_set_by != null);

/**
 * Indexes of a longest increasing subsequence of `seq`. Among the longest,
 * the one whose kept elements' `score` sums highest; on a further tie the
 * earliest elements are kept.
 */
export function longestIncreasing(seq: readonly number[], score: readonly number[] = []): Set<number> {
  const len = seq.map(() => 1);
  const sum = seq.map((_, i) => score[i] ?? 0);
  const prev = seq.map(() => -1);
  const better = (l: number, s: number, i: number) => l > len[i] || (l === len[i] && s > sum[i]);
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) {
      if (seq[j] < seq[i] && better(len[j] + 1, sum[j] + (score[i] ?? 0), i)) { len[i] = len[j] + 1; sum[i] = sum[j] + (score[i] ?? 0); prev[i] = j; }
    }
  }
  let i = -1;
  for (let k = 0; k < seq.length; k++) if (i < 0 || len[k] > len[i] || (len[k] === len[i] && sum[k] > sum[i])) i = k;
  const keep = new Set<number>();
  while (i >= 0) { keep.add(i); i = prev[i]; }
  return keep;
}

// ---------------------------------------------------------------- milestones

/** A milestone whose done state its tasks or pull requests decide (applyPlan recomputes it): not the pass's judgment. */
const hasRecords = (st: { refs: Array<{ kind: string }> }) => st.refs.some((r) => r.kind === "task" || r.kind === "pr");
const doneHeld = (s: PriorityStep) => s.done_set_by === "person" || s.done_set_by === "evidence";
const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `keys` with each added key placed after the key it follows (`after`), or last when that is not there; null means first. */
function withAdded(keys: string[], added: Array<{ key: string; after: string | null }>): string[] {
  const out = [...keys];
  for (const a of added) {
    const at = a.after === null ? 0 : out.indexOf(a.after) + 1 || out.length;
    out.splice(at, 0, a.key);
  }
  return out;
}

/** The live plan step before index i, or null. */
const stepBefore = (steps: PriorityStep[], i: number): string | null => {
  for (let j = i - 1; j >= 0; j--) if (!steps[j].dropped) return steps[j].key;
  return null;
};

// ---------------------------------------------------------------- evidence

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

// ---------------------------------------------------------------- split

/** Priority-level rows first in a group, in this order; then milestones, each milestone's rows in this order. */
const KIND_ORDER: PriorityChangeKind[] = ["new_priority", "move", "rename", "done", "reopen", "serves", "merge", "new_milestone", "rename_milestone", "to_critical", "to_polish", "milestone_done", "milestone_reopen", "drop_milestone"];
const MILESTONE_KINDS = new Set<PriorityChangeKind>(["new_milestone", "rename_milestone", "to_critical", "to_polish", "milestone_done", "milestone_reopen", "drop_milestone"]);

type Draft = Omit<HeldChange, "id" | "parent"> & { id: string; parentOf?: Draft; milestone?: PriorityChange["milestone"] };
type DraftSession = Omit<HeldSession, "needs" | "step_from"> & { needs: Draft[]; step_from: Draft | null };

/**
 * Splits a pass's plan (mergePriorities over `input` and `output`) into what
 * applyPlan may write now and the card's changes.
 *
 * `direct` holds: session placements onto existing priorities (a milestone the
 * card adds is left off until it lands), unmaps, summaries, last_active_at and
 * pass_at, quiet<->active flips (a priority coming back active is slotted
 * where the plan put it without moving any other), the refs of existing
 * milestones (and the done state of one whose tasks or pull requests decide
 * it), the title of a priority the pass had to rewrite (`rewritten`: its old
 * words may tell of a session that left), and the notes.
 *
 * Everything else is one change each. A move is proposed only for a priority
 * outside a longest run that keeps its relative order, so one that shifts
 * because others moved gets no row; the order after the plan places the
 * priorities the person placed by the reply's rank too, since the card asks.
 */
export function splitPlan(plan: MergePlan, input: PriorityPassInput, output: PriorityPassOutput): SplitPlan {
  const prios = input.priorities;
  const byId = new Map(prios.map((p) => [p.short_id, p]));
  const updateOf = new Map(plan.updates.map((u) => [u.short_id, u]));
  const absorbed = new Map(plan.merges.map((m) => [m.short_id, m]));
  const rewritten = new Set(plan.rewritten);

  // The reply's rank for each priority it proposed, numbered as mergePriorities numbers new ones.
  const wanted = new Map<string, { rank: number; order: number }>();
  let made = 0;
  for (const [order, prop] of output.priorities.entries()) {
    const prior = prop.short_id ? byId.get(prop.short_id) : undefined;
    wanted.set(prior ? prior.short_id : `new-${++made}`, { rank: prop.rank, order });
  }

  const statusAfter = (p: { short_id: string; status: PriorityStatus }): PriorityStatus =>
    absorbed.has(p.short_id) ? "merged" : (updateOf.get(p.short_id)?.patch.status ?? p.status);

  // The order the plan leaves: priorities the reply left alone keep their order; the reply's (placed or not), new ones and returning ones are slotted at the rank they want.
  const orderBefore = effectivePriorityOrder(prios).map((p) => p.short_id);
  const activeAfter = [
    ...prios.filter((p) => statusAfter(p) === "active").map((p) => p.short_id),
    ...plan.creates.filter((c) => c.status === "active").map((c) => c.ref),
  ];
  const after = orderBefore.filter((id) => activeAfter.includes(id) && !wanted.has(id));
  const slotted = activeAfter.filter((id) => !after.includes(id)).map((id) => ({ id, at: wanted.get(id)?.rank ?? Infinity, order: wanted.get(id)?.order ?? Infinity, last: byId.get(id)?.last_active_at ?? 0 }))
    .sort((a, b) => a.at - b.at || a.order - b.order || b.last - a.last);
  for (const s of slotted) after.splice(Math.max(0, Math.min(s.at - 1, after.length)), 0, s.id);

  // The order as the person will see it once `direct` is written: quiet ones leave, returning ones are slotted where the plan put them.
  type Sim = CardRow & { id: string };
  const sims: Sim[] = prios.map((p) => ({ ...p, id: p.short_id }));
  const flips = new Map<string, Partial<PriorityWrite>>();
  for (const p of prios) {
    const to = updateOf.get(p.short_id)?.patch.status;
    if (to && to !== p.status && (to === "active" || to === "quiet") && (p.status === "active" || p.status === "quiet")) flips.set(p.short_id, { status: to, ...(to === "quiet" ? { ai_rank: null } : {}) });
  }
  for (const s of sims) if (flips.get(s.id)?.status === "quiet") Object.assign(s, { status: "quiet", ai_rank: null });
  for (const id of after.filter((id) => flips.get(id)?.status === "active")) {
    // Where the plan put it among the ones there now; last when no key fits there (the next card can move it).
    const ordered = effectivePriorityOrder(sims);
    const at = bestSlot(ordered.map((s) => s.id), id, after);
    const key = (legacyGroup(sims) ? null : keyBetween(at > 0 ? orderKey(ordered[at - 1]) : undefined, at < ordered.length ? orderKey(ordered[at]) : undefined)) ?? lastPriorityKey(sims);
    Object.assign(sims.find((s) => s.id === id)!, { status: "active", ai_rank: key });
    flips.get(id)!.ai_rank = key;
  }
  const orderNow = effectivePriorityOrder(sims).map((s) => s.id);
  const rankNow = (id: string) => (orderNow.includes(id) ? orderNow.indexOf(id) + 1 : null);

  const drafts = new Map<string, Draft[]>(); // per priority (short id or new-N)
  const add = (d: Omit<Draft, "id">): Draft => {
    const draft = { ...d, id: "" } as Draft;
    drafts.set(d.priority, [...(drafts.get(d.priority) ?? []), draft]);
    return draft;
  };
  /** Per "priority/key": the change that adds that milestone (a new milestone, or the merge that carries it). */
  const adders = new Map<string, Draft>();
  /** Per priority: the milestone order its rows are sorted by. */
  const stepOrder = new Map<string, string[]>();

  // Moves: the priorities outside a longest run kept in order. Of the longest, the one that keeps a priority whose slot is unchanged
  // (so no row says "to #2 from #2"), then the one that names the priorities the reply's rank moved the most.
  const common = orderNow.filter((id) => after.includes(id));
  const keepScore = common.map((id) => (rankNow(id) === after.indexOf(id) + 1 ? 1e6 : 0) - Math.abs((wanted.get(id)?.rank ?? rankNow(id)!) - rankNow(id)!));
  const keep = longestIncreasing(common.map((id) => after.indexOf(id)), keepScore);
  common.forEach((id, i) => {
    if (!keep.has(i)) add({ kind: "move", priority: id, from: rankNow(id), to: after.indexOf(id) + 1 });
  });

  // New priorities, with their milestones as children.
  const newDraft = new Map<string, Draft>();
  for (const c of plan.creates) {
    const parent = add({ kind: "new_priority", priority: c.ref, to: after.includes(c.ref) ? after.indexOf(c.ref) + 1 : null });
    newDraft.set(c.ref, parent);
    const carried = new Set(plan.merges.filter((m) => m.merged_into === c.ref).flatMap((m) => Object.values(m.step_keys)));
    c.steps.forEach((st, i) => {
      if (st.dropped || carried.has(st.key)) return;
      adders.set(`${c.ref}/${st.key}`, add({ kind: "new_milestone", priority: c.ref, step_key: st.key, parentOf: parent, to: st.title, step: st, after: stepBefore(c.steps, i) }));
    });
    stepOrder.set(c.ref, c.steps.map((s) => s.key));
  }

  // Merges, on the survivor's group; one into a new priority hangs off it.
  const mergeDraft = new Map<string, Draft>(); // absorbed short id -> its merge
  for (const m of plan.merges) {
    const gone = byId.get(m.short_id)!;
    const into = m.merged_into;
    const intoSteps = updateOf.get(into)?.patch.steps ?? plan.creates.find((c) => c.ref === into)?.steps ?? [];
    const carriedKeys = new Set(Object.values(m.step_keys));
    const d = add({
      kind: "merge", priority: into, target: m.short_id, from: gone.title, ...(newDraft.has(into) ? { parentOf: newDraft.get(into) } : {}),
      carried: intoSteps.filter((s) => carriedKeys.has(s.key)), step_keys: m.step_keys,
    });
    mergeDraft.set(m.short_id, d);
    for (const key of carriedKeys) adders.set(`${into}/${key}`, d);
  }

  // Existing priorities: what goes direct, and a row for each change.
  const direct: MergePlan = { creates: [], updates: [], merges: [], sessions: [], unmap: [...plan.unmap], notes: [...plan.notes], rewritten: [...plan.rewritten] };
  for (const u of plan.updates) {
    const p = byId.get(u.short_id);
    if (!p) continue;
    const patch = u.patch;
    const d: Partial<PriorityWrite> = { ...flips.get(p.short_id) };
    if (patch.summary !== undefined) d.summary = patch.summary;
    if (patch.last_active_at !== undefined) d.last_active_at = patch.last_active_at;
    if (patch.pass_at !== undefined) d.pass_at = patch.pass_at;
    if (patch.title !== undefined && patch.title !== p.title) {
      if (rewritten.has(p.short_id)) d.title = patch.title;
      else add({ kind: "rename", priority: p.short_id, from: p.title, to: patch.title });
    }
    if (patch.status !== undefined && patch.status !== p.status && !flips.has(p.short_id)) {
      if (patch.status === "done") add({ kind: "done", priority: p.short_id, from: p.status, to: "done" });
      else if (p.status === "done") add({ kind: "reopen", priority: p.short_id, from: "done", to: patch.status });
    }
    if (patch.serves !== undefined && patch.serves !== p.serves) add({ kind: "serves", priority: p.short_id, from: p.serves, to: patch.serves });

    const planSteps = patch.steps;
    if (planSteps) {
      const carried = new Set(plan.merges.filter((m) => m.merged_into === p.short_id).flatMap((m) => Object.values(m.step_keys)));
      const cur = new Map(p.steps.map((s) => [s.key, s]));
      const chip = (s: PriorityStep) => ({ title: s.title, state: s.done ? ("done" as const) : ("open" as const) });
      const added: Array<{ key: string; after: string | null }> = [];
      planSteps.forEach((ps, i) => {
        if (ps.dropped) return;
        const s = cur.get(ps.key);
        if (!s) {
          added.push({ key: ps.key, after: stepBefore(planSteps, i) });
          if (!carried.has(ps.key)) adders.set(`${p.short_id}/${ps.key}`, add({ kind: "new_milestone", priority: p.short_id, step_key: ps.key, to: ps.title, step: ps, after: stepBefore(planSteps, i) }));
          return;
        }
        if (s.dropped) return;
        const row = { priority: p.short_id, step_key: s.key, milestone: chip(s) };
        if (ps.title !== s.title && s.title_set_by !== "person") add({ kind: "rename_milestone", ...row, from: s.title, to: ps.title });
        if (ps.tier !== s.tier && s.tier_set_by !== "person") add({ kind: ps.tier === "critical" ? "to_critical" : "to_polish", ...row, from: s.tier, to: ps.tier });
        if (!hasRecords(ps) && ps.done !== s.done && !doneHeld(s)) add({ kind: ps.done ? "milestone_done" : "milestone_reopen", ...row, step: ps });
      });
      for (const s of p.steps) {
        if (!s.dropped && !isPersonHeld(s) && !planSteps.some((ps) => ps.key === s.key)) add({ kind: "drop_milestone", priority: p.short_id, step_key: s.key, milestone: chip(s) });
      }
      stepOrder.set(p.short_id, withAdded(p.steps.filter((s) => !s.dropped).map((s) => s.key), added));

      // Direct: the milestones as they are, with the plan's refs, and the done state of one its records decide.
      const steps = p.steps.map((s) => {
        const ps = planSteps.find((x) => x.key === s.key);
        if (!ps || s.dropped || ps.dropped) return s;
        if (!hasRecords(ps)) return { ...s, refs: ps.refs };
        const { done_at: _, ...rest } = s;
        return { ...rest, refs: ps.refs, done: ps.done, ...(ps.done_at !== undefined ? { done_at: ps.done_at } : {}) };
      });
      if (JSON.stringify(steps) !== JSON.stringify(p.steps)) d.steps = steps;
    }
    if (Object.keys(d).length) direct.updates.push({ short_id: p.short_id, patch: d, seen_steps: u.seen_steps });
  }

  // Sessions: onto an existing priority now (a milestone the card adds waits for it); onto a new priority, or carried by a merge, when that lands.
  const holder = new Map<string, string>();
  for (const p of prios) for (const s of p.sessions) holder.set(s.id, p.short_id);
  const waiting: DraftSession[] = [];
  for (const s of plan.sessions) {
    const from = holder.get(s.session);
    const merge = from && absorbed.get(from)?.merged_into === s.priority ? mergeDraft.get(from)! : null;
    const adder = s.step_key ? adders.get(`${s.priority}/${s.step_key}`) ?? null : null;
    const needs = [...(newDraft.has(s.priority) ? [newDraft.get(s.priority)!] : []), ...(merge ? [merge] : [])];
    if (needs.length) {
      waiting.push({ ...s, needs, step_from: adder });
      continue;
    }
    direct.sessions.push({ ...s, step_key: adder ? null : s.step_key });
    if (adder) waiting.push({ ...s, needs: [], step_from: adder });
  }

  // Groups: existing priorities by their place now (the rest after, as the input lists them), then new ones in plan order. Ids follow the groups.
  const rankKey = (id: string) => rankNow(id) ?? Infinity;
  const existing = [...drafts.keys()].filter((id) => byId.has(id)).sort((a, b) => rankKey(a) - rankKey(b) || prios.findIndex((p) => p.short_id === a) - prios.findIndex((p) => p.short_id === b));
  const created = plan.creates.map((c) => c.ref).filter((ref) => drafts.has(ref));
  const groups: PriorityCardGroup[] = [];
  const ordered: Draft[] = [];
  for (const id of [...existing, ...created]) {
    const keys = stepOrder.get(id) ?? [];
    const rows = [...drafts.get(id)!].sort((a, b) => {
      const ma = MILESTONE_KINDS.has(a.kind), mb = MILESTONE_KINDS.has(b.kind);
      if (ma !== mb) return ma ? 1 : -1;
      if (ma && a.step_key !== b.step_key) return keys.indexOf(a.step_key!) - keys.indexOf(b.step_key!);
      return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    });
    for (const r of rows) r.id = `c${ordered.push(r)}`;
    const create = plan.creates.find((c) => c.ref === id);
    const p = byId.get(id);
    groups.push({ priority: id, rank: create ? null : rankNow(id), title: create ? create.title : (rewritten.has(id) && updateOf.get(id)?.patch.title) || p!.title, changes: rows.map((r) => r.id) });
  }

  const heldChange = ({ parentOf, milestone: _, ...d }: Draft): HeldChange =>
    Object.fromEntries(Object.entries({ ...d, parent: parentOf?.id }).filter(([, v]) => v !== undefined)) as HeldChange;
  const changes: PriorityChange[] = ordered.map((d) => {
    const { step: _s, after: _a, carried: _c, step_keys: _k, ...row } = heldChange(d);
    return { ...row, ...(d.milestone ? { milestone: d.milestone } : {}), evidence: [] };
  });
  const held: HeldPlan = {
    v: 1,
    order: after,
    creates: plan.creates,
    changes: ordered.map(heldChange),
    sessions: waiting.map((s) => ({ ...s, needs: s.needs.map((d) => d.id), step_from: s.step_from?.id ?? null })),
  };
  return { direct, changes, groups, held };
}

// ---------------------------------------------------------------- answer

export type AcceptedPlan = {
  plan: MergePlan;
  /** Moves for the person's own move (priorityWrite doMove), in this order: each `to` is the slot among the active ones once the plan and the moves before it are written. */
  moves: Array<{ short_id: string; to: number }>;
  /** Ticked changes that no longer apply to the rows as they are (the person changed them since, or a parent was not ticked), and ticked rows whose parent was not. */
  skipped: string[];
};

/**
 * The write for the changes the person ticked, against `rowsNow` (every one
 * of the person's priorities in the card's workspace, as they stand now). A
 * ticked change that no longer applies is skipped: its priority was merged or
 * deleted, its milestone dropped, the person set the field since, or what it
 * adds is there already. A milestone of a new priority lands only with it,
 * and a session the run placed on a new priority or milestone only when that
 * lands. Every milestone added takes a key after every key the priority holds
 * now. `now` stamps a priority's done time.
 */
export function planForAccepted(held: HeldPlan, accepted: ReadonlySet<string>, rowsNow: readonly CardRow[], now: number): AcceptedPlan {
  const rows = new Map(rowsNow.map((r) => [r.short_id, r]));
  const live = (id: string) => {
    const r = rows.get(id);
    return r && r.status !== "merged" ? r : null;
  };
  const byId = new Map(held.changes.map((c) => [c.id, c]));
  const skipped: string[] = [];
  const landed = new Set<string>();
  const land = (c: HeldChange, ok: boolean) => (ok ? landed.add(c.id) : skipped.push(c.id));

  // New priorities and merges first: the rows below may hang off them.
  for (const c of held.changes.filter((c) => accepted.has(c.id) && c.kind === "new_priority")) {
    const create = held.creates.find((x) => x.ref === c.priority);
    // A priority a ticked merge folds into this one is not a duplicate of it: it is the same work under its old name.
    const absorbing = new Set(held.changes.filter((x) => x.kind === "merge" && x.parent === c.id && accepted.has(x.id)).map((x) => x.target));
    land(c, !!create && !rowsNow.some((r) => r.status !== "merged" && !absorbing.has(r.short_id) && sameTitle(r.title, create.title)));
  }
  const parentLanded = (c: HeldChange) => !c.parent || landed.has(c.parent);
  for (const c of held.changes.filter((c) => accepted.has(c.id) && c.kind === "merge")) {
    const gone = live(c.target!);
    const into = byId.has(c.parent ?? "") ? null : live(c.priority);
    land(c, parentLanded(c) && !!gone && gone.status !== "set_aside" && gone.status_set_by !== "person" && (!!c.parent || !!into));
  }

  const patches = new Map<string, Partial<PriorityWrite>>();
  const patchOf = (id: string) => {
    if (!patches.has(id)) patches.set(id, {});
    return patches.get(id)!;
  };
  /** "priority/plan key" -> the key a milestone added here takes. */
  const rekey = new Map<string, string>();
  const stepsNow = new Map<string, PriorityStep[]>();
  const stepsOf = (r: CardRow) => {
    if (!stepsNow.has(r.short_id)) stepsNow.set(r.short_id, r.steps.map((s) => ({ ...s })));
    return stepsNow.get(r.short_id)!;
  };
  const nextKey = new Map<string, number>();
  const freshKey = (r: CardRow, planKey: string) => {
    const n = (nextKey.get(r.short_id) ?? stepKeyMax(r.steps, r.step_key_max ?? 0)) + 1;
    nextKey.set(r.short_id, n);
    rekey.set(`${r.short_id}/${planKey}`, `s${n}`);
    return `s${n}`;
  };
  /** The live step key a plan key names on this priority now. */
  const keyNow = (priority: string, planKey: string) => rekey.get(`${priority}/${planKey}`) ?? planKey;
  /**
   * The step a new milestone follows, as a key the priority holds now: a
   * milestone the card adds that landed under its new key; one that did not
   * land hands over to the step it followed; one a merge carries goes last
   * (undefined); null is first.
   */
  const anchorNow = (priority: string, after: string | null | undefined): string | null | undefined => {
    for (let key = after ?? null; ;) {
      if (key === null) return null;
      const moved = rekey.get(`${priority}/${key}`);
      if (moved) return moved;
      const added = held.changes.find((x) => x.priority === priority && x.kind === "new_milestone" && x.step_key === key);
      if (added) { key = added.after ?? null; continue; }
      if (held.changes.some((x) => x.priority === priority && x.kind === "merge" && Object.values(x.step_keys ?? {}).includes(key!))) return undefined;
      return key;
    }
  };
  const pendingDone: Array<{ c: HeldChange; r: CardRow }> = [];

  for (const c of held.changes) {
    if (!accepted.has(c.id) || c.kind === "new_priority" || c.kind === "merge") continue;
    if (c.parent) {
      // A milestone of a new priority: it goes with its parent.
      land(c, landed.has(c.parent));
      continue;
    }
    const r = live(c.priority);
    if (!r) { skipped.push(c.id); continue; }
    const steps = stepsOf(r);
    const st = c.step_key ? steps.find((s) => s.key === c.step_key && !s.dropped) : undefined;
    switch (c.kind) {
      case "move":
      case "serves":
      case "rename":
        land(c, c.kind === "move" ? r.status === "active" : c.kind === "rename" ? r.title !== c.to : (r.serves ?? null) !== c.to);
        if (!landed.has(c.id)) break;
        if (c.kind === "rename") patchOf(r.short_id).title = c.to as string;
        if (c.kind === "serves") patchOf(r.short_id).serves = (c.to as string | null) ?? null;
        break;
      case "done":
        // Judged once the milestones are written (below): done needs its critical path done, or the next pass reopens it.
        if (r.status !== "done" && r.status !== "set_aside" && r.status_set_by !== "person") pendingDone.push({ c, r });
        else skipped.push(c.id);
        break;
      case "reopen":
        land(c, r.status === "done" && r.status_set_by !== "person");
        if (landed.has(c.id)) Object.assign(patchOf(r.short_id), { status: c.to, done_at: null });
        break;
      case "new_milestone": {
        const title = c.step!.title;
        land(c, !steps.some((s) => !s.dropped && sameTitle(s.title, title)) && !steps.some((s) => s.dropped && repeatsDropped(s.title, title)));
        if (!landed.has(c.id)) break;
        const anchor = anchorNow(r.short_id, c.after);
        const step = { ...c.step!, key: freshKey(r, c.step_key!) };
        const at = anchor === null ? 0 : anchor === undefined ? steps.length : steps.findIndex((s) => s.key === anchor) + 1 || steps.length;
        steps.splice(at, 0, step);
        break;
      }
      case "rename_milestone":
        land(c, !!st && st.title_set_by !== "person" && st.title !== c.to);
        if (landed.has(c.id)) st!.title = c.to as string;
        break;
      case "to_critical":
      case "to_polish": {
        const tier = c.kind === "to_critical" ? "critical" : "polish";
        land(c, !!st && st.tier_set_by !== "person" && st.tier !== tier);
        if (landed.has(c.id)) Object.assign(st!, { tier, tier_set_by: "pass" });
        break;
      }
      case "milestone_done":
      case "milestone_reopen": {
        const done = c.kind === "milestone_done";
        land(c, !!st && !doneHeld(st) && st.done !== done);
        if (!landed.has(c.id)) break;
        st!.done = done;
        if (done) st!.done_at = c.step?.done_at ?? now;
        else delete st!.done_at;
        break;
      }
      case "drop_milestone":
        land(c, !!st && !isPersonHeld(st));
        if (landed.has(c.id)) steps.splice(steps.indexOf(st!), 1);
        break;
    }
  }

  // Merges carry the absorbed priority's milestones onto the survivor (new keys on an existing one). Not its place, as a
  // pass's merge would: the person approved the order the card showed, so the survivor lands there like any other.
  const merges: MergePlan["merges"] = [];
  for (const c of held.changes.filter((c) => c.kind === "merge" && landed.has(c.id))) {
    const into = c.parent ? null : live(c.priority)!;
    const step_keys: Record<string, string> = {};
    for (const [from, to] of Object.entries(c.step_keys ?? {})) step_keys[from] = into ? keyNow(into.short_id, to) : to;
    if (into) {
      const steps = stepsOf(into);
      for (const st of c.carried ?? []) {
        const key = freshKey(into, st.key);
        steps.push({ ...st, key });
        for (const [from, to] of Object.entries(c.step_keys ?? {})) if (to === st.key) step_keys[from] = key;
      }
    }
    merges.push({ short_id: c.target!, merged_into: c.priority, step_keys });
  }
  for (const { c, r } of pendingDone) {
    land(c, criticalDone(stepsOf(r)));
    if (landed.has(c.id)) Object.assign(patchOf(r.short_id), { status: "done", done_at: now, ai_rank: null });
  }
  for (const [id, steps] of stepsNow) {
    const r = rows.get(id)!;
    if (JSON.stringify(steps) !== JSON.stringify(r.steps)) patchOf(id).steps = steps;
  }

  const creates: MergePlan["creates"] = [];
  for (const c of held.changes.filter((c) => c.kind === "new_priority" && landed.has(c.id))) {
    const create = held.creates.find((x) => x.ref === c.priority)!;
    const kept = new Set(held.changes.filter((x) => x.parent === c.id && x.kind === "new_milestone" && landed.has(x.id)).map((x) => x.step_key));
    const carried = new Set(held.changes.filter((x) => x.parent === c.id && x.kind === "merge" && landed.has(x.id)).flatMap((x) => (x.carried ?? []).map((s) => s.key)));
    const { person_pos: _, ...rest } = create;
    creates.push({ ...rest, steps: create.steps.filter((s) => kept.has(s.key) || carried.has(s.key)) });
  }

  // The order once all of it is written (`final`): every ticked mover taken out, then the movers and the priorities that enter
  // (new, or reopened) put back in the plan's order, each where it agrees with the plan most among what is there. So with
  // everything ticked the list is the card's, and a priority nobody ticked keeps its order among the rest.
  type Sim = PriorityOrderRow & { id: string };
  const sims: Sim[] = rowsNow.filter((r) => r.status !== "merged").map((r) => ({ ...r, id: r.short_id }));
  for (const m of merges) {
    const gone = sims.find((s) => s.id === m.short_id);
    if (gone) gone.status = "merged";
  }
  for (const s of sims) {
    const p = patches.get(s.id);
    if (p?.status) Object.assign(s, { status: p.status, ai_rank: null });
  }
  const planned = (id: string) => (held.order.includes(id) ? held.order.indexOf(id) : Infinity);
  const entering = [
    ...sims.filter((s) => s.status === "active" && patches.get(s.id)?.status === "active").map((s) => s.id),
    ...creates.filter((c) => c.status === "active").map((c) => c.ref),
  ];
  for (const s of sims) if (entering.includes(s.id)) s.status = "quiet"; // not in the list until it is put back below
  const base = effectivePriorityOrder(sims).map((s) => s.id);
  const movers = new Set<string>();
  for (const c of held.changes.filter((c) => c.kind === "move" && landed.has(c.id))) {
    if (base.includes(c.priority)) movers.add(c.priority);
    else {
      landed.delete(c.id);
      skipped.push(c.id);
    }
  }
  const final = base.filter((id) => !movers.has(id));
  for (const id of [...movers, ...entering].sort((a, b) => planned(a) - planned(b))) final.splice(bestSlot(final, id, held.order), 0, id);

  // Keys for the entering ones: each run of them between two that stay spread between their keys, which moves no other.
  // Where no key fits (equal keys, a neighbour without one, a group the rank backfill has not reached), it goes last and
  // the person's own move puts it in its place, with the movers.
  const keyed = final.filter((id) => !movers.has(id));
  const keyOf = (id: string) => orderKey(sims.find((s) => s.id === id)!);
  const legacy = legacyGroup(sims);
  const placeBy = new Set<string>();
  const keyFor = new Map<string, number>();
  for (let k = 0; k < keyed.length;) {
    if (!entering.includes(keyed[k])) { k++; continue; }
    let end = k;
    while (end < keyed.length && entering.includes(keyed[end])) end++;
    const lo = k > 0 ? keyOf(keyed[k - 1]) : undefined;
    const hi = end < keyed.length ? keyOf(keyed[end]) : undefined;
    const run = keyed.slice(k, end);
    const fits = !legacy && keyBetween(lo, hi) !== null;
    run.forEach((id, t) => {
      if (!fits) { placeBy.add(id); return; }
      const key = lo !== undefined && hi !== undefined ? lo! + ((hi! - lo!) * (t + 1)) / (run.length + 1) : hi !== undefined ? hi! - (run.length - t) : (lo ?? 0) + t + 1;
      keyFor.set(id, key);
    });
    k = end;
  }
  let last = lastPriorityKey(sims.filter((s) => !entering.includes(s.id)));
  for (const id of entering) {
    const key = keyFor.get(id) ?? last++;
    const sim = sims.find((s) => s.id === id);
    if (sim) Object.assign(sim, { status: "active", ai_rank: key });
    else sims.push({ id, status: "active", ai_rank: key, last_active_at: creates.find((c) => c.ref === id)!.last_active_at });
    const create = creates.find((c) => c.ref === id);
    if (create) create.ai_rank = key;
    else patchOf(id).ai_rank = key;
  }
  for (const c of creates) if (c.status !== "active") c.ai_rank = null;

  // The person's own moves that turn the written order into `final`, one after another: each, in final's order, goes just
  // after the last one before it in final that is already in place. A ticked move whose priority is there already is
  // reported, as a rename to the same title is.
  const written = effectivePriorityOrder(sims).map((s) => s.id);
  const sequence = (moving: Set<string>) => {
    const order = [...written];
    const out: AcceptedPlan["moves"] = [];
    const pending = new Set(moving);
    for (const id of final.filter((x) => pending.has(x))) {
      pending.delete(id);
      const from = order.indexOf(id);
      order.splice(from, 1);
      const before = final.slice(0, final.indexOf(id)).filter((x) => !pending.has(x));
      let at = 0;
      for (let i = order.length - 1; i >= 0; i--) if (before.includes(order[i])) { at = i + 1; break; }
      order.splice(at, 0, id);
      if (at !== from) out.push({ short_id: id, to: at + 1 });
    }
    return { order, moves: out };
  };
  // Already applied: before any move, it sits among the ones that stay as `final` has it (the person moved it there since).
  // It is reported, and makes no move of its own when the rest still lands as `final` without it.
  const stays = (id: string, list: string[]) => list.filter((x) => x === id || !movers.has(x));
  const applied = [...movers].filter((id) => JSON.stringify(stays(id, written)) === JSON.stringify(stays(id, final)));
  for (const id of applied) {
    const c = held.changes.find((x) => x.kind === "move" && x.priority === id && landed.has(x.id))!;
    landed.delete(c.id);
    skipped.push(c.id);
  }
  const all = new Set([...movers, ...placeBy]);
  const lean = sequence(new Set([...all].filter((id) => !applied.includes(id))));
  const { moves } = JSON.stringify(lean.order) === JSON.stringify(final) ? lean : sequence(all);

  const updates: MergePlan["updates"] = [...patches].map(([short_id, patch]) => ({ short_id, patch, seen_steps: rows.get(short_id)!.steps.map((s) => s.key) }));

  // Sessions the run placed that waited on the card.
  const sessions: MergePlan["sessions"] = [];
  for (const s of held.sessions) {
    if (!s.needs.every((id) => landed.has(id))) continue;
    const stepLands = !!s.step_from && landed.has(s.step_from);
    if (!s.needs.length && !stepLands) continue;
    const step_key = stepLands && s.step_key ? (live(s.priority) ? keyNow(s.priority, s.step_key) : s.step_key) : null;
    sessions.push({ session: s.session, priority: s.priority, step_key });
  }

  for (const c of held.changes) if (accepted.has(c.id) && !landed.has(c.id) && !skipped.includes(c.id)) skipped.push(c.id);
  return { plan: { creates, updates, merges, sessions, unmap: [], notes: [], rewritten: [] }, moves, skipped };
}
