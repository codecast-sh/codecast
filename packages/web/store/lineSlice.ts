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
import { asyncAction } from "./mutativeMiddleware";
import { stampSessionCommand } from "./sessionCommandStamp";
import type { LineProfileEdit } from "@codecast/shared/contracts/lineProfile";
import { editKey } from "../lib/lineSettings";
import { LINE_CAUSE_CATEGORY, type LineCauseFields } from "../lib/line/lineCause";

export type LineSliceActions = {
  editLineProfile: (requestId: string, projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
  fileLineCause: (clientKey: string, projectId: string, fields: LineCauseFields) => Promise<{ task_id: string; task_short_id: string } | null | undefined>;
  startLineCause: (taskId: string) => Promise<{ run_id: string; role_handle: string } | null | undefined>;
};

type Tasks = { tasks: Record<string, any> };

export function createLineSlice(): LineSliceActions {
  return {
    editLineProfile: asyncAction(function (this: { sessionCommands: Record<string, any> }, requestId: string, projectId: string, edits: LineProfileEdit[]) {
      stampSessionCommand(this, {
        _id: requestId, command: "line_profile_edit", kind: "line_edit",
        project_id: projectId, edits: structuredClone(edits), keys: edits.map(editKey),
      });
    }) as LineSliceActions["editLineProfile"],

    // A change to the line asked of an agent (line-map.md LX6): the cause is
    // painted at once under the tasks create-stub convention (temp_task_<key>,
    // superseded by the server row carrying the same client_key), and rides
    // dispatch to fileLineCause, which files it through the signal door.
    fileLineCause: asyncAction(function (this: Tasks, clientKey: string, projectId: string, fields: LineCauseFields) {
      const now = Date.now();
      this.tasks[`temp_task_${clientKey}`] = {
        _id: `temp_task_${clientKey}`,
        client_key: clientKey,
        short_id: "ct-…",
        title: fields.title,
        description: fields.detail_md,
        task_type: "feature",
        status: "open",
        priority: "medium",
        source: "signal",
        triage_status: "suggested",
        category: LINE_CAUSE_CATEGORY,
        project_id: projectId,
        cause: { signal_count: 1, first_seen: now, last_seen: now, fingerprints: [] },
        created_at: now,
        updated_at: now,
      };
    }) as LineSliceActions["fileLineCause"],

    // "Start now": the cause leaves the queue the moment its run exists.
    startLineCause: asyncAction(function (this: Tasks, taskId: string) {
      const task = this.tasks[taskId];
      if (task) { task.status = "in_progress"; task.updated_at = Date.now(); }
    }) as LineSliceActions["startLineCause"],
  };
}
