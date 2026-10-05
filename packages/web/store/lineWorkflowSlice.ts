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

const idOfSlug = (workflows: Record<string, any>, slug: string) =>
  Object.keys(workflows ?? {}).find((id) => workflows[id]?.slug === slug);

export function createLineWorkflowSlice(): LineWorkflowSliceActions {
  return {
    saveLineWorkflow: action(function (this: LineWorkflowDraft, wf: LineWorkflow, opts?: { create?: boolean }) {
      const id = idOfSlug(this.workflows, wf.slug);
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
      const id = idOfSlug(this.workflows, slug);
      if (id) delete this.workflows[id];
    }),
  };
}
