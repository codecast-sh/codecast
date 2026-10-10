// A project's customized line (plan pl-838 step 3), written from the line
// settings' Stations. One action carries the whole workflow by slug: the
// fork, each station edit and each reset. It paints the `workflows` row in
// the draft (a stub keyed `wf:<slug>` until the server row supersedes it by
// the registry's `slug` altKey) and rides dispatch to workflows.webUpsert.
// The fork goes as a create: the server refuses it when the slug already has
// a row, so a page that has not seen the fork can never write the shipped
// stations over it. removeLineWorkflow drops the fork (stop customizing).
import { action } from "./mutativeMiddleware";
import type { LineWorkflow } from "../lib/line/lineStations";

export type LineWorkflowSliceActions = {
  saveLineWorkflow: (wf: LineWorkflow, opts?: { create?: boolean }) => void;
  removeLineWorkflow: (slug: string) => void;
};

type LineWorkflowDraft = { workflows: Record<string, any>; currentUser?: { _id: string } | null };

/** The stub id a fork paints under before the server row has an id. */
export const lineWorkflowStubId = (slug: string) => `wf:${slug}`;

/** A `workflows` row is the viewer's own. The collection also holds rows
 *  other people own (workflow_runs.graphOfRun: the graph a teammate's run
 *  ran, drawn on the line map), which no list of the viewer's workflows, slug
 *  lookup or edit may take for theirs. Before the viewer is known, every row
 *  counts, as does a row that names no owner. */
export function isViewersWorkflow(row: { user_id?: unknown } | null | undefined, viewerId: unknown): boolean {
  if (!row) return false;
  return !viewerId || !row.user_id || String(row.user_id) === String(viewerId);
}

const idOfSlug = (draft: LineWorkflowDraft, slug: string) =>
  Object.keys(draft.workflows ?? {}).find((id) => draft.workflows[id]?.slug === slug && isViewersWorkflow(draft.workflows[id], draft.currentUser?._id));

export function createLineWorkflowSlice(): LineWorkflowSliceActions {
  return {
    saveLineWorkflow: action(function (this: LineWorkflowDraft, wf: LineWorkflow, opts?: { create?: boolean }) {
      const id = idOfSlug(this, wf.slug);
      const row = id ? this.workflows[id] : null;
      // A create over a row this window already holds paints nothing; the
      // server refuses it the same way.
      if (row && opts?.create) return;
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
      const stub = lineWorkflowStubId(wf.slug);
      const now = Date.now();
      this.workflows[stub] = { _id: stub, user_id: String(this.currentUser?._id ?? ""), ...wf, created_at: now, updated_at: now };
    }),

    removeLineWorkflow: action(function (this: LineWorkflowDraft, slug: string) {
      const id = idOfSlug(this, slug);
      if (id) delete this.workflows[id];
    }),
  };
}
