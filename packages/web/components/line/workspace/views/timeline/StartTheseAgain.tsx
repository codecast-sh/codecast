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
import { isRunnerCause, runnerHold, runnerMachines, withRunners, type RunnerDevice, type RunnerRun } from "../../../../../lib/line/runnerHealth";
import { useSettingsData } from "../../../../../hooks/useSyncSettings";
import { deviceDisplayName, useDevices } from "../../../../DeviceBadge";
import type { LineViewProps } from "../types";

type TeamBox = { device_id: string; label: string; platform: string; online: boolean; is_bot?: boolean; bot_name: string | null; runner_name?: string | null };
/** Whose a machine is, as its row says it: "Aivery's agent box", "Jason's machine". */
const ownerWords = (bot: boolean, name: string | null | undefined) => `${name ?? (bot ? "A bot" : "A teammate")}'s ${bot ? "agent box" : "machine"}`;

const NONE: ProblemRow[] = [];

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
  // The viewer's own machines, then the ones their team opened to them (an agent box, a teammate's), each named with
  // whose it is; a machine in neither is named by the account its runner signed in as.
  const { byId: deviceById } = useDevices();
  const teamBoxes = (useSettingsData("agentBoxes").data ?? []) as TeamBox[];
  const members = useInboxStore((s) => s.teamMembers) as Array<{ _id: string; name?: string | null; is_bot?: boolean }> | undefined;
  const machines = useMemo(() => {
    if (!isRunnerCause(again.key)) return [];
    const runs = (workspace.rows.runs ?? []) as unknown as Array<RunnerRun & { task_id?: string | null; created_at?: number }>;
    const newest = newestRuns(runs);
    const failed = again.rows.flatMap((r) => newest.get(r.id) ?? []);
    const devices = new Map<string, RunnerDevice>(teamBoxes.map((b) => [b.device_id, { name: deviceDisplayName(b as never), online: b.online, owner: ownerWords(b.is_bot !== false, b.is_bot === false ? b.runner_name : b.bot_name) }]));
    for (const [id, d] of deviceById) devices.set(id, { name: deviceDisplayName(d), online: d.online });
    const ownerOf = (userId: string) => { const m = members?.find((x) => String(x._id) === userId); return m ? ownerWords(!!m.is_bot, m.name) : null; };
    return runnerMachines(failed, runs, devices, ownerOf);
  }, [again, workspace.rows.runs, deviceById, teamBoxes, members]);
  // A machine that stalled these and still finishes nothing would take the new runs too: none start until it does, and
  // the review says so in its figures, not only in a warning over "Start 5 runs".
  const held = runnerHold(again.key, machines);
  const starting = held ? NONE : plan.starting;
  const openMachines = useCallback(() => { onClose(); useInboxStore.getState().openSettingsModal("devices"); }, [onClose]);
  const start = useCallback(() => {
    onClose();
    for (const r of starting) {
      useInboxStore.getState().startLineCause(r.id).catch((e: unknown) => {
        if (isRefusedDispatchError(e)) onRefused?.((e instanceof Error ? e.message : String(e ?? "")).replace(/^.*ConvexError:\s*/, "").split("\n")[0] || "The server refused it");
      });
    }
  }, [starting, onClose, onRefused]);
  return (
    <SwitchReview
      ledger={withRunners(startTheseAgainLedger({
        name: again.ask ? "Ask again" : undefined, cause: again.label, count: starting.length, rest: again.rows.length - starting.length, slots: plan.slots,
        first: starting.map((r) => problemListName(r.issue)), projects: [...new Set(again.rows.map((r) => projectName(r.projectId)).filter((x): x is string => !!x))],
        cost, about: duration ? aboutWords(duration) : null, hold: held ?? plan.hold,
      }), again.key, machines, openMachines)}
      onClose={onClose} onConfirm={start} />
  );
}
