// The inbox's views on the phone, the same names and availability rules as
// web's (store/inboxViewModes): by priority while the workspace has
// Priorities on, by label once a label exists, by plan once a session carries
// one. The slide-out panel's View lists them all; the bar under the title
// shows the everyday ones, plus whichever other view is in use, so the switch
// never hides what the list is showing. A pick writes the shared
// inbox_view_mode pref.
import type { InboxViewMode } from '@codecast/web/store/inboxStore';

export function inboxViewOptions({ hasPriorities, hasLabels, hasPlans }: { hasPriorities: boolean; hasLabels: boolean; hasPlans: boolean }): Array<{ key: InboxViewMode; label: string }> {
  return [
    { key: 'grouped', label: 'By status' },
    ...(hasPriorities ? [{ key: 'priorities' as const, label: 'By priority' }] : []),
    { key: 'recent', label: 'By updated' },
    { key: 'time', label: 'By created' },
    ...(hasLabels ? [{ key: 'bucket' as const, label: 'By label' }] : []),
    ...(hasPlans ? [{ key: 'plan' as const, label: 'By plan' }] : []),
  ];
}

/** The bar's segments: Status, Priorities (while it is on), Recent, then the view in use when it is none of them. */
export function lensSegments(viewMode: InboxViewMode, hasPriorities: boolean): InboxViewMode[] {
  const everyday: InboxViewMode[] = ['grouped', ...(hasPriorities ? ['priorities' as const] : []), 'recent', 'time'];
  return everyday.includes(viewMode) ? everyday : [...everyday, viewMode];
}
