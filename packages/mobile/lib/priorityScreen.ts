// What the phone's priority screen (app/priority/[id].tsx) says, as pure
// functions over web's models (lib/priorityList), so they are tested without
// React Native: the rank with who placed it (or why it is past), the Next
// block's button and words, and what a milestone's box does when pressed.
import type { PriorityRow } from '@codecast/shared/contracts/priorities';
import type { NextAction } from '@codecast/shared/contracts/priorityDerive';
import { rankProvenance } from '@codecast/web/lib/priorities';
import type { MilestoneModel, SessionLine } from '@codecast/web/lib/priorityList';

const shortDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export const VERB = { answer: 'Answer', open: 'Open', resume: 'Resume', start: 'Start' } as const;

export const sessionLabel = (s: Pick<SessionLine, 'title'>) => s.title || 'Untitled session';

/** Where the priority stands, first on the meta line: "#7 · ranked by AI", or why it is past. */
export function standing(row: Pick<PriorityRow, 'status' | 'rank' | 'rank_source' | 'mine' | 'owner' | 'done_at' | 'last_active_at'>): string {
  if (row.status === 'active' && row.rank != null) return `#${row.rank} · ${rankProvenance(row)}`;
  if (row.status === 'done') return row.done_at ? `Done ${shortDate(row.done_at)}` : 'Done';
  if (row.status === 'quiet') return `Quiet since ${shortDate(row.last_active_at)}`;
  if (row.status === 'merged') return 'Merged';
  return 'Set aside';
}

/** The owner's name on the meta line, unless the standing already names a teammate who placed it. */
export function ownerWords(row: Pick<PriorityRow, 'status' | 'rank' | 'rank_source' | 'mine' | 'owner'>): string | null {
  if (row.mine) return 'You';
  return row.status === 'active' && row.rank != null && row.rank_source === 'person' ? null : row.owner;
}

/** The Next block: the milestone, the button's word, and the session it acts in. */
export function nextWords(action: NextAction<MilestoneModel>): { title: string; verb: string; answer: boolean; session: string | null } {
  return {
    title: action.milestone.step.title,
    verb: VERB[action.kind],
    answer: action.kind === 'answer',
    session: action.session ? `in ${sessionLabel(action.session)}` : null,
  };
}

/**
 * A milestone's box: for the owner, a toggle with what a press writes and
 * says; for anyone else, a status mark with nothing to press.
 */
export function milestoneBox(row: Pick<PriorityRow, 'mine'>, m: Pick<MilestoneModel, 'done' | 'step'>):
  | { kind: 'toggle'; writes: boolean; label: string }
  | { kind: 'mark'; label: 'Done' | 'Open' } {
  if (!row.mine) return { kind: 'mark', label: m.done ? 'Done' : 'Open' };
  return { kind: 'toggle', writes: !m.done, label: m.done ? `Mark ${m.step.title} not done` : `Mark ${m.step.title} done` };
}
