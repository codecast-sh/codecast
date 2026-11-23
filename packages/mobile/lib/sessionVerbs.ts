import { closeFactsOf, closeTooltip, type CloseRow } from '@codecast/web/lib/sessionClose';
import { armedInjectTasksFor, taskDisplayTitle, type TaskRow } from '@codecast/web/components/triggerTasks';
import { killSessionsLedger } from '@codecast/web/components/consequential/ledgers';

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
  const title = row.title || 'Untitled session';
  const working = row.is_idle === false ? [title] : [];
  const triggers = armedInjectTasksFor(tasks, row._id).map(taskDisplayTitle);
  const queued = row.has_pending ? 1 : 0;
  if (!working.length && !triggers.length && !queued) return null;
  const l = killSessionsLedger({ total: 1, working, triggers, queued, subject: title });
  const lines = l.rows.map((r) => `${r.k}: ${r.v}${r.list?.length ? ` (${r.list.join(', ')})` : ''}`);
  return { title: `${l.name}: ${l.subject}`, message: lines.join('\n'), keep: l.keep ?? 'Keep it', confirm: l.confirm };
}
