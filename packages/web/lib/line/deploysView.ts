// The Deploys view's model (docs/architecture/deploys.md DP7), pure so a test
// reads it. What waits to go out comes from the problems' own histories: a
// ship whose merge no live deploy carried (causeHistory carryingDeploys, the
// rule the server's deploy stage reads), less what an open deploy is sending.
import type { LineIssue } from "./lineModel";
import type { LineDeploy } from "../../hooks/useLineWorkspace";
import { bucketCounts, DAY } from "./timeline";

export type WaitingFix = { taskId: string; ref: string | null; title: string; runId: string; sha: string; mergedAt: number };
export type WaitingGroup = { projectId: string; fixes: WaitingFix[]; open: LineDeploy | null };

/** How long after a deploy a carried fix's findings count against it: the line's default watch. */
export const AFTER_FIX_MS = 7 * DAY;

export const isOpenDeploy = (d: Pick<LineDeploy, "status">) => d.status === "requested" || d.status === "running";

/** Per project, the shipped fixes no live deploy carried, oldest first, and the deploy already on its way. */
export function waitingToGoOut(issues: ReadonlyArray<LineIssue>, deploys: ReadonlyArray<LineDeploy>, projectOf: (taskId: string) => string | null): WaitingGroup[] {
  const open = new Map<string, LineDeploy>();
  for (const d of deploys) if (isOpenDeploy(d) && d.project_id && !open.has(d.project_id)) open.set(d.project_id, d);
  const sending = new Set([...open.values()].flatMap((d) => d.carries.map((c) => c.run_id ?? "")));
  const by = new Map<string, WaitingFix[]>();
  for (const i of issues) {
    const project = projectOf(i.id);
    if (!project) continue;
    for (const s of i.history.ships) {
      if (!s.merge || s.deploys.length || sending.has(s.runId)) continue;
      const list = by.get(project) ?? [];
      list.push({ taskId: i.id, ref: i.ref, title: i.name || i.title, runId: s.runId, sha: s.merge.sha, mergedAt: s.merge.at });
      by.set(project, list);
    }
  }
  const projects = new Set([...by.keys(), ...open.keys()]);
  return [...projects].map((projectId) => ({ projectId, fixes: (by.get(projectId) ?? []).sort((a, b) => a.mergedAt - b.mergedAt), open: open.get(projectId) ?? null }));
}

export type ActivityChart = {
  from: number;
  to: number;
  step: number;
  /** Findings per bucket over every problem in view. */
  all: number[];
  /** Findings per bucket of the problems the picked deploy carried; null when none is picked. */
  carried: number[] | null;
  max: number;
  deploys: Array<{ id: string; short_id: string; at: number; tone: string; label: string; picked: boolean }>;
};

/**
 * Findings per day over the window, with every deploy in it as a marker: the
 * picked deploy's carried problems drawn on their own, so whether their
 * findings stopped after it, or came back, reads at a glance.
 */
export function activityChart(issues: ReadonlyArray<LineIssue>, deploys: ReadonlyArray<LineDeploy & { tone: string; label: string }>, picked: LineDeploy | null, now: number, days = 30): ActivityChart {
  const step = days > 14 ? DAY : DAY / 4;
  const to = Math.ceil(now / step) * step;
  const from = to - days * DAY;
  const times = issues.flatMap((i) => i.history.occurrences.map((o) => o.at)).sort((a, b) => a - b);
  const all = bucketCounts(times, from, to, step);
  const carriedIds = picked ? new Set(carriesOf(picked, issues).map((c) => c.task_id)) : null;
  const carried = carriedIds
    ? bucketCounts(issues.filter((i) => carriedIds.has(i.id)).flatMap((i) => i.history.occurrences.map((o) => o.at)).sort((a, b) => a - b), from, to, step)
    : null;
  return {
    from, to, step, all, carried,
    max: Math.max(1, ...all),
    deploys: deploys
      .filter((d) => d.at >= from && d.at <= to)
      .map((d) => ({ id: d.deploy_id ?? d._id, short_id: d.short_id, at: d.at, tone: d.tone, label: d.label, picked: !!picked && (picked.deploy_id ?? picked._id) === (d.deploy_id ?? d._id) })),
  };
}

/**
 * What a deploy carried: what the server recorded (the fixes the stage sent, or
 * the merges on line runs the rule reads), and every problem whose history
 * says this deploy carried its fix, a pull request merged by hand included
 * (causeHistory ships, the same rule). One list, so the deploy and the
 * problem's timeline never disagree.
 */
export function carriesOf(d: LineDeploy, issues: ReadonlyArray<LineIssue>): LineDeploy["carries"] {
  const out = [...d.carries];
  const have = new Set(out.map((c) => c.task_id));
  if (!d.short_id) return out;
  for (const i of issues) {
    if (have.has(i.id)) continue;
    const ship = i.history.ships.find((s) => s.deploys.some((x) => x.ref === d.short_id));
    if (!ship) continue;
    const how = ship.deploys.find((x) => x.ref === d.short_id)!.how;
    out.push({ task_id: i.id, run_id: ship.runId, how, task_short_id: i.ref, task_title: i.title, decision_short_id: null, ...(ship.merge ? { merge_sha: ship.merge.sha, merged_at: ship.merge.at } : {}) });
    have.add(i.id);
  }
  return out;
}

/** One carried problem after its deploy, as the detail lists it. */
export type CarriedRow = { taskId: string; ref: string | null; title: string; decisionRef: string | null; how: string; findings: number; reopened: boolean; before: number };

/** The carried problems with their findings in the week before the deploy and in its after window. */
export function carriedRows(d: LineDeploy, issues: ReadonlyArray<LineIssue>): CarriedRow[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  return carriesOf(d, issues).map((c) => {
    const i = byId.get(c.task_id);
    const after = d.after?.problems.find((p) => p.task_id === c.task_id);
    // A fix is judged over the week after it went live (the line's watch), whatever deploys came next.
    const seen = i ? i.history.occurrences.filter((o) => o.at >= d.at && o.at < d.at + AFTER_FIX_MS) : [];
    const before = i ? i.history.occurrences.filter((o) => o.at < d.at && o.at >= d.at - 7 * DAY).length : 0;
    return {
      taskId: c.task_id,
      ref: c.task_short_id ?? i?.ref ?? null,
      title: c.task_title ?? i?.title ?? "A problem",
      decisionRef: c.decision_short_id ?? null,
      how: c.how,
      findings: seen.length,
      reopened: !!after?.reopened,
      before,
    };
  });
}
