// The shapes of the per-user client preferences the store keeps in
// clientState: view prefs, saved views, layouts, dismissals and tips. The ui
// bag (ClientUI) stays in inboxStore.ts, beside the LWW key registry and the
// chokepoint that read its synced view keys. Types only; inboxStore re-exports
// these, so importers name the store.
import type { WorkbenchSnapshot } from "./workbench";

export type TaskViewPrefs = {
  status?: string;
  statuses?: string;
  completed?: string;
  view?: "list" | "kanban";
  group?: string;
  sort?: string;
  dir?: string;
  priority?: string;
  label?: string;
  assignee?: string;
  session?: string;
  project?: string;
  hide_agent?: boolean;
  source?: string;
  /** Kanban column order (status ids), set by dragging column headers. */
  kanban_order?: string[];
};

export type DocViewPrefs = {
  doc_type?: string;
  group?: string;
  sort?: string;
  dir?: string;
  project?: string;
  label?: string;
  source?: string;
  scope?: string;
};

export type PlanViewPrefs = {
  source?: string;
};

export type SavedView = {
  id: string;
  name: string;
  page: "tasks" | "docs" | "plans";
  prefs: TaskViewPrefs | DocViewPrefs | PlanViewPrefs;
  team_id?: string;
  created_at: number;
};

/**
 * A saved view as it now lives on the server (convex/savedViews.ts). The legacy
 * SavedView above is the client_state shape these were kept in before they could
 * be shared; useSyncSavedViews migrates those across once and then they are gone.
 */
export type SavedViewRow = {
  _id: string;
  client_key?: string;
  user_id?: string;
  team_id?: string;
  name: string;
  // "workspace" = a layout workbench: the saved arrangement of the chrome
  // itself (store/workbench.ts), riding the same rows as the list views.
  page: "tasks" | "docs" | "plans" | "workspace";
  prefs: TaskViewPrefs | DocViewPrefs | PlanViewPrefs | WorkbenchSnapshot;
  /** Visible to the whole team's rail, not just its author's. */
  shared?: boolean;
  icon?: string;
  color?: string;
  /** Enrichment from webList — who authored a view you did not. */
  owner_name?: string;
  owner_image?: string;
  is_mine?: boolean;
  created_at: number;
  updated_at: number;
};

// The inbox panel's session-ordering modes. "grouped" = status sections;
// "recent" = flat, newest-first by last activity (updated_at) — reshuffles as
// sessions work; "time" = flat, newest-first by creation (started_at) — a
// stable chronology that doesn't move; "bucket" = sections per manual label;
// "plan" = sections per plan; "trigger" = trigger-first — every armed trigger
// (and loop/subagent) is a group header with the sessions it drives beneath.
export type InboxViewMode = "grouped" | "recent" | "time" | "bucket" | "plan" | "trigger";

export type ClientLayouts = {
  dashboard?: { sidebar: number; main: number };
  inbox?: { main: number; sidebar: number };
  conversation_diff?: { content: number; diff: number };
  file_diff?: { tree: number; content: number };
};

export type ClientDismissed = {
  // The native app nudges (NativeAppBanner): one permanent opt-out per app.
  desktop_app?: boolean;
  ios_app?: boolean;
  has_used_desktop?: boolean;
  // User chose "stay in browser" from the open-in-desktop hand-off; suppresses
  // the auto-redirect from then on (synced per-user across browsers).
  prefer_browser_links?: boolean;
  setup_prompt?: number;
  // "Your coworkers' team is on codecast" (TeamDomainBanner): a week's snooze.
  team_domain?: number;
  cli_offline?: number;
  tmux_missing?: number;
  team_sharing_prompt?: number;
  // Onboarding strip after the first sync: "decide what syncs and what your
  // team sees" (SharingSetupBanner). Stamped when taken or dismissed.
  sharing_setup?: number;
  // Blocked-sessions banner X (timestamp snooze, cross-device).
  blocked_sessions_banner?: number;
  // "Turn on desktop notifications" nudge X (timestamp snooze; a missed
  // message overrides it — lib/notificationNudge.ts).
  notif_nudge?: number;
  // "Set up account switching" promo inside that banner — permanent opt-out.
  cc_accounts_promo?: boolean;
  // "New agent features" upsell — one stamp per snippet slug the user enabled
  // or dismissed from the intro (timestamp; cross-device via per-key LWW).
  [k: `snippet_intro_${string}`]: number | undefined;
};

export type ClientTips = {
  seen?: string[];
  dismissed?: string[];
  completed?: string[];
  level?: 'all' | 'subtle' | 'none';
  _inlineSuppressed?: boolean;
};
