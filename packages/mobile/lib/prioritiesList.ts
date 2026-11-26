// What the phone's Priorities list (app/priorities.tsx) says and offers, as
// pure functions over web's models (lib/priorityList), so they are tested
// without React Native: which milestone lines a priority shows, each line's
// one trailing thing, the stats line's words, and the owner's ⋯ menus as
// sheet rows whose presses are web's writes (lib/priorityWrites).
import type { PriorityRow, PriorityStep } from '@codecast/shared/contracts/priorities';
import { asksPerson, type NextAction } from '@codecast/shared/contracts/priorityDerive';
import { STATE_WORD, lineSession, type Landed, type MilestoneModel, type PriorityModel, type SessionLine } from '@codecast/web/lib/priorityList';
import { rankProvenance, type PriorityWrites } from '@codecast/web/lib/priorities';
import type { SheetItem } from './popups';

/** Waiting on you shows this many rows before "+N more". */
export const WAITING_SHOWN = 3;

/**
 * The milestone lines a priority shows: its open critical ones, the done ones
 * once its progress is pressed, then polish. Collapsed polish still shows the
 * line holding the priority's action and any line asking the person, so
 * nothing waiting is out of sight (web's PriorityBlock).
 */
export function shownLines(model: Pick<PriorityModel, 'milestones' | 'action'>, open: { done: boolean; polish: boolean }): { critical: MilestoneModel[]; polish: MilestoneModel[] } {
  const critical = model.milestones.filter((m) => m.tier === 'critical');
  const polish = model.milestones.filter((m) => m.tier === 'polish');
  return {
    critical: [...critical.filter((m) => !m.done), ...(open.done ? critical.filter((m) => m.done) : [])],
    polish: polish.filter((m) => (open.polish ? !m.done || open.done : model.action?.milestone.key === m.key || m.sessions.some(asksPerson))),
  };
}

/** A line's one trailing thing: the priority's action, an outlined Answer, or its session's state in a word. */
export type LineTrail =
  | { kind: 'action'; action: NextAction<MilestoneModel> }
  | { kind: 'answer'; session: SessionLine }
  | { kind: 'state'; word: string };

export function lineTrail(model: Pick<PriorityModel, 'action'>, m: MilestoneModel): LineTrail | null {
  if (m.done) return null;
  if (model.action?.milestone.key === m.key) return { kind: 'action', action: model.action };
  const s = lineSession(model, m);
  if (!s) return null;
  return asksPerson(s) ? { kind: 'answer', session: s } : { kind: 'state', word: STATE_WORD[s.state] };
}

/** The stats line: critical milestones landed over the shown days, and "N% top 3 today" once anything was typed today. */
export function statsWords(landed: Map<string, Landed[]>, days: readonly string[], today: { total: number; topPct: number }): { landed: number; today: string | null } {
  const n = days.reduce((c, d) => c + (landed.get(d) ?? []).filter((l) => l.tier === 'critical').length, 0);
  return { landed: n, today: today.total > 0 ? `${today.topPct}% top 3 today` : null };
}

/** Critical landings per shown day, for the band's bars. */
export function landedPerDay(landed: Map<string, Landed[]>, days: readonly string[]): number[] {
  return days.map((d) => (landed.get(d) ?? []).filter((l) => l.tier === 'critical').length);
}

/** "3 landed · last 2d", or "· stalled 6d" in place of how long since. */
export function momentumWords(model: Pick<PriorityModel, 'landed10' | 'lastLandedDays' | 'stalledDays'>): string {
  const since = model.stalledDays != null
    ? `stalled ${model.stalledDays}d`
    : model.lastLandedDays == null ? 'none yet' : model.lastLandedDays === 0 ? 'last today' : `last ${model.lastLandedDays}d`;
  return `${model.landed10} landed · ${since}`;
}

/** What a sheet row asks the screen to open next: a second sheet, a prompt, or a confirm. */
export type MenuUi = {
  moveTo: () => void;
  mergeInto: () => void;
  correct: () => void;
  copyLink: () => void;
  open: () => void;
};

/**
 * The priority's ⋯ (web's PriorityMenu): who placed it, then for the owner
 * the moves, done, set aside or restore, merge and Correct…; Open and Copy
 * link for anyone. `own` is the owner's active priorities in order.
 */
export function priorityMenu(row: PriorityRow, own: readonly PriorityRow[], writes: PriorityWrites, ui: MenuUi): { title: string; items: SheetItem[] } {
  const rank = row.status === 'active' ? row.rank : null;
  const why = rank != null ? rankProvenance(row) : null;
  const items: SheetItem[] = [{ label: 'Open', icon: 'arrow-right', onPress: ui.open }];
  if (row.mine) {
    const count = Math.max(own.length, rank ?? 0);
    if (rank != null && rank > 1) items.push({ label: 'Move up', icon: 'arrow-up', onPress: () => writes.move(row.short_id, 'up') });
    if (rank != null && rank < count) items.push({ label: 'Move down', icon: 'arrow-down', onPress: () => writes.move(row.short_id, 'down') });
    if (rank != null && count > 1) items.push({ label: 'Move to #…', icon: 'hash', onPress: ui.moveTo });
    if (row.status !== 'done') items.push({ label: 'Mark done', icon: 'check-square', onPress: () => writes.markDone(row.short_id) });
    if (row.status === 'active') items.push({ label: 'Set aside', icon: 'archive', onPress: () => writes.setAside(row.short_id) });
    if (row.status === 'set_aside' || row.status === 'done') items.push({ label: 'Restore', icon: 'rotate-ccw', onPress: () => writes.restore(row.short_id) });
    if (row.status === 'active' && own.some((r) => r.short_id !== row.short_id)) items.push({ label: 'Merge into…', icon: 'git-merge', onPress: ui.mergeInto });
    items.push({ label: 'Correct…', icon: 'edit-3', onPress: ui.correct });
  }
  items.push({ label: 'Copy link', icon: 'link', onPress: ui.copyLink });
  return { title: why ? `#${rank} · ${why}` : row.title, items };
}

/** Move to #…: every place in the owner's order, the current one marked. */
export function moveToItems(row: PriorityRow, own: readonly PriorityRow[], writes: PriorityWrites): SheetItem[] {
  const rank = row.status === 'active' ? row.rank : null;
  const count = Math.max(own.length, rank ?? 0);
  return Array.from({ length: count }, (_, i) => i + 1).map((n) => ({
    label: `#${n}`,
    selected: n === rank,
    onPress: () => { if (n !== rank) writes.move(row.short_id, n); },
  }));
}

/** The milestone's ⋯ (web's MilestoneMenu), for the owner: Done or Undone, Rename, its tier, Drop, Correct…. */
export function milestoneMenu(row: PriorityRow, step: PriorityStep, writes: PriorityWrites, ui: { rename: () => void; drop: () => void; correct: () => void }): SheetItem[] {
  const polish = step.tier === 'polish';
  return [
    { label: step.done ? 'Undone' : 'Done', icon: step.done ? 'square' : 'check-square', onPress: () => writes.setStepDone(row.short_id, step.key, !step.done) },
    { label: 'Rename', icon: 'type', onPress: ui.rename },
    { label: polish ? 'Move to critical' : 'Move to polish', icon: polish ? 'arrow-up-circle' : 'arrow-down-circle', onPress: () => writes.setStepTier(row.short_id, step.key, polish ? 'critical' : 'polish') },
    { label: 'Drop…', icon: 'trash-2', destructive: true, onPress: ui.drop },
    { label: 'Correct…', icon: 'edit-3', onPress: ui.correct },
  ];
}

/** A session's ⋯ under a milestone (web's SessionMenu), for the owner of both: off this milestone, off this priority, or to another milestone. */
export function sessionMenu(row: PriorityRow, s: Pick<SessionLine, 'short_id'>, stepKey: string | null, writes: PriorityWrites, ui: { moveTo: () => void }): SheetItem[] {
  return [
    ...(stepKey ? [{ label: 'Not this milestone', icon: 'minus-circle' as const, onPress: () => writes.moveSession(s.short_id, row.short_id, row.short_id, null) }] : []),
    { label: 'Not this priority', icon: 'x-circle', onPress: () => writes.sessionNotThis(s.short_id, row.short_id) },
    { label: 'Move to…', icon: 'corner-down-right', onPress: ui.moveTo },
  ];
}

/** An open milestone a session can move to: this priority's other ones first, then each of the owner's other active priorities'. */
export function sessionTargets(row: PriorityRow, own: readonly PriorityRow[], stepKey: string | null): Array<{ priority: PriorityRow; step: PriorityStep }> {
  const open = (r: PriorityRow) => r.steps.filter((st) => !st.done && !st.dropped);
  const here = open(row).filter((st) => st.key !== stepKey).sort((a, b) => Number(a.tier === 'polish') - Number(b.tier === 'polish'));
  return [
    ...here.map((step) => ({ priority: row, step })),
    ...own.filter((r) => r.short_id !== row.short_id).flatMap((r) => open(r).map((step) => ({ priority: r, step }))),
  ];
}
