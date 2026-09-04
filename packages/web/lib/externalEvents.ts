// One shape for every event that happened OUTSIDE codecast and belongs inside
// a codecast timeline: a git push, a check result, a review, a GitHub issue
// move, a Linear issue move.
//
// The point of the shape is that a single row component can render all of
// them. A surface (transcript, team feed, task rail, plan timeline, project
// timeline) converts whatever it holds into an ExternalEvent and hands it to
// ExternalEventRow. Nothing else about the surface has to know what a check
// run is.
//
// `refs` names the codecast and code objects the event belongs to. The row
// turns each one into a pill that opens it. A source adds a ref by filling a
// field; it never has to touch the row component.
import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  CircleDot,
  FileDiff,
  GitBranch,
  GitCommit,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MessageSquareCode,
  Pencil,
  RotateCcw,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { repoBlobHref } from "./repoView";

export type ExternalEventSource = "github" | "linear" | "codecast";

/** Accent names map to the app's solarized tokens (see accentVar). */
export type ExternalEventAccent =
  | "green"
  | "red"
  | "yellow"
  | "blue"
  | "violet"
  | "cyan"
  | "magenta"
  | "orange"
  | "muted";

export type ExternalEventRef = {
  session_id?: string;
  task_id?: string;
  task_short_id?: string;
  plan_id?: string;
  project_id?: string;
  pr?: { repository: string; number: number };
  commit?: { repository: string; sha: string };
  issue?: { provider: "github" | "linear"; key: string; url?: string };
  file?: { repository: string; path: string; ref?: string; line?: number };
};

export type ExternalEvent = {
  id: string;
  source: ExternalEventSource;
  kind: string;
  title: string;
  summary?: string;
  url?: string;
  actor?: { login?: string; name?: string; avatar_url?: string; user_id?: string };
  at: number;
  refs: ExternalEventRef;
  meta?: Record<string, string | number | boolean | undefined>;
};

export type ExternalEventStyle = {
  icon: LucideIcon;
  accent: ExternalEventAccent;
  /** Past-tense verb the row shows before the title ("pushed", "merged"). */
  verb: string;
};

const ACCENT_VARS: Record<ExternalEventAccent, string> = {
  green: "var(--sol-green)",
  red: "var(--sol-red)",
  yellow: "var(--sol-yellow)",
  blue: "var(--sol-blue)",
  violet: "var(--sol-violet)",
  cyan: "var(--sol-cyan)",
  magenta: "var(--sol-magenta)",
  orange: "var(--sol-orange)",
  muted: "var(--sol-text-muted)",
};

/** The css color for an accent. Use this instead of writing a hex anywhere. */
export function accentVar(accent: ExternalEventAccent | undefined): string {
  return ACCENT_VARS[accent ?? "muted"];
}

/** A soft fill of the same accent, for chips and rails. */
export function accentSoft(accent: ExternalEventAccent | undefined, percent = 14): string {
  return `color-mix(in srgb, ${accentVar(accent)} ${percent}%, transparent)`;
}

export const DEFAULT_EXTERNAL_EVENT_STYLE: ExternalEventStyle = {
  icon: CircleDot,
  accent: "muted",
  verb: "changed",
};

// Accent choices respect the colors the app already spends elsewhere: cyan is
// forks and plans, violet is tasks, magenta is workflow gates, amber is
// triggers. Git takes blue for the ordinary movement of code and keeps the
// loud colors for the two states a reader must act on, red and green.
export const EXTERNAL_EVENT_STYLE: Record<string, ExternalEventStyle> = {
  commit: { icon: GitCommit, accent: "blue", verb: "committed" },
  push: { icon: GitBranch, accent: "blue", verb: "pushed" },
  pr_opened: { icon: GitPullRequest, accent: "green", verb: "opened" },
  pr_synchronize: { icon: GitCommit, accent: "blue", verb: "updated" },
  pr_review: { icon: UserCheck, accent: "violet", verb: "reviewed" },
  pr_review_comment: { icon: MessageSquareCode, accent: "violet", verb: "commented on" },
  pr_check: { icon: ShieldCheck, accent: "yellow", verb: "checked" },
  pr_merged: { icon: GitMerge, accent: "violet", verb: "merged" },
  pr_closed: { icon: GitPullRequestClosed, accent: "muted", verb: "closed" },
  pr_reopened: { icon: RotateCcw, accent: "green", verb: "reopened" },
  pr_behind: { icon: GitBranch, accent: "orange", verb: "fell behind" },
  pr_conflict: { icon: AlertTriangle, accent: "red", verb: "conflicts on" },
  pr_ready: { icon: GitPullRequest, accent: "green", verb: "is ready" },
  pr_review_requested: { icon: UserCheck, accent: "yellow", verb: "requested review on" },
  pr_ready_for_review: { icon: GitPullRequest, accent: "blue", verb: "marked ready" },
  pr_draft: { icon: GitPullRequestDraft, accent: "muted", verb: "moved to draft" },
  pr_edited: { icon: Pencil, accent: "muted", verb: "edited" },
  code_comment: { icon: MessageSquare, accent: "magenta", verb: "commented on" },
  file: { icon: FileDiff, accent: "blue", verb: "changed" },
};

/**
 * Add or replace styles for kinds this file does not know about. The issue
 * events (GitHub, Linear) register their own kinds this way, so adding a
 * source never means editing the git style table.
 */
export function registerExternalEventStyles(styles: Record<string, ExternalEventStyle>): void {
  Object.assign(EXTERNAL_EVENT_STYLE, styles);
}

export function externalEventStyle(kind: string): ExternalEventStyle {
  return EXTERNAL_EVENT_STYLE[kind] ?? DEFAULT_EXTERNAL_EVENT_STYLE;
}

/** A check conclusion or a review state colors the row on its own. */
export function outcomeAccent(value: string | undefined): ExternalEventAccent | undefined {
  switch (value) {
    case "success":
    case "approved":
      return "green";
    case "failure":
    case "timed_out":
    case "changes_requested":
      return "red";
    case "cancelled":
    case "skipped":
    case "neutral":
    case "stale":
      return "muted";
    case "action_required":
      return "orange";
    case "pending":
    case "queued":
    case "in_progress":
      return "yellow";
    case "commented":
      return "violet";
    default:
      return undefined;
  }
}

/** The accent the row paints, outcome first and kind second. */
export function eventAccent(event: ExternalEvent): ExternalEventAccent {
  const meta = event.meta ?? {};
  const outcome = outcomeAccent(
    typeof meta.conclusion === "string"
      ? meta.conclusion
      : typeof meta.review_state === "string"
        ? meta.review_state.toLowerCase()
        : typeof meta.status === "string"
          ? meta.status
          : undefined,
  );
  return outcome ?? externalEventStyle(event.kind).accent;
}

export function shortSha(sha: string | undefined): string {
  return (sha ?? "").slice(0, 7);
}

function splitRepository(repository: string | undefined): { owner: string; repo: string } | null {
  if (!repository) return null;
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) return null;
  return { owner, repo };
}

export function prPath(ref: { repository: string; number: number } | undefined): string | null {
  const parts = splitRepository(ref?.repository);
  if (!parts || !ref) return null;
  return `/pr/${parts.owner}/${parts.repo}/${ref.number}`;
}

export function commitPath(ref: { repository: string; sha: string } | undefined): string | null {
  const parts = splitRepository(ref?.repository);
  if (!parts || !ref?.sha) return null;
  return `/commit/${parts.owner}/${parts.repo}/${ref.sha}`;
}

export function filePath(ref: ExternalEventRef["file"]): string | null {
  const parts = splitRepository(ref?.repository);
  if (!parts || !ref?.path) return null;
  const line = ref.line ? `#L${ref.line}` : "";
  return repoBlobHref(`${parts.owner}/${parts.repo}`, ref.ref ?? "HEAD", ref.path) + line;
}

/** An external_events row as it arrives from convex. Fields are all optional
 *  here because the row is server data a client of any age may hold. */
export type ExternalEventRecord = {
  _id: string;
  team_id?: string;
  source?: string;
  repository?: string;
  kind?: string;
  actor_login?: string;
  actor_avatar_url?: string;
  actor_user_id?: string;
  title?: string;
  summary?: string;
  url?: string;
  sha?: string;
  branch?: string;
  pr_id?: string;
  pr_number?: number;
  commit_id?: string;
  comment_id?: string;
  issue?: { provider?: string; key?: string; url?: string; title?: string };
  conversation_id?: string;
  task_id?: string;
  task_short_id?: string;
  task_ids?: string[];
  plan_ids?: string[];
  project_ids?: string[];
  meta?: Record<string, string | number | undefined>;
  dedupe_key?: string;
  created_at?: number;
};

export function externalEventRowToExternalEvent(row: ExternalEventRecord): ExternalEvent {
  const meta = row.meta ?? {};
  const repository = row.repository;
  const filePathValue = typeof meta.file_path === "string" ? meta.file_path : undefined;
  const refs: ExternalEventRef = {
    session_id: row.conversation_id,
    task_id: row.task_id ?? row.task_ids?.[0],
    task_short_id: row.task_short_id,
    plan_id: row.plan_ids?.[0],
    project_id: row.project_ids?.[0],
  };
  if (repository && row.pr_number !== undefined) refs.pr = { repository, number: row.pr_number };
  if (repository && row.sha) refs.commit = { repository, sha: row.sha };
  if (repository && filePathValue) {
    refs.file = {
      repository,
      path: filePathValue,
      ref: row.sha ?? row.branch,
      line: typeof meta.line_number === "number" ? meta.line_number : undefined,
    };
  }
  // An issue event names an issue instead of a repository. The row carries it
  // whole, so the pill can open the tracker without the surface knowing which
  // tracker it is.
  if (row.issue?.key) {
    refs.issue = {
      provider: row.issue.provider === "linear" ? "linear" : "github",
      key: row.issue.key,
      url: row.issue.url,
    };
  }
  return {
    id: row._id,
    source: row.source === "linear" ? "linear" : row.source === "codecast" ? "codecast" : "github",
    kind: row.kind ?? "commit",
    title: row.title ?? "",
    summary: row.summary,
    url: row.url,
    actor: row.actor_login || row.actor_avatar_url || row.actor_user_id
      ? { login: row.actor_login, avatar_url: row.actor_avatar_url, user_id: row.actor_user_id }
      : undefined,
    at: row.created_at ?? 0,
    refs,
    meta: { ...meta, repository, branch: row.branch, issue_title: row.issue?.title },
  };
}

/** The shepherd states a pull request moves through, and how they read. */
export const SHEPHERD_STATE_STYLE: Record<string, { label: string; accent: ExternalEventAccent }> = {
  review_pending: { label: "review", accent: "yellow" },
  changes_requested: { label: "changes", accent: "orange" },
  ci_pending: { label: "ci", accent: "yellow" },
  ci_red: { label: "ci red", accent: "red" },
  behind: { label: "behind", accent: "orange" },
  conflicts: { label: "conflicts", accent: "red" },
  approved: { label: "approved", accent: "green" },
  ready: { label: "ready", accent: "green" },
  merged: { label: "merged", accent: "violet" },
  closed: { label: "closed", accent: "muted" },
};

export function shepherdStyle(state: string | undefined): { label: string; accent: ExternalEventAccent } {
  return SHEPHERD_STATE_STYLE[state ?? ""] ?? { label: state ?? "open", accent: "muted" };
}
