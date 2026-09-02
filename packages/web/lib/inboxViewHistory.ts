// Browser-history integration for the inbox session panel's view settings —
// the label/project filter chips and the view mode (by status / time / label).
// These live in the store, not the URL, so without this a chip click is
// invisible to back/forward. Each user-initiated change pushes a history entry
// tagged `{ inboxView }` (alongside the existing `{ inboxId }` / `{ tabNav }`
// tags); DashboardLayout's popstate handler re-applies snapshots on traversal.
//
// This module is deliberately store-free (pure history manipulation) so the
// store can import it without a cycle. The store's setters call
// `pushInboxViewHistory` after mutating; the popstate handler wraps its
// re-apply in `withApplyingViewHistory` so those same setters don't push
// again (and don't record a recents visit) while history is driving them.

export type InboxViewSnapshot = {
  bucket: string | null;
  project: string | null;
  projectPath: string | null;
  // Whether the active chip was in exclude mode ("everything but this").
  // Optional: entries pushed before this field existed restore as include.
  exclude?: boolean;
  // Shift-added label terms beyond the head chip (store extraBucketFilters),
  // each with its own polarity. Optional: older entries restore as none.
  extras?: Array<{ id: string; exclude: boolean }>;
  mode: "grouped" | "recent" | "time" | "bucket";
};

let applying = false;

export function isApplyingViewHistory(): boolean {
  return applying;
}

export function withApplyingViewHistory(fn: () => void) {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

// Elementwise: the extras list is ordered (click order), so order counts.
export function sameBucketExtras(
  a?: Array<{ id: string; exclude: boolean }>,
  b?: Array<{ id: string; exclude: boolean }>,
): boolean {
  const la = a ?? [], lb = b ?? [];
  return la.length === lb.length && la.every((t, i) => t.id === lb[i].id && !!t.exclude === !!lb[i].exclude);
}

export function sameInboxView(a: InboxViewSnapshot, b: InboxViewSnapshot): boolean {
  return a.bucket === b.bucket && a.project === b.project && !!a.exclude === !!b.exclude &&
    sameBucketExtras(a.extras, b.extras) && a.mode === b.mode;
}

// Push a traversable entry for a view-settings change. The CURRENT entry is
// first stamped with the pre-change snapshot (so landing back on it restores
// what the user saw there), then the new entry is pushed with the post-change
// snapshot. Both spreads preserve the other tags (inboxId, tabNav) so session
// and tab reconciliation keep working across these entries. URL is unchanged —
// the view settings are panel state, not a route.
// A session navigation writes its own `{ inboxId }` state. Carry the current
// entry's view tag onto it: the view did not change, so landing back on (or
// forward to) that entry must restore the same chips. Without this, a focus
// move caused by a chip change erases the tag from the entry it just pushed,
// and Forward then shows the old view under the new URL.
export function withInboxView<T extends object>(state: T): T & { inboxView?: InboxViewSnapshot } {
  const view = typeof window !== "undefined" ? (window.history?.state as { inboxView?: InboxViewSnapshot } | null)?.inboxView : undefined;
  return view ? { ...state, inboxView: view } : state;
}

export function pushInboxViewHistory(prev: InboxViewSnapshot, next: InboxViewSnapshot) {
  // React Native has a `window` global but no History API — this is browser
  // back/forward integration only, so it's a no-op anywhere else (the mobile
  // inbox calls the same store actions, e.g. setActiveProjectFilter).
  if (applying || typeof window === "undefined" || typeof window.history?.pushState !== "function") return;
  if (sameInboxView(prev, next)) return;
  const url = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState({ ...(window.history.state ?? {}), inboxView: prev }, "");
  window.history.pushState({ ...(window.history.state ?? {}), inboxView: next }, "", url);
}
