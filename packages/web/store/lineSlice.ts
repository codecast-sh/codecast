// Line profile writes (plan pl-838). A project's line profile lives in its
// repo's `.codecast/line.toml`, and projects.line_profile is the copy the
// daemon publishes from it. An edit paints that copy on the draft in the
// frame it is made, and rides `dispatch` to the side effect of the same name
// (convex/dispatch.ts editLineProfile), which hands the edit to the daemon on
// the machine holding the checkout. The promise answers the daemon command
// id, which the page watches; a refusal there (the loader's message) comes
// back through restoreLineProfile, key by key, so an edit to another field in
// flight keeps its paint.
//
// The paint assigns the whole field, so the engine locks it: a push of the
// project row for another reason (task_counts) cannot take the paint back
// while the daemon writes. The republished row never equals the paint by
// shape (it carries the server's changed_at and published_at), so the lock
// is settled by content instead: settleLineProfile releases it once a push
// the lock held back says the same thing (lineProfileContentKey). A republish
// that fails leaves the paint standing, which is what the file now says.
import { current, isDraft } from "mutative";
import { asyncAction, sync } from "./mutativeMiddleware";
import { lineProfileContentKey, type LineProfileEdit, type PublishedLineProfile } from "@codecast/shared/contracts/lineProfile";
import { applyLineEdits, restoreLineKeys } from "../lib/lineSettings";

export type LineSliceActions = {
  editLineProfile: (projectId: string, edits: LineProfileEdit[]) => Promise<{ command_id: string } | null | undefined>;
  restoreLineProfile: (projectId: string, prior: PublishedLineProfile, keys: string[]) => void;
  settleLineProfile: (projectId: string) => void;
};

type LineDraft = {
  projects: Record<string, { line_profile?: PublishedLineProfile | null }>;
  pending: Record<string, { type: string; value?: unknown; seen?: unknown[] } | undefined>;
};

/** The field lock an edit plants (the engine's `collection:id:field` key). */
export const lineProfileLockKey = (projectId: string) => `projects:${projectId}:line_profile`;

/** A plain copy of the row's profile to build the next one on. */
const cloneOf = (lp: PublishedLineProfile): PublishedLineProfile => structuredClone(isDraft(lp) ? current(lp) : lp);

export function createLineSlice(): LineSliceActions {
  return {
    editLineProfile: asyncAction(function (this: LineDraft, projectId: string, edits: LineProfileEdit[]) {
      const row = this.projects[projectId];
      if (!row?.line_profile) return;
      const next = cloneOf(row.line_profile);
      applyLineEdits(next, edits);
      row.line_profile = next;
    }) as LineSliceActions["editLineProfile"],

    restoreLineProfile: sync(function (this: LineDraft, projectId: string, prior: PublishedLineProfile, keys: string[]) {
      const row = this.projects[projectId];
      if (!row?.line_profile) return;
      const next = cloneOf(row.line_profile);
      restoreLineKeys(next, prior, keys);
      row.line_profile = next;
      // The lock holds what the page shows: keep it in step, or the next push
      // would re-assert the refused paint.
      const lock = this.pending[lineProfileLockKey(projectId)];
      if (lock?.type === "field") lock.value = structuredClone(next);
    }),

    settleLineProfile: sync(function (this: LineDraft, projectId: string) {
      const key = lineProfileLockKey(projectId);
      const lock = this.pending[key];
      const row = this.projects[projectId];
      if (lock?.type !== "field" || !row) return;
      const seen = lock.seen ?? [];
      const echo = seen[seen.length - 1] as PublishedLineProfile | undefined;
      if (!echo || lineProfileContentKey(echo) !== lineProfileContentKey(lock.value as PublishedLineProfile)) return;
      row.line_profile = structuredClone(isDraft(echo) ? current(echo) : echo);
      delete this.pending[key];
    }),
  };
}
