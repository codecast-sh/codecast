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
import { action, asyncAction, sync } from "./mutativeMiddleware";
import { stampSessionCommand } from "./sessionCommandStamp";
import type { LineProfileEdit } from "@codecast/shared/contracts/lineProfile";
import { editKey } from "../lib/lineSettings";
import { LINE_CAUSE_CATEGORY, type LineCauseFields } from "../lib/line/lineCause";
import { taskCreateStub, taskStubId } from "./taskStub";
import { lineLabelKey, type LabelVerdict } from "../lib/line/lineLabels";
import type { LineChatSend } from "../lib/line/lineChat";

export type LineSliceActions = {
  editLineProfile: (requestId: string, projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
  fileLineCause: (clientKey: string, projectId: string, fields: LineCauseFields) => Promise<{ task_id: string; task_short_id: string } | null | undefined>;
  startLineCause: (taskId: string) => Promise<{ run_id: string; role_handle: string } | null | undefined>;
  resumeLineRun: (runId: string) => Promise<{ ok: true } | null | undefined>;
  labelDecision: (runId: string, nodeId: string, verdict: LabelVerdict | null, note?: string | null) => void;
  // Local echoes of sendLineChat, by project id. Ephemeral: the chat's feed
  // retires each once the server row carries its client id.
  lineChatSends: Record<string, LineChatSend[]>;
  /** A person's words to the session that answers a project's line. Resolves with the server's answer; a refusal comes back as { error }. */
  sendLineChat: (projectId: string, text: string, clientId: string, graph: string | null, focus: string | null) => Promise<unknown>;
  dropLineChatSend: (projectId: string, clientId: string) => void;
  /** Save a step's prompt of a published graph (LW4): the file the .cast names, on the machine that pushed it. */
  editLineGraph: (requestId: string, workflowId: string, input: LineGraphEditInput) => Promise<{ command_id: string; workflow_id: string } | null | undefined>;
  /** Try a step's edited prompt on past cases (LW4): each case a lineTries row, queued at once. */
  tryLineStep: (tryId: string, workflowId: string, input: LineTryInput) => Promise<{ try_id: string; rows: string[] } | null | undefined>;
  /** Ask an agent to change a step (LW4): the line cause filed with the labeled cases, and its run started. */
  askLineAgent: (clientKey: string, projectId: string, fields: LineCauseFields) => Promise<{ task_id: string; task_short_id: string; started: boolean; run_id?: string; reason?: string } | null | undefined>;
};

export type LineGraphEditInput = { node: string; field?: "prompt" | "script"; text: string; base_hash?: string | null; base_text?: string | null };
/** `project_id` paints the cases into the project's feed; the server reads it off each case's run. */
export type LineTryInput = { node: string; text: string; runs: string[]; base_hash?: string | null; base_text?: string | null; project_id?: string | null };

/** A try's case painted before the server has it: its natural key, which the server row supersedes (registry altKey). */
export const lineTryKey = (tryId: string, runId: string) => `${tryId}:${runId}`;
export const lineTryStubId = (key: string) => `try:${key}`;

type Tasks = { tasks: Record<string, any> };
type Labels = { lineLabels: Record<string, any>; workflowRuns: Record<string, any>; signals?: Record<string, any>; pending: Record<string, any>; currentUser?: { _id: string } | null };

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
      // The subject: a run, or a judge's finding (its decision, judgeReview.labelFinding).
      const run = this.workflowRuns[runId] ?? this.signals?.[runId];
      const id = lineLabelStubId(key);
      this.lineLabels[id] = {
        _id: id, key, run_id: runId, node_id: nodeId, verdict, ...(text ? { note: text } : {}), by: me, at: Date.now(),
        ...(run?.workspace ? { workspace: run.workspace } : {}), ...(run?.team_id ? { team_id: String(run.team_id) } : {}),
      };
    }) as LineSliceActions["labelDecision"],

    // A step's save (line-workspace.md LW4): the drawn graph's copy of the
    // step paints the new text at once, and a sessionCommands row (keyed by
    // the request id) rides dispatch to editLineGraph, which hands the daemon
    // on the graph's machine the write; its answer and its push report settle
    // the row. A refusal takes the paint back with the row.
    editLineGraph: asyncAction(function (this: { sessionCommands: Record<string, any>; workflows: Record<string, any>; currentUser?: { _id: string } | null }, requestId: string, workflowId: string, input: LineGraphEditInput) {
      const field = input.field ?? "prompt";
      stampSessionCommand(this, {
        _id: requestId, command: "line_graph_edit", kind: "line_graph_edit",
        workflow_id: workflowId, node: input.node, field, text: input.text, ...(input.base_hash ? { base_hash: input.base_hash } : {}),
      });
      // Paint the row the server writes (lineActions.editableGraph): the drawn
      // graph when it is the viewer's, else the viewer's own push of it. A
      // teammate's row is never painted, or its next sync would take the edit back.
      const drawn = this.workflows[workflowId];
      const me = String(this.currentUser?._id ?? "");
      const target = drawn && String(drawn.user_id) === me
        ? drawn
        : Object.values(this.workflows).find((w: any) => String(w.user_id) === me && w.slug === drawn?.slug);
      const node = target?.nodes?.find((n: any) => n.id === input.node);
      if (node) node[field] = input.text;
    }) as LineSliceActions["editLineGraph"],

    // Try (LW4): each chosen case paints queued under its natural key, and
    // rides dispatch to tryLineStep, which queues the server rows and hands
    // the graph's machine the run; its reports stream into lineTries.
    tryLineStep: asyncAction(function (this: { lineTries: Record<string, any>; workflowRuns: Record<string, any>; currentUser?: { _id: string } | null }, tryId: string, workflowId: string, input: LineTryInput) {
      const now = Date.now();
      for (const runId of input.runs) {
        const key = lineTryKey(tryId, runId);
        const run = this.workflowRuns[runId];
        this.lineTries[lineTryStubId(key)] = {
          _id: lineTryStubId(key), key, try_id: tryId, workflow_id: workflowId, node_id: input.node, run_id: runId,
          ...(input.project_id ? { project_id: input.project_id } : {}),
          ...(run?.task_id ? { case_id: String(run.task_id) } : {}),
          by: String(this.currentUser?._id ?? ""), at: now, updated_at: now, status: "queued", old: {},
          ...(input.base_hash ? { base_hash: input.base_hash } : {}),
        };
      }
    }) as LineSliceActions["tryLineStep"],

    // Ask an agent (LW4): painted like fileLineCause, already in progress,
    // since the side effect files the cause and starts its run in one write.
    askLineAgent: asyncAction(function (this: Tasks, clientKey: string, projectId: string, fields: LineCauseFields) {
      const now = Date.now();
      this.tasks[taskStubId(clientKey)] = taskCreateStub(clientKey, {
        title: fields.title,
        description: fields.detail_md,
        task_type: "feature",
        source: "signal",
        triage_status: "suggested",
        status: "in_progress",
        category: LINE_CAUSE_CATEGORY,
        project_id: projectId,
        cause: { signal_count: 1, first_seen: now, last_seen: now, fingerprints: [] },
      });
    }) as LineSliceActions["askLineAgent"],

    lineChatSends: {},

    // The line's chat (line-workspace.md LW4, convex lineChat.ts): the words
    // paint at once as a local echo, the sendLineChat side effect delivers
    // them to the session that answers the line (starting one when nobody
    // leads the project), and the chat feed's row carrying the same client id
    // retires the echo. A refusal is returned, not thrown, so the caller takes
    // the echo back (lib/decisionDiscussion settleEchoedSend).
    sendLineChat: asyncAction(function (this: { lineChatSends: Record<string, LineChatSend[]> }, projectId: string, text: string, clientId: string, _graph: string | null, _focus: string | null) {
      const sends = (this.lineChatSends[projectId] ??= []);
      if (!sends.some((x) => x.client_id === clientId)) sends.push({ client_id: clientId, text: text.trim(), at: Date.now() });
    }) as LineSliceActions["sendLineChat"],
    dropLineChatSend: sync(function (this: { lineChatSends: Record<string, LineChatSend[]> }, projectId: string, clientId: string) {
      const sends = this.lineChatSends[projectId];
      if (!sends) return;
      const kept = sends.filter((x) => x.client_id !== clientId);
      if (kept.length) this.lineChatSends[projectId] = kept;
      else delete this.lineChatSends[projectId];
    }) as LineSliceActions["dropLineChatSend"],
  };
}
