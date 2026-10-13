"use client";
// One failure cause started again (line-journeys.md LJ8.2, Start these again): the review that names how many runs
// start, what they cost, how long one takes, what holds the rest, and the machines behind a runner cause. Problems'
// Failed headings and a step page's cause heading open this same review on the same rows.
import { useCallback, useMemo } from "react";
import { useInboxStore } from "../../../../../store/inboxStore";
import { isRefusedDispatchError } from "../../../../../store/mutativeMiddleware";
import { problemListName, type ProblemRow } from "../../../../../lib/line/problemTable";
import { aboutWords, useRunDuration } from "../../../../../lib/line/runDuration";
import { SwitchReview } from "../../../../consequential/ConsequentialSwitch";
import { startTheseAgainLedger } from "../../../../consequential/ledgers";
import { useRunCost } from "../../../../consequential/useRunCost";
import { useLineAdmissions } from "../../../map/useLineAdmission";
import { startAgainPlan } from "../../../../../lib/lineFlow";
import { newestRuns } from "../../../../../lib/line/problemPage";
import { isRunnerCause, runnerMachines, withRunners, type RunnerRun } from "../../../../../lib/line/runnerHealth";
import { deviceDisplayName, useDevices } from "../../../../DeviceBadge";
import type { LineViewProps } from "../types";

export type AgainCause = { key: string; label: string; rows: ProblemRow[]; /** The runs ask again (Needs a new ask). */ ask?: boolean };

export function StartTheseAgain({ again, workspace, projectName, onClose, onRefused }: {
  again: AgainCause;
  workspace: Pick<LineViewProps["workspace"], "projects" | "rows">;
  projectName: (id: string | null) => string | null | undefined;
  onClose: () => void;
  /** The server refused a start: its words, for the heading to show. */
  onRefused?: (words: string) => void;
}) {
  const cost = useRunCost(again.rows[0]?.projectId ?? null);
  const projects = useMemo(() => [...new Set(again.rows.map((r) => r.projectId).filter((p): p is string => !!p))].sort(), [again]);
  // What the start goes past, per project its runs belong to: the first line that is off or short of places says so.
  const lines = useLineAdmissions(useMemo(() => projects.map((id) => ({ _id: id, workspace: (workspace.projects.find((p) => p._id === id) as { workspace?: string | null } | undefined)?.workspace ?? null })), [projects, workspace.projects]));
  // Each project's line paces its own: the first ones in the heading's order, up to what Turn on would start now; the
  // rest stay under the heading. A project with no admission yet starts nothing until it answers.
  const plan = useMemo(() => {
    const plans = new Map(projects.map((id) => [id, startAgainPlan(lines.get(id), again.rows.filter((r) => r.projectId === id).length)]));
    const left = new Map([...plans].map(([id, p]) => [id, p.now]));
    const starting = again.rows.filter((r) => { const n = r.projectId ? left.get(r.projectId) ?? 0 : 1; if (n <= 0) return false; if (r.projectId) left.set(r.projectId, n - 1); return true; });
    const all = [...plans.values()];
    return { starting, rest: again.rows.length - starting.length, hold: all.map((p) => p.hold).find(Boolean) ?? null, slots: all.find((p) => p.slots != null)?.slots ?? null };
  }, [again, projects, lines]);
  const duration = useRunDuration(projects);
  // A machine behind the failures (a session that never started, a runner that stopped): the review names each machine
  // those runs ran on and whether it works now, and holds the start while none does (runnerHealth).
  const { byId: deviceById } = useDevices();
  const machines = useMemo(() => {
    if (!isRunnerCause(again.key)) return [];
    const runs = (workspace.rows.runs ?? []) as unknown as Array<RunnerRun & { task_id?: string | null; created_at?: number }>;
    const newest = newestRuns(runs);
    const failed = again.rows.flatMap((r) => newest.get(r.id) ?? []);
    const devices = new Map([...deviceById].map(([id, d]) => [id, { name: deviceDisplayName(d), online: d.online }]));
    return runnerMachines(failed, runs, devices);
  }, [again, workspace.rows.runs, deviceById]);
  const start = useCallback(() => {
    onClose();
    for (const r of plan.starting) {
      useInboxStore.getState().startLineCause(r.id).catch((e: unknown) => {
        if (isRefusedDispatchError(e)) onRefused?.((e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it");
      });
    }
  }, [plan, onClose, onRefused]);
  return (
    <SwitchReview
      ledger={withRunners(startTheseAgainLedger({
        name: again.ask ? "Ask again" : undefined, cause: again.label, count: plan.starting.length, rest: plan.rest, slots: plan.slots,
        first: plan.starting.map((r) => problemListName(r.issue)), projects: [...new Set(again.rows.map((r) => projectName(r.projectId)).filter((x): x is string => !!x))],
        cost, about: duration ? aboutWords(duration) : null, hold: plan.hold,
      }), again.key, machines)}
      onClose={onClose} onConfirm={start} />
  );
}
