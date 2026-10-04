// A project's customized line (plan pl-838 step 3), written from the line
// settings' Stations. One action carries the whole workflow by slug: the
// fork, each station edit and each reset. It paints the `workflows` row in
// the draft (a stub keyed `wf:<slug>` until the server row supersedes it by
// the registry's `slug` altKey) and rides dispatch to workflows.webUpsert.
import { action } from "./mutativeMiddleware";
import type { LineWorkflow } from "../lib/line/lineStations";

export type LineWorkflowSliceActions = {
  saveLineWorkflow: (wf: LineWorkflow) => void;
};

type LineWorkflowDraft = { workflows: Record<string, any>; currentUser?: { _id: string } | null };

/** The stub id a fork paints under before the server row has an id. */
export const lineWorkflowStubId = (slug: string) => `wf:${slug}`;

export function createLineWorkflowSlice(): LineWorkflowSliceActions {
  return {
    saveLineWorkflow: action(function (this: LineWorkflowDraft, wf: LineWorkflow) {
      const row = Object.values(this.workflows ?? {}).find((w: any) => w?.slug === wf.slug);
      if (row) {
        // Only what moved: an unchanged field stays out of the undo record
        // and holds no lock waiting for its echo.
        if (row.name !== wf.name) row.name = wf.name;
        if (wf.goal !== undefined && row.goal !== wf.goal) row.goal = wf.goal;
        if (wf.source !== undefined && row.source !== wf.source) row.source = wf.source;
        if (JSON.stringify(row.edges ?? []) !== JSON.stringify(wf.edges)) row.edges = wf.edges;
        row.nodes = wf.nodes;
        return;
      }
      const id = lineWorkflowStubId(wf.slug);
      const now = Date.now();
      this.workflows[id] = { _id: id, user_id: String(this.currentUser?._id ?? ""), ...wf, created_at: now, updated_at: now };
    }),
  };
}
