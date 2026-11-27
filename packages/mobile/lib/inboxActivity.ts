// The phone inbox's split of the Dormant bucket (plan pl-1138), the same one
// web's rail draws: the shared sessionActivity, read over the store by web's
// lib/railActivity, files a row whose own work runs under Working, one whose
// change is between CI and live under Shipping, and leaves only waits in
// Sleeping. Each row's under-line says the same words as web's ActivityLine.
// No React Native here, so lib/inboxActivity.test.ts reads it directly.
import type { InboxSession } from '@codecast/web/store/inboxStore';
import { rowActivity, type RailActivityState } from '@codecast/web/lib/railActivity';
import type { SessionActivity, ShipStage } from '@codecast/shared/contracts/sessionActivity';
import { dormantWakeLabel } from '@codecast/web/components/inbox/dormantWake';
import { fmtDuration, taskStateLabel } from '@codecast/web/components/triggerCadence';
import type { TriggerRow } from '@codecast/web/components/triggerTasks';

export type RowActivity = SessionActivity<TriggerRow>;

export type DormantSplit = {
  activity: Map<string, RowActivity>;
  working: InboxSession[];
  shipping: InboxSession[];
  sleeping: InboxSession[];
};

/** The Dormant rows split by what each is really doing. */
export function splitDormant(state: RailActivityState, rows: readonly InboxSession[], now: number): DormantSplit {
  const split: DormantSplit = { activity: new Map(), working: [], shipping: [], sleeping: [] };
  for (const row of rows) {
    const a = rowActivity(state, row, now) as RowActivity;
    split.activity.set(row._id, a);
    split[a.state === 'sleeping' ? 'sleeping' : a.state].push(row);
  }
  return split;
}

/** What a row's under-line says. `waiting` is a reference drawn as a pill
 *  between "waiting on" and its tail; `bar` the shipping track. */
export type ActivityLineParts = {
  /** The arrow's accessible name: what the line answers. */
  label: string;
  /** The stalled line, a wake gone quiet, or a ship step held for the viewer: the warning colour. */
  warn: boolean;
  /** The alert glyph before the words (the stalled line). */
  alert: boolean;
  words: string | null;
  /** A session's ref is its conversation id and a pull request's
   *  "owner/repo#42" (contracts/waitingOn); `label` is the text to show. */
  waiting: { kind: 'person' | 'session' | 'task' | 'pr'; ref: string; label: string; tail: string | null } | null;
  bar: { stage: ShipStage; failed: boolean } | null;
  right: string | null;
};

/** The under-line's words, as web's ActivityLine says them. */
export function activityLineParts(activity: RowActivity, now: number): ActivityLineParts {
  const parts = (p: Partial<ActivityLineParts> & Pick<ActivityLineParts, 'label'>): ActivityLineParts =>
    ({ warn: false, alert: false, words: null, waiting: null, bar: null, right: null, ...p });
  if (activity.state === 'working') return parts({ label: 'What is running', words: activity.words });
  if (activity.state === 'shipping') {
    // A step held for the viewer ("Your call") asks them to act: the attention colour.
    const mine = activity.holder === 'you';
    return parts({ label: mine ? 'What the change waits on you for' : 'Where the change is', warn: mine, words: activity.words, bar: { stage: activity.stage, failed: activity.failed } });
  }
  if (activity.flavor === 'waiting' && activity.on) {
    const { kind, ref, label } = activity.on;
    return parts({
      label: 'What wakes this session',
      waiting: { kind, ref, label: label ?? (kind === 'pr' ? `#${ref.split('#').pop()}` : ref), tail: kind === 'task' ? 'landing' : kind === 'pr' ? 'to merge' : null },
      right: activity.since != null ? `since ${fmtDuration(Math.max(0, now - activity.since))}` : null,
    });
  }
  if (activity.flavor === 'stalled') {
    const back = activity.wake.back;
    return parts({
      label: 'Nothing wakes this session',
      warn: true,
      alert: true,
      words: 'nothing scheduled',
      right: back > now ? `back to you in ${fmtDuration(back - now)}` : 'back to you now',
    });
  }
  // A trigger's countdown, a task wait the row cannot name, a park gone
  // quiet, the person's own filing: the dormant wake's own words.
  const { what, when, warn } = dormantWakeLabel(activity.wake!, now);
  return parts({
    label: 'What wakes this session',
    warn: !!warn,
    words: what,
    right: typeof when === 'string' ? when : taskStateLabel(when.task, now),
  });
}
