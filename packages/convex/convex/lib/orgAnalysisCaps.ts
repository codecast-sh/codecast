// The analyzer's window and read caps (orgInit), apart so its readers can share
// them without importing the analyzer.
import { capacity } from "@codecast/shared/contracts/orgCapacity";

export const ANALYSIS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const IDLE_ROLE_DAYS = capacity("idle_days");
// The week org.health reads (orgHealth.HEALTH_WINDOW_7D_MS); a literal here
// because orgHealth loads through org.ts, which re-exports this module.
export const WAKE_HISTORY_DAYS = 7;
export const ANALYSIS_CAPS = {
  projects: 100,
  initiatives: 100,
  plans: 200,
  open_plans: 600,
  tasks: 2000,
  docs: 300,
  insights: 300,
  channels: 50,
  messages_per_channel: 50,
  decisions: 300,
  assignments: 2000,
  labels: 30,
  titles_per_path: 5,
  git_roots: 40,
  members: 50,
  long_running: 12,
  tasks_filed_per_session: 300,
  use_messages_per_session: 400,
  first_message_chars: 600,
  /** A long running session's commits in the window, for its work share by project. */
  commits_per_session: 200,
  /** The chars of one session message scanned for a project's name. */
  message_scan_chars: 4000,
  /** What people said: the team's ended calls in the window, and the chat threads with a decision, an ask or a name in them, under one byte budget. */
  calls: 40,
  said_bytes: 40_000,
  said_line_chars: 400,
  said_reply_chars: 240,
  said_replies_per_thread: 3,
  call_summary_chars: 1200,
  call_action_items: 10,
  /** A call that ended with no summary (too short, or the summary failed) still said something: its segments are read, bounded, and the lines that decide or ask are kept. */
  calls_without_summary: 8,
  call_segments: 150,
  call_lines: 8,
  /** The goals people stated (readGoalCandidates, lib/statedGoals): the window's chat lines and call turns read for candidates, alongside answered decisions and plan decisions. A call turn shorter than this states no direction worth a model's read. */
  goal_messages_per_channel: 1200,
  goal_segments_per_call: 1500,
  goal_segments: 12_000,
  goal_turn_min_chars: 40,
  /** Each member's newest answered decisions of the window, so the access reads stay inside a query's read limit. */
  goal_decisions_per_member: 120,
  /** The landing read (readLanding): commits per repository over its own window, newest first; at the cap the search says so. */
  landing_commits_per_repo: 1200,
  /** The templates the workspace may hire (its own and Codecast's), one line each: under 4 KB of the inputs at both caps. */
  templates: 12,
  template_description_chars: 160,
} as const;
/** A flagged record's landing is searched over three months, not the activity
 *  window: on Union a 30 day read found a landing for 4 of 44 stale records
 *  while the ground truth's landings sat 30 to 160 days back (2026-09-23). */
export const LANDING_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** A session this old that still runs may be a role nobody has named (org-roles-run-work.md R2). */
export const LONG_RUNNING_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
