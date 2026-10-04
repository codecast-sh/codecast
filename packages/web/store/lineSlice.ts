// Line profile writes (plan pl-838). A project's line profile lives in its
// repo's `.codecast/line.toml`, and projects.line_profile is the copy the
// daemon publishes from it. An edit paints that copy on the draft in the
// frame it is made, and rides `dispatch` to the side effect of the same name
// (convex/dispatch.ts editLineProfile), which hands the edit to the daemon on
// the machine holding the checkout. The paint is a deep write, so it carries
// no field lock: the republish that follows a good write replaces the row
// with the file's truth. The promise answers the daemon command id, which the
// page watches; a refusal there (the loader's message) comes back through
// restoreLineProfile, key by key, so an edit to another field in flight keeps
// its paint.
import { asyncAction, sync } from "./mutativeMiddleware";
import type { LineProfileEdit, PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { applyLineEdits, restoreLineKeys } from "../lib/lineSettings";

export type LineSliceActions = {
  editLineProfile: (projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
  restoreLineProfile: (projectId: string, prior: PublishedLineProfile, keys: string[]) => void;
};

type LineDraft = { projects: Record<string, { line_profile?: PublishedLineProfile | null }> };

export function createLineSlice(): LineSliceActions {
  return {
    editLineProfile: asyncAction(function (this: LineDraft, projectId: string, edits: LineProfileEdit[]) {
      const lp = this.projects[projectId]?.line_profile;
      if (lp) applyLineEdits(lp, edits);
    }) as LineSliceActions["editLineProfile"],

    restoreLineProfile: sync(function (this: LineDraft, projectId: string, prior: PublishedLineProfile, keys: string[]) {
      const lp = this.projects[projectId]?.line_profile;
      if (lp) restoreLineKeys(lp, prior, keys);
    }),
  };
}
