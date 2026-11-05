// A team's deploy targets as the Deploys page and a session's journey read
// them (deploys.md DP10 to DP12): the store's rows (hooks/useSyncDeployTargets),
// and what derives from them at read time. A target's live deploy, the one
// going out and its history are read from its deploys, never stored on it.
// Pure: no store, no React.
import type { CommitCiState, QueueGroup } from "@codecast/shared/contracts/deployTargets";
import type { TargetState } from "../ship/journey";

export type DeployTargetRow = {
  _id: string;
  workspace: string;
  team_id: string;
  name: string;
  repository: string;
  runs: "here" | "push";
  policy: "press" | "auto";
  command: string | null;
  rollback: string | null;
  paths: string[];
  can_deploy: boolean;
  can_redeploy_sha: boolean;
  can_rollback: boolean;
  device_id: string | null;
  publisher_user_id: string;
  last_read?: { sha?: string; version?: string; at: number; error?: string } | null;
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
  /** The tasks its commits named. */
  tasks?: Array<{ short_id?: string | null; title?: string | null }>;
  /** What happened after it went live, over its window (deploys.md DP7): counts only. */
  after?: { new_errors: number; regressions: number; reopened: number; quiet: boolean; open: boolean } | null;
  created_at: number;
  live_at: number | null;
  finished_at: number | null;
};

export type DeploySession = { conversation_id: string; short_id?: string | null; title?: string | null };

/** A deploy's sessions as the server sent them: an older row lists conversation ids alone. */
export const sessionsOf = (d: Pick<TeamDeployRow, "sessions">): DeploySession[] =>
  (d.sessions ?? []).map((x) => (typeof x === "string" ? { conversation_id: x } : x));

export const isOpen = (d: Pick<TeamDeployRow, "status">) => d.status === "requested" || d.status === "running";

/** A target's deploys, newest first. */
export function deploysOf(t: Pick<DeployTargetRow, "name" | "repository">, deploys: ReadonlyArray<TeamDeployRow>): TeamDeployRow[] {
  return deploys.filter((d) => d.target === t.name && (!d.repository || d.repository === t.repository)).sort((a, b) => b.created_at - a.created_at);
}

/** What a target runs now, what is going out to it, and its history. */
export function targetNow(t: Pick<DeployTargetRow, "name" | "repository">, deploys: ReadonlyArray<TeamDeployRow>) {
  const mine = deploysOf(t, deploys);
  const live = mine.filter((d) => d.status === "live").sort((a, b) => (b.live_at ?? b.created_at) - (a.live_at ?? a.created_at))[0] ?? null;
  const open = mine.find(isOpen) ?? null;
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
  if (!now.live && !t.queue.known) return "unknown";
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

/** The sessions waiting on a target, with how many commits each. */
export function waitingSessions(t: DeployTargetRow): Array<{ key: string; title: string | null; commits: number }> {
  return t.queue.groups.map((g) => ({ key: g.key, title: g.session?.title ?? null, commits: g.commits.length }));
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

/** The Deploys page for the run's team, at one target when the words name one ("web dp-12"). */
export function deploysHref(run: any, words?: string | null): string {
  const team = typeof run?.workspace === "string" && run.workspace.startsWith("team:") ? run.workspace.slice(5) : null;
  const target = words?.match(/\b([a-z][a-z0-9-]{0,31}) dp-\d+/)?.[1] ?? null;
  const q = [team ? `team=${team}` : null, target ? `target=${encodeURIComponent(target)}` : null].filter(Boolean).join("&");
  return `/deploys${q ? `?${q}` : ""}`;
}
