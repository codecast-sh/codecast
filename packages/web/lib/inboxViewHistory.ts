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

export function sameInboxView(a: InboxViewSnapshot, b: InboxViewSnapshot): boolean {
  return a.bucket === b.bucket && a.project === b.project && a.mode === b.mode;
}

// Push a traversable entry for a view-settings change. The CURRENT entry is
// first stamped with the pre-change snapshot (so landing back on it restores
// what the user saw there), then the new entry is pushed with the post-change
// snapshot. Both spreads preserve the other tags (inboxId, tabNav) so session
// and tab reconciliation keep working across these entries. URL is unchanged —
// the view settings are panel state, not a route.
export function pushInboxViewHistory(prev: InboxViewSnapshot, next: InboxViewSnapshot) {
  if (applying || typeof window === "undefined") return;
  if (sameInboxView(prev, next)) return;
  const url = window.location.pathname + window.location.search + window.location.hash;
  window.history.replaceState({ ...(window.history.state ?? {}), inboxView: prev }, "");
  window.history.pushState({ ...(window.history.state ?? {}), inboxView: next }, "", url);
}
