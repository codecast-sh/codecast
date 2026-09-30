// The shapes of the per-user client preferences the store keeps in
// clientState: view prefs, saved views, the ui bag, layouts, dismissals and
// tips. Types only; inboxStore re-exports them, so importers name the store.
import type { PersistedWorkspace } from "./workspace";
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


export type ClientUI = {
  theme?: "light" | "dark";
  visual_style?: "classic" | "minimal";
  sidebar_collapsed?: boolean;
  // The sidebar sections the chevrons pin open (true) or closed (false), by
  // section key. A section the user never touched is absent and follows the
  // route ("you are on /tasks, so Tasks is open"); a pin is the user saying
  // otherwise, so it outlives the route — and the reload. Unstamped: the
  // sidebar's shape is a per-device layout preference like the rest.
  nav_sections?: Record<string, boolean>;
  zen_mode?: boolean;
  sticky_headers_disabled?: boolean;
  diff_panel_open?: boolean;
  file_diff_view_mode?: "unified" | "split";
  // Files the reader has marked viewed on a pull request, by pull request id.
  // A reading mark, so it follows the person to every device.
  pr_viewed_files?: Record<string, string[]>;
  // Where a new line note goes on a pull request: held for the review, or out
  // at once. A reading habit, so it follows the person.
  pr_note_mode?: "review" | "now";
  pr_merge_method?: "squash" | "merge" | "rebase";
  pr_delete_branch?: boolean;
  // When the person last had a pull request open, by pull request id: what
  // the timeline draws its "since you last looked" line from.
  pr_last_seen?: Record<string, number>;
  active_team_id?: string;
  active_filter?: "my" | "team";
  inbox_shortcuts_hidden?: boolean;
  // The inbox triage bar (components/triage/TriageBar) hidden to a corner
  // button that takes no layout height. A per-user preference, stamped LWW
  // (STAMPED_UI_KEYS) like the other view prefs.
  triage_bar_compact?: boolean;
  // The master sound switch: off silences every cue the app can make.
  sounds_enabled?: boolean;
  // Chat toast sounds, split from the above: an agent fleet's chirps and a
  // teammate speaking are different interruptions, and people who mute one
  // usually still want the other. Absent = on, same as sounds_enabled.
  chat_sounds_enabled?: boolean;
  // Per-category gates under the master switch (lib/sounds.ts maps each cue to
  // one of these). Absent = on. Stamped LWW like sounds_enabled
  // (STAMPED_UI_KEYS): a mute is a per-user preference, so the newest toggle
  // on any device wins on every device — including a localhost dev origin,
  // which is otherwise just another device with its own local bag.
  session_sounds_enabled?: boolean; // a session arriving, finishing, going idle
  call_sounds_enabled?: boolean;    // ring, join/leave, declined, a knock at the door
  walkie_sounds_enabled?: boolean;  // the six push-to-talk cues
  ui_sounds_enabled?: boolean;      // feedback for your own gestures: send, dismiss, kill
  // Output level, a 0..1.5 multiplier over each cue's calibrated gain. 1 (and
  // absent) = the exact levels every cue was measured at in lib/cueSpec.ts;
  // the headroom above 1 is safe because master gains sit near 0.05.
  sound_volume?: number;
  // Chat toasts stay quiet until this instant. Set from the snooze button on a
  // toast — the off switch has to be one gesture from the annoyance, or people
  // mute everything after one bad afternoon.
  chat_snooze_until?: number;
  task_view?: TaskViewPrefs;
  doc_view?: DocViewPrefs;
  plan_view?: PlanViewPrefs;
  saved_views?: SavedView[];
  show_subagents?: boolean;
  // Trigger rows under inbox cards: expanded (full row per trigger — name,
  // last report, countdown, verbs) or folded to a one-line strip that only says
  // the card has triggers and when the next one fires. Absent = folded: the
  // strip is the resting state; the pill toggle opens the detail.
  // LEGACY — superseded by card_bars; still read as the default when card_bars
  // is unset so an existing "expanded" choice survives the upgrade.
  show_triggers?: boolean;
  // The bars under inbox cards — triggers, workflow runs, monitors and
  // background commands — as one family with one control: "strip" folds each
  // card's bars to a one-line summary (the resting state), "full" shows every
  // bar as its own row, "hidden" removes them entirely (the same gesture the
  // subagent toggle offers). Absent = show_triggers legacy, then "strip".
  card_bars?: "strip" | "full" | "hidden";
  // The machine you last chose by hand in the new-session picker — the default
  // the picker opens on for NEW work (defaultMachineId rung 2). Deliberately
  // UNSTAMPED, i.e. per-device: "where should this run" is answered differently
  // from a phone than from the laptop that holds the checkouts.
  last_picked_device_id?: string;
  // The composer's "start from" pick for cloud sessions: the preparing
  // laptop's checkout (absent = checkout) or origin/main. Per-device like
  // last_picked_device_id: it is a statement about this machine's checkouts.
  cloud_start_from?: "checkout" | "origin_main";
  // User-set height (px) of the trigger full-prompt viewport (TriggerPromptView
  // drag handle). Layout pref → unstamped, per-device local_wins.
  trigger_prompt_height?: number;
  // "Show old sessions" — reveal cached rows the live (authoritative) inbox
  // subscription no longer returns. Default hide. Successor to the removed
  // show_old_sessions key, whose blanket-local_wins sync made one browse click
  // a permanent all-clients cruft mode (the OFF could never propagate, and a
  // stale server `true` was unkillable). This key is stamped LWW (see
  // STAMPED_UI_KEYS): the newest toggle on ANY device wins everywhere —
  // including off — so sticky can't decay into stuck. The legacy key still
  // lingers in server docs; nothing may ever read it (resolveShowOld).
  inbox_show_old?: boolean;
  // When the user last said "Not now" to the "clear out your working set"
  // prompt. Stamped LWW: a snooze on one device silences the prompt on every
  // device for its window (STALE_PROMPT_SNOOZE_MS in GlobalSessionPanel).
  inbox_stale_prompt_snoozed_at?: number;
  // Inbox scope. "mine" (default) is the personal inbox: your own sessions plus
  // any explicitly routed to you. "team" turns the inbox into a shared board of
  // every team-visible session across the active team (a superset of "mine").
  // Stamped LWW so the chosen scope survives reloads and follows the user.
  inbox_scope?: "mine" | "team";
  // Show each session's model as a badge in the inbox list. Off by default.
  show_model_badge?: boolean;
  // Show a session's checkout position (its branch, or the short sha of a
  // detached head) as a pill on inbox cards when it sits off the default
  // branch. On by default; read as `!== false`.
  show_branch_pill?: boolean;
  // Show each session's agent client icon (Claude Code, opencode, …) next to
  // its title in the inbox list. On by default; read as `!== false`.
  show_agent_icon?: boolean;
  // Give EVERY session a character — an animal face and a name — instead of
  // only the ones somebody personified by hand (session-characters.md S2).
  // Off by default: a face is a choice, not something that happens to you.
  personify_sessions?: boolean;
  // Opt in to the teammate-comment tools (the gutter "comment" handle + the
  // header toggle when a conversation has none yet). Off by default — you still
  // SEE and can reply to comments others leave regardless of this.
  comments_enabled?: boolean;
  // Suggested replies above the composer ("suggestion pills"), predicted by a
  // small model from the session tail plus the user's own frequent past
  // inputs. Off by default; stamped LWW — a behavior pref that follows the
  // user, not the device.
  composer_suggestions?: boolean;
  // The composer's mic has been explained once, so it never explains itself
  // again. A hold is not a click, and a small round key cannot say so on its own
  // — the first DM composer that offers push to talk floats a small callout
  // over it, and this retires that callout for good. Stamped LWW: learning the
  // gesture on the laptop means the phone's browser has learned it too.
  walkie_hold_seen?: boolean;
  // The org page's first open guide (org-staffing.md S14) has been dismissed
  // once, so the page never opens on it again; "How this page works" in the
  // toolbar reopens it by hand. Stamped LWW: a person who has read the guide
  // on one device has read it everywhere.
  org_nux_seen?: boolean;
  // The staffing pane's cold read intro (org-staffing.md S17): the two
  // sentences over a proposal that say what codecast is proposing and what
  // accepting costs. Dismissed once, or stamped by the first accepted change,
  // and never shown again. Stamped LWW: read on one device is read everywhere.
  org_intro_seen?: boolean;
  // The introduction anywhere (org-staffing.md S20): the card that rises
  // bottom right on the next visit to any page and introduces the org
  // feature. Dismissed either way, or stamped by seeing the org page by any
  // route, and never shown again. Stamped LWW: sold once, on one device, is
  // sold once everywhere.
  org_upsell_seen?: boolean;
  // The review "Propose an org now" started on the org page: when, in which
  // workspace, and the session doing it (its stub id first, the real id once
  // the server names it). Kept here, not in component state, so a reload or
  // a visit elsewhere does not forget a running review and offer to start a
  // second one. Stamped LWW: the phone sees the laptop's review too. The
  // page derives reviewing, ended or nothing from it (staffingModel.reviewRunState).
  org_review_run?: { since: number; session_id: string | null; workspace: string } | null;
  // Which view the people window shows: the wall of faces (default) or the
  // roster list. Unstamped, so it stays a per-device reading preference like
  // the sidebar and zen mode — the window is a different size on every machine,
  // and which view fits is a fact about the window, not about the person.
  people_view?: "wall" | "list";
  // The floating faces' circle size (lib/faces/layout FLOAT_FACE_SIZES).
  // Unstamped: the size that suits a laptop is a stamp on an ultrawide.
  float_face_size?: number;
  // Which microphone and camera a deliberate join opens (lib/calls/joinPrefs).
  // Unstamped on purpose: a device id names hardware attached to THIS machine,
  // so the newest choice must not travel — the laptop's headset id is noise on
  // the desktop, and switchActiveDevice would simply fail on it.
  call_mic_device_id?: string;
  call_camera_device_id?: string;
  call_speaker_device_id?: string;
  // Whether a deliberate join turns the camera on, and whether it opens the
  // microphone. Stamped LWW, because these ARE about the person: somebody who
  // joins with video joins with video wherever they are signed in. Absent
  // means ON for both — see lib/calls/joinPrefs — so only an explicit false
  // is a choice.
  call_camera_on?: boolean;
  call_mic_on?: boolean;
  // Whether the microphone may open before the person presses anything: the
  // walkie warms it under a hovered talk button and a prewarmed room publishes
  // it muted (lib/calls/walkieMic). Absent means ON; an explicit false makes a
  // press, an unmute or a record the only things that open it. Stamped LWW:
  // "may the app hold my microphone" is about the person, not the machine.
  call_mic_auto_open?: boolean;
  // Fold the pinned thread-state panel above the composer down to its headline
  // row. Expanded by default — the panel exists to be read on arrival — and
  // left unstamped, so it stays a per-device reading preference like the other
  // layout toggles.
  thread_state_collapsed?: boolean;
  // Inbox session panel view mode. When true, the panel drops the
  // Pinned/New/Needs-Input/Working grouping and shows every session as one flat
  // list sorted newest-first by creation time (started_at). Toggled by Ctrl+,.
  inbox_flat_view?: boolean;
  // Successor to inbox_flat_view: see InboxViewMode. The legacy boolean is kept
  // coherent (true for either flat mode) so older readers still flatten. Ctrl+, cycles.
  inbox_view_mode?: InboxViewMode;
  // Per-user manual order for the "time" view: a SPARSE map of conversation id →
  // sort key, where the key lives in the SAME epoch-ms space as started_at. Rows
  // absent from the map fall back to their creation time, so un-dragged rows and
  // brand-new sessions interleave by creation automatically; a drag pins just the
  // moved row with a single midpoint write. See flatViewComparator / computeManualSortKey.
  inbox_manual_order?: Record<string, number>;
  // Read watermark for the TRIGGERS section: outcomes with last_run_at newer
  // than this count as "N new" on the collapsed header. Refreshed whenever the
  // user toggles the section (expanding IS reading the briefing).
  schedules_seen_at?: number;
  // Sidebar subsection rows pinned to the top of the rail (lib/sidebarPins).
  // Structural shape rather than the SidebarPin import: sidebarPins.ts imports
  // this store, and a type import back the other way invites a require cycle.
  // Stamped (STAMPED_UI_KEYS): a per-user shortcut list, so a pin made on one
  // device stays pinned on the others. Unstamped, local_wins let an empty
  // array on a second client clobber the pin (ct-51761).
  sidebar_pins?: Array<{ kind: "project" | "view" | "channel"; id: string; label: string }>;
  // The Threads page's "include agent sessions" toggle. Off unless exactly
  // true. Stamped (STAMPED_UI_KEYS): a per-user view preference.
  threads_include_sessions?: boolean;
  // The workspace arrangement (see store/workspace.ts): which slots are open,
  // peek vs split, and their sizes. Subject-bearing panes are deliberately NOT
  // persisted — the arrangement is worth remembering, its contents are
  // re-derived from where you are now.
  workspace?: PersistedWorkspace;
  // Simple view: calm, low-chrome rendering of conversations and inbox cards —
  // secondary badges, counts and meta rows drop away. On by default; a
  // per-user preference ("my reading style follows me") → stamped LWW.
  simple_view?: boolean;
  // The color of your own messages in the Minimal style: a preset id or a
  // #rrggbb hex (lib/bubbleColor.ts). Follows the person, so it is stamped.
  user_bubble_color?: string;
  // Minimal hides the schedule, plan and workflow strips under a conversation's
  // header; true brings them back. Classic always shows them.
  show_session_context?: boolean;
  // One line per session in the inbox list, in every style. Unset means the
  // style decides (resolveInboxCompact).
  inbox_compact?: boolean;
  // Open an agent's pane offer (`cast browser pane <url>`) without a click,
  // while the offered session is the one being read and the stage has room.
  // Off by default — an agent may ask for a pane, never take one. Per-user
  // ("my reading style follows me") → stamped LWW.
  auto_open_browser_panes?: boolean;
  // Show a small thumbnail on inbox session rows when the session contains
  // images (session.image_preview_url). Independent of simple_view — applies
  // in both. Off by default; per-user preference → stamped LWW.
  inbox_image_thumbs?: boolean;
  // What the inbox opens on when no conversation is selected: the fleet board
  // (a live band-grouped tile grid of every session) or the chronological
  // activity feed. Board is the default. Per-user → stamped LWW.
  inbox_home?: "board" | "feed";
};

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
