// A team's deploy targets as the Deploys page and a session's journey read
// them (deploys.md DP10 to DP12): the store's rows (hooks/useSyncDeployTargets),
// and what derives from them at read time. A target's live deploy, the one
// going out and its history are read from its deploys, never stored on it.
// Pure: no store, no React.
import { worstCi, type CommitCiState, type DeployTargetPolicy, type QueueGroup, type TargetDevPush } from "@codecast/shared/contracts/deployTargets";
import { prNumberOf } from "@codecast/shared/changes";
import type { DeployPushSummary, DeployView } from "@codecast/shared/contracts/deploys";
import type { DeployPauseView } from "@codecast/shared/contracts/deployPause";
import type { TargetState } from "../ship/journey";

export type DeployTargetRow = {
  _id: string;
  workspace: string;
  team_id: string;
  name: string;
  repository: string;
  runs: "here" | "push";
  policy: DeployTargetPolicy;
  command: string | null;
  rollback: string | null;
  /** The workflow its deploys run as: codecast rolls such a target back itself, pausing production first (DP19). */
  workflow?: string | null;
  /** What that rollback adds to the workflow's inputs; without them codecast cannot send one. */
  rollback_inputs?: Record<string, string> | null;
  paths: string[];
  can_deploy: boolean;
  can_redeploy_sha: boolean;
  can_rollback: boolean;
  device_id: string | null;
  publisher_user_id: string;
  /** No checkout declared it: the page knows it only from its deploy records (no queue, no press). */
  record_only?: boolean;
  last_read?: { sha?: string; version?: string; at: number; error?: string } | null;
  /** The newest dev push (a dev watcher's push from a working tree) after the live deploy went live: prod runs
   *  someone's uncommitted work on top of that deploy. Never a deploy itself. */
  dev_push?: TargetDevPush | null;
  queue: {
    known: boolean;
    truncated: boolean;
    commits: number;
    untouched: number;
    head_sha: string | null;
    head_ci: CommitCiState;
    head_ci_url: string | null;
    shown: number;
    groups: QueueGroup[];
  };
};

/** A repository's production (DP17), one row per repository: every target of it reads its pause from here. */
export type DeployProductionRow = {
  /** The repository. */
  _id: string;
  workspace: string;
  team_id: string;
  repository: string;
  /** Its standing pause: nothing but the rollback that paused it is sent while it stands. */
  pause: DeployPauseView | null;
  /** The viewer may pause, lift and roll back production; lifting is further for whoever paused (can_lift). */
  can_pause: boolean;
  can_lift: boolean;
};

/** The production a target belongs to: its repository's row in the same workspace. */
export function productionOf(productions: ReadonlyArray<DeployProductionRow>, t: Pick<DeployTargetRow, "workspace" | "repository">): DeployProductionRow | undefined {
  return productions.find((p) => p.workspace === t.workspace && p.repository === t.repository);
}

export type DeployStatus = "requested" | "running" | "live" | "failed" | "cancelled";

export type TeamDeployRow = {
  _id: string;
  client_key?: string;
  workspace: string;
  target: string;
  repository: string;
  short_id: string;
  status: DeployStatus;
  trigger?: string;
  action: "deploy" | "redeploy" | "rollback";
  rollback_of: string | null;
  sha: string | null;
  previous_sha: string | null;
  version: string | null;
  url: string | null;
  source?: string;
  started_by: string | null;
  note: string | null;
  commits: number;
  /** The sessions whose commits it carried. */
  sessions: DeploySession[];
  steps?: Array<{ id: string; status: "pending" | "running" | "completed" | "failed" }>;
  /** Its commits by name (the newest few), each with the session that wrote it and the tasks it names. */
  commit_rows?: Array<{ sha: string; subject: string; author?: string; conversation_id?: string; tasks?: string[]; insertions?: number; deletions?: number; pr_number?: number | null; branch?: string | null }>;
  /** The tasks its commits named. */
  tasks?: Array<{ short_id?: string | null; title?: string | null }>;
  /** What happened after it went live, over its window (deploys.md DP7): counts only. */
  after?: { new_errors: number; regressions: number; reopened: number; quiet: boolean; open: boolean } | null;
  created_at: number;
  live_at: number | null;
  finished_at: number | null;
} & Partial<DeployPushSummary>;

/**
 * `user_id`: the session's owner. `priority`: the priority it serves, for a team with priorities on and a viewer who may
 * read it, else null. `task_short_ids`: the tasks this session's commits in the deploy name, every commit counted.
 */
export type DeploySession = { conversation_id: string; short_id?: string | null; title?: string | null; user_id?: string; priority?: { id: string; title: string | null } | null; task_short_ids?: string[] };

/** Who sent a deploy codecast did not start, by where it reports from. */
export function sourceWord(d: Pick<TeamDeployRow, "source" | "url">): string {
  const host = d.url ? (() => { try { return new URL(d.url!).hostname; } catch { return ""; } })() : "";
  if (/railway\./.test(host)) return "Railway";
  if (/expo\./.test(host)) return "EAS";
  const src = d.source ?? "";
  if (src.startsWith("github")) return "GitHub";
  if (src.includes("ship mark") || src === "marker") return "deploy.sh";
  if (src === "codecast") return "codecast";
  return src;
}

/** A deploy's sessions as the server sent them: an older row lists conversation ids alone. */
export const sessionsOf = (d: Pick<TeamDeployRow, "sessions">): DeploySession[] =>
  (d.sessions ?? []).map((x) => (typeof x === "string" ? { conversation_id: x } : x));

/**
 * A live deploy that took nothing new out: it carried no commits and sent the
 * sha already live. With no commits named but a new sha, its commits are only
 * unrecorded (or none touched the target), so it is not called a rebuild.
 */
export function rebuiltOnly(d: Pick<TeamDeployRow, "status" | "action" | "commits" | "sha" | "previous_sha" | "dirty">): boolean {
  // A push with uncommitted files shipped something new even on the same sha.
  if (d.dirty) return false;
  return d.status === "live" && d.action === "deploy" && !d.commits && (!d.previous_sha || d.previous_sha === d.sha);
}

/**
 * One deploy read alone (deploys.get) as the row the Deploys page lists, for a
 * deploy older than the page's window. Its sessions come without titles.
 */
export function teamRowOfView(v: DeployView & { after?: TeamDeployRow["after"] }, workspace: string): TeamDeployRow {
  const sessions = [...new Set(v.commits.flatMap((c) => (c.conversation_id ? [String(c.conversation_id)] : [])))];
  return {
    _id: v._id,
    workspace,
    target: v.target,
    repository: v.repository ?? "",
    short_id: v.short_id,
    status: v.status,
    trigger: v.trigger,
    action: v.action ?? "deploy",
    rollback_of: v.rollback_of ?? null,
    sha: v.sha,
    previous_sha: v.previous_sha,
    version: v.version,
    url: v.url,
    source: v.source,
    started_by: v.started_by?.name ?? null,
    note: v.note,
    commits: v.commits.length,
    sessions: sessions.map((conversation_id) => ({ conversation_id })),
    ...(v.steps ? { steps: v.steps.map(({ id, status }) => ({ id, status })) } : {}),
    commit_rows: v.commits.map((c) => ({ sha: c.sha, subject: c.subject, ...(c.author ? { author: c.author } : {}), ...(c.conversation_id ? { conversation_id: String(c.conversation_id) } : {}) })),
    tasks: v.carries.map((c) => ({ short_id: c.task_short_id, title: c.task_title })),
    // How the push got there, as a list row carries it: the names stay on the view.
    dirty: v.dirty ?? null,
    machine: v.machine ?? null,
    pushed_via: v.pushed_via ?? null,
    adds_count: v.adds?.length ?? 0,
    drops_count: v.drops?.length ?? 0,
    after: v.after ?? null,
    created_at: v.created_at,
    live_at: v.live_at,
    finished_at: v.finished_at,
  };
}

export const isOpen = (d: Pick<TeamDeployRow, "status">) => d.status === "requested" || d.status === "running";

/** A target's deploys, newest first. */
export function deploysOf(t: Pick<DeployTargetRow, "name" | "repository">, deploys: ReadonlyArray<TeamDeployRow>): TeamDeployRow[] {
  return deploys.filter((d) => d.target === t.name && (!d.repository || !t.repository || d.repository === t.repository)).sort((a, b) => b.created_at - a.created_at);
}

/** What a target runs now, what is going out to it, and its history. */
/** Whether a newer deploy of the target went live after this one was asked for. */
export const supersededBy = (d: Pick<TeamDeployRow, "created_at">, live: Pick<TeamDeployRow, "created_at"> | null): boolean => !!live && live.created_at > d.created_at;

export function targetNow(t: Pick<DeployTargetRow, "name" | "repository">, deploys: ReadonlyArray<TeamDeployRow>) {
  const mine = deploysOf(t, deploys);
  const live = mine.filter((d) => d.status === "live").sort((a, b) => (b.live_at ?? b.created_at) - (a.live_at ?? a.created_at))[0] ?? null;
  // A deploy asked for before the live one never went out as asked (the server closes it as superseded): not going out.
  const open = mine.find((d) => isOpen(d) && !supersededBy(d, live)) ?? null;
  const failed = mine[0]?.status === "failed" ? mine[0] : null;
  return { live, open, failed, history: mine };
}

/** The earlier live deploy a Roll back returns to: the newest live one before the live deploy, on another sha. */
export function rollbackTarget(history: ReadonlyArray<TeamDeployRow>, live: TeamDeployRow | null): TeamDeployRow | null {
  return history.find((d) => d.status === "live" && d._id !== live?._id && !!d.sha && d.sha !== live?.sha) ?? null;
}

/** The target's state in a glance: going out, failed, waiting with N commits, or up to date. */
export type TargetTone = "going" | "failed" | "waiting" | "current" | "unknown";
export function targetTone(t: DeployTargetRow, now: ReturnType<typeof targetNow>): TargetTone {
  if (now.open) return "going";
  if (now.failed) return "failed";
  // A target known only from its records has no queue: nobody knows whether it is up to date.
  if (t.record_only || !t.queue.known) return "unknown";
  return t.queue.commits > 0 ? "waiting" : "current";
}

/** Where one session's change is on each target: live in a deploy that carried it, going out, or waiting on main. */
export function sessionTargets(conversationId: string, targets: ReadonlyArray<DeployTargetRow>, deploys: ReadonlyArray<TeamDeployRow>): TargetState[] {
  const out: TargetState[] = [];
  for (const t of targets) {
    const waiting = t.queue.groups.some((g) => g.session?.conversation_id === conversationId);
    const carried = deploysOf(t, deploys).filter((d) => sessionsOf(d).some((x) => x.conversation_id === conversationId));
    const open = carried.find(isOpen);
    const live = carried.find((d) => d.status === "live");
    if (open) out.push({ name: t.name, state: "deploying", deploy: open.short_id, at: open.created_at });
    else if (waiting) out.push({ name: t.name, state: "waiting" });
    else if (live) out.push({ name: t.name, state: "live", deploy: live.short_id, at: live.live_at });
    else if (carried[0]?.status === "failed") out.push({ name: t.name, state: "failed", deploy: carried[0].short_id });
  }
  return out;
}


/** A target's display order: going out, failed, waiting (most commits first), then the rest by name. */
export function orderTargets(targets: ReadonlyArray<DeployTargetRow>, deploys: ReadonlyArray<TeamDeployRow>): DeployTargetRow[] {
  const rank: Record<TargetTone, number> = { going: 0, failed: 1, waiting: 2, current: 3, unknown: 4 };
  return [...targets].sort((a, b) => {
    const ta = targetTone(a, targetNow(a, deploys));
    const tb = targetTone(b, targetNow(b, deploys));
    return rank[ta] - rank[tb] || b.queue.commits - a.queue.commits || a.name.localeCompare(b.name);
  });
}

/** The targets a team's deploy records name that no checkout declared, as targets the page can show from their records. */
export function recordTargets(declared: ReadonlyArray<DeployTargetRow>, deploys: ReadonlyArray<TeamDeployRow>, teamId: string): DeployTargetRow[] {
  const known = new Set(declared.map((t) => t.name));
  const seen = new Map<string, TeamDeployRow>();
  for (const d of deploys) if (!known.has(d.target) && !seen.has(d.target)) seen.set(d.target, d);
  return [...seen.values()].map((d) => ({
    _id: `records#${d.target}`, workspace: d.workspace, team_id: teamId, name: d.target, repository: d.repository || "", runs: "push", policy: "press",
    command: null, rollback: null, paths: [], can_deploy: false, can_redeploy_sha: false, can_rollback: false, device_id: null, publisher_user_id: "",
    record_only: true,
    queue: { known: false, truncated: false, commits: 0, untouched: 0, head_sha: null, head_ci: "none", head_ci_url: null, shown: 0, groups: [] },
  }));
}

/** A session's title as a person reads it: markup a prompt pasted into it (`<pasted_content id=…>`) left out. */
export function sessionWords(s: { title?: string | null; short_id?: string | null; conversation_id: string }): string {
  const t = (s.title ?? "").replace(/<\/?[a-z_][^>]*>/gi, " ").replace(/\s+/g, " ").trim();
  return t || s.short_id || s.conversation_id.slice(0, 7);
}

/** A squash-merged commit's pull request: GitHub's trailing "(#N)" taken off the subject, so the number can lead the row. */
export function prOfSubject(subject: string): { pr: number | null; subject: string } {
  const pr = prNumberOf(subject);
  return { pr, subject: pr ? subject.replace(/\s*\(#\d+\)\s*$/, "") : subject };
}

/** Whether the viewer wrote a commit: its author is their GitHub login or their name. */
export function isMineCommit(author: string | null | undefined, me: { login?: string | null; name?: string | null }): boolean {
  if (!author) return false;
  const a = author.toLowerCase();
  return [me.login, me.name].some((x) => !!x && x.toLowerCase() === a);
}

/**
 * A target's waiting groups cut to the viewer's own commits; a group with none of them drops out. A commit `keep` names
 * (the one a link points at) stays, so a link never opens on a commit the filter hid.
 */
export function mineOnly(groups: ReadonlyArray<QueueGroup>, me: { login?: string | null; name?: string | null }, keep?: (c: QueueGroup["commits"][number]) => boolean): QueueGroup[] {
  return groups.flatMap((g) => {
    const commits = g.commits.filter((c) => isMineCommit(c.author, me) || !!keep?.(c));
    return commits.length ? [{ ...g, commits, ci: worstCi(commits.map((c) => c.ci)) }] : [];
  });
}
