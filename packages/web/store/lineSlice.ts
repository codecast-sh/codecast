// Line profile writes (plan pl-838). A project's line profile lives in its
// repo's `.codecast/line.toml`; projects.line_profile is the copy the daemon
// publishes from it, and only a publish writes that copy. An edit is a
// sessionCommands row (lib/sessionCommands), painted here on the click and
// riding `dispatch` to the side effect of the same name (convex/dispatch.ts
// editLineProfile), which hands it to the daemon on the machine holding the
// checkout under the row's request id. The daemon's answer, and later its
// report of the republish, settle the row through sessionCommands.results in
// every window, whichever page is open. The page shows the published copy
// with the rows still travelling laid over it (lib/lineSettings
// liveLineProfile), so a refusal or a lost machine takes nothing back from
// the project row: the row simply stops counting.
import { action, asyncAction } from "./mutativeMiddleware";
import { stampSessionCommand } from "./sessionCommandStamp";
import type { LineProfileEdit } from "@codecast/shared/contracts/lineProfile";
import { editKey } from "../lib/lineSettings";
import { LINE_CAUSE_CATEGORY, type LineCauseFields } from "../lib/line/lineCause";
import { taskCreateStub, taskStubId } from "./taskStub";
import { lineLabelKey, type LabelVerdict } from "../lib/line/lineLabels";

export type LineSliceActions = {
  editLineProfile: (requestId: string, projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
  fileLineCause: (clientKey: string, projectId: string, fields: LineCauseFields) => Promise<{ task_id: string; task_short_id: string } | null | undefined>;
  startLineCause: (taskId: string) => Promise<{ run_id: string; role_handle: string } | null | undefined>;
  resumeLineRun: (runId: string) => Promise<{ ok: true } | null | undefined>;
  labelDecision: (runId: string, nodeId: string, verdict: LabelVerdict | null, note?: string | null) => void;
};

type Tasks = { tasks: Record<string, any> };
type Labels = { lineLabels: Record<string, any>; workflowRuns: Record<string, any>; pending: Record<string, any>; currentUser?: { _id: string } | null };

/** A label painted before the server has it: keyed by its natural key, which the server row supersedes (registry altKey). */
export const lineLabelStubId = (key: string) => `label:${key}`;

export function createLineSlice(): LineSliceActions {
  return {
    editLineProfile: asyncAction(function (this: { sessionCommands: Record<string, any> }, requestId: string, projectId: string, edits: LineProfileEdit[]) {
      stampSessionCommand(this, {
        _id: requestId, command: "line_profile_edit", kind: "line_edit",
        project_id: projectId, edits: structuredClone(edits), keys: edits.map(editKey),
      });
    }) as LineSliceActions["editLineProfile"],

    // A change to the line asked of an agent (line-map.md LX6): the cause is
    // painted at once as a task create stub (taskStub.ts, superseded by the
    // server row carrying the same client_key), and rides
    // dispatch to fileLineCause, which files it through the signal door.
    fileLineCause: asyncAction(function (this: Tasks, clientKey: string, projectId: string, fields: LineCauseFields) {
      const now = Date.now();
      this.tasks[taskStubId(clientKey)] = taskCreateStub(clientKey, {
        title: fields.title,
        description: fields.detail_md,
        task_type: "feature",
        source: "signal",
        triage_status: "suggested",
        category: LINE_CAUSE_CATEGORY,
        project_id: projectId,
        cause: { signal_count: 1, first_seen: now, last_seen: now, fingerprints: [] },
      });
    }) as LineSliceActions["fileLineCause"],

    // "Start now": the cause leaves the queue the moment its run exists.
    startLineCause: asyncAction(function (this: Tasks, taskId: string) {
      const task = this.tasks[taskId];
      if (task) { task.status = "in_progress"; task.updated_at = Date.now(); }
    }) as LineSliceActions["startLineCause"],

    // "Resume": a run whose runner died continues where it stands on its
    // machine (cli workflow/runResume.ts), keeping every answer it was given.
    resumeLineRun: asyncAction(function (this: { workflowRuns: Record<string, any> }, runId: string) {
      const run = this.workflowRuns[runId];
      if (run) { const now = Date.now(); run.resume_requested_at = now; run.updated_at = now; }
    }) as LineSliceActions["resumeLineRun"],

    // A decision marked right or wrong, with a note (line-workspace.md LW4);
    // a null verdict takes the viewer's label back. One label per person per
    // decision, living where the run lives; the dispatch of the same name
    // writes it (convex lineWorkspace.label).
    labelDecision: action(function (this: Labels, runId: string, nodeId: string, verdict: LabelVerdict | null, note?: string | null) {
      const me = String(this.currentUser?._id ?? "");
      if (!me) return;
      const key = lineLabelKey(runId, nodeId, me);
      const mine = Object.values(this.lineLabels).find((l: any) => l.key === key);
      if (verdict === null) {
        if (mine) {
          delete this.lineLabels[mine._id];
          this.pending[`lineLabels:${mine._id}`] = { type: "exclude", ts: Date.now() };
        }
        return;
      }
      const text = note?.trim() || undefined;
      if (mine) {
        mine.verdict = verdict;
        mine.note = text;
        mine.at = Date.now();
        return;
      }
      const run = this.workflowRuns[runId];
      const id = lineLabelStubId(key);
      this.lineLabels[id] = {
        _id: id, key, run_id: runId, node_id: nodeId, verdict, ...(text ? { note: text } : {}), by: me, at: Date.now(),
        ...(run?.workspace ? { workspace: run.workspace } : {}), ...(run?.team_id ? { team_id: String(run.team_id) } : {}),
      };
    }) as LineSliceActions["labelDecision"],
  };
}
