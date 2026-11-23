import { closeFactsOf, closeTooltip, type CloseRow } from '@codecast/web/lib/sessionClose';
import { armedInjectTasksFor, type TaskRow } from '@codecast/web/components/triggerTasks';
import { killReviewOf } from '@codecast/web/components/consequential/killReview';

// The words of a row's Close and Kill on the phone, from the same decision and
// review the web card uses. No React Native in here, so bun tests it directly.

type Row = CloseRow & { _id: string; title?: string | null; is_idle?: boolean; has_pending?: boolean };

/** What Close does to this row now: the web tooltip without its "Close: ",
 *  for the line under the menu's Close. */
export function closeDetail(row: Row, tasks: TaskRow[], now: number, pendingSend = false): string {
  const words = closeTooltip(closeFactsOf(row, armedInjectTasksFor(tasks, row._id).length, now, pendingSend)).replace(/^Close: /, '');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export type KillReview = { title: string; message: string; keep: string; confirm: string };

/** The confirm a Kill of this row asks first, or null when it cancels nothing
 *  (no turn in progress, no armed trigger, no queued message). */
export function killReview(row: Row, tasks: TaskRow[]): KillReview | null {
  const l = killReviewOf([row as any], tasks);
  if (!l) return null;
  const lines = l.rows.map((r) => `${r.k}: ${r.v}${r.list?.length ? ` (${r.list.join(', ')})` : ''}`);
  return { title: `${l.name}: ${l.subject}`, message: lines.join('\n'), keep: l.keep ?? 'Keep it', confirm: l.confirm };
}
