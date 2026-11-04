// Starting a fix from the Issues surface goes through the one consequential
// review (components/consequential): it starts an agent session. This is the
// review's data, built from what the page holds, so it is tested without a
// browser. One issue or a bulk selection read the same.
import type { SwitchLedger } from "../consequential/ConsequentialSwitch";
import { MERGES_NEVER, costFigure, listRow, type RunCost } from "../consequential/lineStartLedger";
import type { FixFacts } from "./opsModel";
import type { OpsGroup } from "./opsTypes";

export type IssueFixReview = {
  /** The issues it fixes, by short id, and the first one's title. */
  refs: string[];
  title: string;
  /** The folder the session starts in, as the person knows it. */
  project: string | null;
  /** The folders it may start in (the review's pick); the first is the source's own when `fromSource`. */
  folders?: string[];
  fromSource?: boolean;
  /** The problem task it binds to, when the issue was filed as one. */
  task: string | null;
  /** Every problem task the selection holds, when they differ: the session binds to one, and the press moves it to the next. */
  tasks?: string[];
  /** Each selected issue with its problem task, the task's state and whether it was filed for another title: one line per issue. */
  issues?: { ref: string; task: string | null; state?: string; mismatch?: boolean }[];
  /** The bound task was filed for another title than its issue's. */
  taskMismatch?: boolean;
  nextTask?: { label: string; press: () => void };
  /** Issues in the selection with no problem task. */
  unfiled?: number;
  /** Fix sessions already running on any of them: the review says so loudest. */
  running: number;
  prompt: string;
  /** What the prompt carries, named for the issue's kind (seededWith). */
  seeded?: string;
  showPrompt: boolean;
  togglePrompt: () => void;
  cost?: RunCost | null;
  /** How many sessions start: one per issue when the selection's issues are unrelated, else one. */
  sessions?: number;
  /** A selection's choice between one session per issue and one for all. */
  splitToggle?: { label: string; press: () => void };
  /** One session per issue from different sources: each starts in its own source's folder, listed in place of the pick. */
  perFolder?: { ref: string; folder: string | null }[];
  /** Closed problem tasks the start sets back to open. */
  reopens?: string[];
};

export function issueFixLedger(r: IssueFixReview): SwitchLedger {
  const many = r.refs.length > 1;
  const sessions = r.sessions ?? 1;
  const each = sessions > 1;
  const pickFolder = !r.perFolder && (r.folders?.length ?? 0) > 1 && !!r.project;
  const lines = r.prompt.split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    name: "Start a fix session",
    subject: many ? `${r.refs.length} issues · ${r.refs.slice(0, 3).join(", ")}${r.refs.length > 3 ? "…" : ""}` : `${r.refs[0]} · ${r.title}`,
    shift: null,
    ...(r.running ? { alert: r.running === 1 && !many ? "A fix is already running on it" : `${r.running} already have a fix running` } : {}),
    // A run nobody has priced shows no cost at all, never a broken figure.
    figures: [{ value: String(sessions), label: each ? "sessions start now" : "session starts now" }, ...(r.cost ? [costFigure(r.cost, sessions)] : [])],
    rows: [
      ...(r.cost ? [listRow(r.cost)] : []),
      ...(r.splitToggle ? [{ k: "Sessions", v: each ? `One per issue, ${sessions}` : "One for all", act: r.splitToggle }] : []),
      ...(r.perFolder
        ? [{ k: "Folders", v: "Each its source's own", list: r.perFolder.map((f) => `${f.ref} · ${f.folder ?? "where a new session starts"}`) }]
        : pickFolder
          ? []
          : [{ k: "Folder", v: r.project ?? "Where a new session starts", ...(r.project && r.fromSource !== false ? {} : { tone: "warn" as const }) }]),
      {
        k: "Works on",
        v: each ? "Each its own task" : r.task ? `${r.task}${r.taskMismatch ? " · other issue's task" : ""}` : many ? "No task, unbound" : r.nextTask ? "Unbound" : "No problem task yet",
        ...(r.taskMismatch ? { tone: "warn" as const } : {}),
        ...(many && r.issues?.length
          ? { list: r.issues.map((i) => `${i.ref} · ${i.task ? `${i.task}${i.state ? ` ${i.state}` : ""}${i.mismatch ? " · other title" : ""}${each ? (i.mismatch ? " · unbound" : " · binds") : i.task === r.task ? " · binds" : ""}` : each ? "unbound" : "no task"}`) }
          : (r.tasks?.length ?? 0) > 1 ? { list: r.tasks!.map((t) => (t === r.task ? `${t} · binds` : t)) } : {}),
        ...(r.nextTask && !each ? { act: r.nextTask } : {}),
      },
      ...(r.reopens?.length ? [{ k: "Reopens", v: r.reopens.join(", ") }] : []),
      ...(many && r.unfiled && !r.issues?.length ? [{ k: "Unfiled", v: `${r.unfiled} of ${r.refs.length} have no task` }] : []),
      { k: many ? "Issues" : "Issue", v: r.refs.join(", ") },
      { k: "Seeded with", v: r.seeded ?? "Title", list: r.showPrompt ? Array.from(new Set(lines)) : undefined, act: { label: r.showPrompt ? "Hide the prompt" : "Show the prompt", press: r.togglePrompt } },
      { k: "Recorded on", v: many ? "Each issue" : "The issue" },
      { k: "Merges", v: MERGES_NEVER, tone: "ok" },
    ],
    ...(pickFolder ? { pick: { k: "Folder", options: r.folders!, value: r.project! } } : {}),
    stop: "Stop from its session",
    confirm: each ? `Start ${sessions} sessions` : r.reopens?.length ? `Reopen and start` : "Start the session",
    keep: "Not now",
  };
}

/** The folder a session starts in, named the way the person knows it: the project's title, else the folder's last part. */
export function folderName(path: string | undefined, projectTitle?: string | null): string | null {
  if (projectTitle) return projectTitle;
  if (!path) return null;
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * What a fix prompt carries, in the words of the issue's kind: a CI check's
 * run and its failed step with the log tail, a metric's reading and what it
 * counted, an error's frame and release. Only the facts the prompt holds.
 */
export function seededWith(f: FixFacts, kind?: OpsGroup["kind"]): string {
  const failure = kind === "check" ? "failed step, log tail" : kind === "metric" ? "reading, what it counted" : "failure";
  const parts = [
    f.title ? "title" : null,
    f.replayRef ? "replay" : null,
    f.culprit ? "culprit" : null,
    f.frame ? "stack frame" : null,
    f.release ? "release" : null,
    f.url ? (kind === "check" ? "run" : "url") : null,
    f.failure ? failure : null,
  ].filter(Boolean) as string[];
  const out = parts.join(", ");
  return out ? out[0].toUpperCase() + out.slice(1) : "The issue's id";
}
