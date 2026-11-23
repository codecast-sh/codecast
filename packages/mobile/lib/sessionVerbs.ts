import { closeTooltip, type CloseRow } from '@codecast/web/lib/sessionClose';
import { closeFactsInStore, type CloseStore } from '@codecast/web/lib/closeFactsInStore';
import type { TaskRow } from '@codecast/web/components/triggerTasks';
import { killReviewOf } from '@codecast/web/components/consequential/killReview';

// The words of a row's Close and Kill on the phone, from the same decision and
// review the web card uses. No React Native in here, so bun tests it directly.

type Row = CloseRow & { _id: string; title?: string | null; is_idle?: boolean; has_pending?: boolean };

/** What Close does to this row now: the web tooltip without its "Close: ",
 *  for the line under the menu's Close. Reads the store exactly as the web
 *  tooltip does (closeFactsInStore): triggers, an unlanded send, the nested group. */
export function closeDetail(row: Row, store: CloseStore, now: number): string {
  const words = closeTooltip(closeFactsInStore(store, row, now)).replace(/^Close: /, '');
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

/** A Kill from any phone surface (the menu, a Stashed row's button): it ends
 *  at once when it cancels nothing, else asks first with the web's review.
 *  `hold` is the kill itself (the undo bar's holdKill); `ask` shows the alert
 *  and runs `confirm` on its destructive button. */
export function reviewedKill(
  row: Row,
  tasks: TaskRow[],
  io: { hold: (id: string) => void; ask: (review: KillReview, confirm: () => void) => void },
): void {
  const review = killReview(row, tasks);
  if (!review) { io.hold(row._id); return; }
  io.ask(review, () => io.hold(row._id));
}
