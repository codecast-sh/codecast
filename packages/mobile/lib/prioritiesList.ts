// What the phone's priorities (the list, app/priorities.tsx, and a priority's
// screen, app/priority/[id].tsx) say and offer, as pure functions over web's
// models (lib/priorityList), so they are tested without React Native: each
// milestone's mark, the DONE and POLISH sections, an open milestone's
// connected groups, the ten-day bars, the owner's ⋯ menus as sheet rows
// whose presses are web's writes (lib/priorityWrites), and the list's
// sections per workspace and person as the rows it draws in order.
import type { PriorityPlanRef, PriorityRow, PriorityStep } from '@codecast/shared/contracts/priorities';
import { isClosedSession, orderByState, type MilestoneStateKind } from '@codecast/shared/contracts/priorityDerive';
import { MILESTONE_STATE_WORD, ago, type MilestoneModel, type PriorityModel, type SessionLine } from '@codecast/web/lib/priorityList';
import { milestoneStart, rankProvenance, type PriorityWrites } from '@codecast/web/lib/priorities';
import { GROUP_BY_LABEL, type GroupBy, type Sections } from '@codecast/web/lib/prioritySections';
import type { SessionStatus } from '@codecast/web/lib/sessionStatus';
import type { SessionStart } from '@codecast/web/store/composeSlice';
import type { ComposeTask } from './compose';
import type { SheetItem } from './popups';

// ── A milestone's mark ──────────────────────────────────────────────────

/**
 * What a milestone's first column draws. Only two marks are actions: Needs
 * you opens the session to answer, New session opens the composer seeded
 * with the milestone's brief. The rest are a session state's mark alone.
 */
export type MilestoneMark =
  | { kind: 'needs_you'; session: SessionLine; label: string }
  | { kind: 'start'; label: string }
  | { kind: 'quiet'; status: SessionStatus; label: string }
  /** Nobody on it and nothing to start (a teammate's, a past priority's): an empty box. */
  | { kind: 'none' };

const QUIET_STATUS: Record<Exclude<MilestoneStateKind, 'needs_you' | 'start' | 'none'>, SessionStatus> = { working: 'working', dormant: 'dormant', idle: 'idle', done: 'done' };

export function milestoneMark(m: Pick<MilestoneModel, 'state'>): MilestoneMark {
  const { kind, session } = m.state;
  if (kind === 'needs_you') return session ? { kind: 'needs_you', session, label: `Needs you: ${sessionLabel(session)}` } : { kind: 'none' };
  if (kind === 'start') return { kind: 'start', label: 'New session on this milestone' };
  if (kind === 'none') return { kind: 'none' };
  return { kind: 'quiet', status: QUIET_STATUS[kind], label: MILESTONE_STATE_WORD[kind] };
}

type TaskRow = { _id?: string; short_id?: string; title?: string; status?: string };

/**
 * New session on a milestone, as web starts it: the composer seeded with the
 * same brief (milestones, open tasks and plan as live references) and the
 * session linked at creation to the priority, the milestone and its plan,
 * and bound to the milestone's first open task (the store's row, by its id).
 */
export function startCompose(
  row: Parameters<typeof milestoneStart>[0],
  m: Parameters<typeof milestoneStart>[1],
  task: (shortId: string) => TaskRow | undefined,
): { seed: string; start: SessionStart; task: ComposeTask | null } {
  const { draft, start, task: first } = milestoneStart(row, m, task);
  const t = first ? task(first) : undefined;
  return { seed: draft, start, task: first && t?._id ? { _id: String(t._id), short_id: first, title: t.title, status: t.status } : null };
}

// ── Sections ────────────────────────────────────────────────────────────

export type SectionKind = 'done' | 'polish';
export type MilestoneSection = { kind: SectionKind; label: string; count: string; rows: MilestoneModel[] };

/**
 * A priority's milestones: its open critical ones and any that need you, then DONE n and POLISH x/y, Done first, each
 * only when its fold holds any. A milestone that reads Needs you, whatever its tier and whether done, sits with the open
 * ones, never folded. DONE n counts its fold; POLISH x/y counts every polish milestone (x the done ones), asking or not.
 */
export function milestoneSections(model: Pick<PriorityModel, 'milestones'>): { open: MilestoneModel[]; sections: MilestoneSection[] } {
  const unfolded = (m: MilestoneModel) => m.state.kind === 'needs_you' || (m.tier === 'critical' && !m.done);
  const polish = model.milestones.filter((m) => m.tier === 'polish');
  const done = model.milestones.filter((m) => m.tier === 'critical' && !unfolded(m));
  const polishFolded = polish.filter((m) => !unfolded(m));
  const sections: MilestoneSection[] = [];
  if (done.length) sections.push({ kind: 'done', label: 'Done', count: `${done.length}`, rows: done });
  if (polishFolded.length) sections.push({ kind: 'polish', label: 'Polish', count: `${polish.filter((m) => m.done).length}/${polish.length}`, rows: polishFolded });
  return { open: model.milestones.filter(unfolded), sections };
}

/** Sections in order: closed ones side by side share a line; an open one is its head over its milestones. */
export function sectionRuns(sections: readonly MilestoneSection[], open: ReadonlySet<SectionKind>): Array<{ open: boolean; sections: MilestoneSection[] }> {
  const runs: Array<{ open: boolean; sections: MilestoneSection[] }> = [];
  for (const s of sections) {
    const isOpen = open.has(s.kind);
    const last = runs[runs.length - 1];
    if (!isOpen && last && !last.open) last.sections.push(s);
    else runs.push({ open: isOpen, sections: [s] });
  }
  return runs;
}

// ── An open milestone ───────────────────────────────────────────────────

const WORKFLOW_TITLE = /^([A-Z][A-Za-z]+) · ((?:ct|pl)-\d+)\s*(.*)$/;

/** The task or plan a workflow step's session works on ("Review · ct-9 tidy" → "ct-9"), or null for any other title. */
export const workflowRef = (title: string): string | null => WORKFLOW_TITLE.exec(title)?.[2] ?? null;

/** A session's title; a workflow step's ("Review · ct-9 tidy") reads as what it works on, "Review: <task title>", never its id. */
export function sessionLabel(s: Pick<SessionLine, 'title'>, titleOf: (shortId: string) => string | undefined = () => undefined): string {
  const m = WORKFLOW_TITLE.exec(s.title);
  if (!m) return s.title || 'Untitled session';
  return `${m[1]}: ${titleOf(m[2]) || m[3] || 'work'}`;
}

/** "6m ago", "just now". */
export const age = (ts: number, now: number) => { const a = ago(ts, now); return a === 'just now' ? a : `${a} ago`; };

export type Connected = {
  /** Live sessions, sorted the way the sidebar files them: needs you, working, sleeping, idle, then the most recent. */
  live: SessionLine[];
  /** Finished or closed, folded under "› n closed". */
  closed: SessionLine[];
  /** Linked sessions the row does not carry. */
  more: number;
  tasks: string[];
  prs: string[];
  plans: Array<{ plan: PriorityPlanRef; partOf: boolean }>;
};

/**
 * Everything an open milestone is connected to, grouped by kind. Its plans
 * are its own and the big plans it is part of: the priority's plan is never
 * repeated under a milestone, on the list or the screen (web Connected).
 */
export function connectedOf(m: MilestoneModel): Connected {
  const sessions = orderByState(m.sessions);
  const own = m.plan;
  return {
    live: sessions.filter((s) => !isClosedSession(s)),
    closed: sessions.filter(isClosedSession),
    more: m.more,
    tasks: m.tasks,
    prs: m.prs,
    plans: [...(own ? [{ plan: own, partOf: false }] : []), ...m.partOf.map((plan) => ({ plan, partOf: true }))],
  };
}

// ── Ten days ────────────────────────────────────────────────────────────

/** A day's bar, on the shared scale `peak`, shaded by how much was typed: an empty day is a 2px line. */
export function dayBar(count: number, peak: number, max: number): { height: number; opacity: number } {
  const top = Math.max(1, peak);
  const share = Math.sqrt(Math.min(count, top) / top);
  return count <= 0 ? { height: 2, opacity: 1 } : { height: Math.max(4, Math.round(share * max)), opacity: 0.45 + 0.55 * share };
}

/** A day under the priority screen's strip: "Today", else its day of the month. */
export const dayLabel = (day: string, today: boolean) => (today ? 'Today' : String(Number(day.slice(8))));

// ── Menus ───────────────────────────────────────────────────────────────

/** What a sheet row asks the screen to open next: a second sheet, a prompt, or a confirm. `open` is left out on the priority's own screen. */
export type MenuUi = {
  open?: () => void;
  rename: () => void;
  moveTo: () => void;
  mergeInto: () => void;
  correct: () => void;
  copyLink: () => void;
};

/**
 * The priority's ⋯ (web's PriorityMenu): who placed it, then for the owner
 * Rename, the moves, done, set aside or restore, merge and Correct…; Open
 * and Copy link for anyone. `own` is the owner's active priorities in order.
 */
export function priorityMenu(row: PriorityRow, own: readonly PriorityRow[], writes: PriorityWrites, ui: MenuUi): { title: string; items: SheetItem[] } {
  const rank = row.status === 'active' ? row.rank : null;
  const why = rank != null ? rankProvenance(row) : null;
  const items: SheetItem[] = ui.open ? [{ label: 'Open', icon: 'arrow-right', onPress: ui.open }] : [];
  if (row.mine) {
    const count = Math.max(own.length, rank ?? 0);
    items.push({ label: 'Rename', icon: 'type', onPress: ui.rename });
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

/**
 * A session's ⋯ under a milestone (web's SessionMenu), for the session's
 * owner or the priority's, else null. For the owner of both: off this
 * milestone, off this priority, or to another milestone; when one of them is
 * someone else's, off this priority alone.
 */
export function sessionMenu(row: Pick<PriorityRow, 'short_id' | 'mine'>, s: Pick<SessionLine, 'short_id' | 'mine' | 'started_by_viewer'>, stepKey: string | null, writes: PriorityWrites, ui: { moveTo: () => void }): SheetItem[] | null {
  // As the server takes it (doSessionNotThis, doSessionMove): the session's starter, never a co-owner.
  const started = s.started_by_viewer ?? s.mine;
  if (!row.mine && !started) return null;
  const notThis: SheetItem = { label: 'Not this priority', icon: 'x-circle', onPress: () => writes.sessionNotThis(s.short_id, row.short_id) };
  if (!(row.mine && started)) return [notThis];
  return [
    ...(stepKey ? [{ label: 'Not this milestone', icon: 'minus-circle' as const, onPress: () => writes.moveSession(s.short_id, row.short_id, row.short_id, null) }] : []),
    notThis,
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

// ── The list's sections ─────────────────────────────────────────────────

/** A heading's mark: a workspace's icon, or a person's face (their first row carries it). */
export type HeadingMark = { workspace: string } | { face: Pick<PriorityRow, 'owner' | 'owner_image' | 'mine'> } | null;

/**
 * What the list draws, top to bottom. A `top` heading is a section's own (a
 * workspace, or a person grouped first); otherwise it labels a group inside
 * one. `face` puts the owner's face after the rank (Workspace grouping). A
 * fold is a group's last row, its done and set-aside priorities folded.
 */
export type ListItem =
  | { kind: 'heading'; key: string; top: boolean; mark: HeadingMark; name: string; count?: number }
  | { kind: 'priority'; key: string; row: PriorityRow; face: boolean }
  | { kind: 'fold'; key: string; rows: PriorityRow[]; face: boolean };

/**
 * Web's PrioritySections as rows: `headings` (more than one workspace shown)
 * gives each workspace its heading, `people` (a teammate is on the page)
 * labels each person inside one.
 */
export function sectionItems(sections: Sections, { headings, people }: { headings: boolean; people: boolean }): ListItem[] {
  const out: ListItem[] = [];
  const group = (key: string, active: readonly PriorityRow[], past: PriorityRow[], face = false) => {
    for (const row of active) out.push({ kind: 'priority', key: row.short_id, row, face });
    if (past.length) out.push({ kind: 'fold', key: `${key}/past`, rows: past, face });
  };
  const faceOf = (rows: readonly PriorityRow[]): HeadingMark => (rows[0] ? { face: rows[0] } : null);
  if (sections.groupBy === 'workspace') {
    for (const s of sections.sections) {
      if (headings) out.push({ kind: 'heading', key: s.key, top: true, mark: { workspace: s.key }, name: s.name, count: s.active.length });
      group(s.key, s.active.map((x) => x.row), s.past, true);
    }
  } else if (sections.groupBy === 'person_workspace') {
    for (const p of sections.sections) {
      const first = p.workspaces.flatMap((w) => [...w.active, ...w.past]);
      out.push({ kind: 'heading', key: p.user_id, top: true, mark: faceOf(first), name: p.mine ? 'You' : p.owner, count: p.workspaces.reduce((n, w) => n + w.active.length, 0) });
      for (const w of p.workspaces) {
        out.push({ kind: 'heading', key: `${p.user_id}/${w.key}`, top: false, mark: { workspace: w.key }, name: w.name });
        group(`${p.user_id}/${w.key}`, w.active, w.past);
      }
    }
  } else {
    for (const s of sections.sections) {
      if (headings) out.push({ kind: 'heading', key: s.key, top: true, mark: { workspace: s.key }, name: s.name, count: s.people.reduce((n, p) => n + p.active.length, 0) });
      for (const p of s.people) {
        if (people) out.push({ kind: 'heading', key: `${s.key}/${p.user_id}`, top: false, mark: faceOf([...p.active, ...p.past]), name: p.mine ? 'You' : p.owner });
        group(`${s.key}/${p.user_id}`, p.active, p.past);
      }
    }
  }
  return out;
}

/** Every priority the list draws, open or folded: their models share one scale. */
export const itemRows = (items: readonly ListItem[]): PriorityRow[] =>
  items.flatMap((i) => (i.kind === 'priority' ? [i.row] : i.kind === 'fold' ? i.rows : []));

/** A workspace chip's press: turn it off, or back on. */
export const toggleHidden = (hidden: readonly string[], key: string): string[] =>
  hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];

/** Group by as a picker sheet: the options pageControls offers, the current one checked. */
export function groupBySheet(options: readonly GroupBy[], value: GroupBy, choose: (g: GroupBy) => void): SheetItem[] {
  return options.map((g) => ({ label: GROUP_BY_LABEL[g], selected: g === value, onPress: () => { if (g !== value) choose(g); } }));
}
