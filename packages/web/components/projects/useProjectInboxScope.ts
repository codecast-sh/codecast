"use client";
// The project page scopes the inbox beside it to the project
// (session-projects.md SP5): while the page is open the inbox carries the
// project's own chip, so the panel lists this project's sessions and nothing
// else. Leaving the page hands back the view the inbox had before, unless the
// person changed the chip meanwhile; then their pick stays. The chip in the
// panel is the control: its × shows everything again.
import { useLayoutEffect } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { workProjectChipKey } from "../../store/workProjects";
import { withApplyingViewHistory } from "../../lib/inboxViewHistory";

export function useProjectInboxScope(projectId: string | undefined) {
  useLayoutEffect(() => {
    if (!projectId) return;
    const key = workProjectChipKey(projectId);
    const s = useInboxStore.getState();
    const prev = {
      project: s.activeProjectFilter,
      path: s.activeProjectPath,
      exclude: !!s.chipFilterExclude,
      projectExtras: [...(s.extraProjectFilters ?? [])],
      bucket: s.activeBucketFilter,
      bucketExtras: [...(s.extraBucketFilters ?? [])],
    };
    const already = prev.project === key && !prev.exclude && prev.projectExtras.length === 0;
    if (already) return;
    // The page's own scope, not a step the person took: no back-button entry.
    withApplyingViewHistory(() => s.setActiveProjectFilter(key, null));
    return () => {
      const now = useInboxStore.getState();
      const untouched = now.activeProjectFilter === key && !now.chipFilterExclude && !(now.extraProjectFilters?.length);
      if (!untouched) return;
      withApplyingViewHistory(() => {
        if (prev.bucket) now.setActiveBucketFilter(prev.bucket, prev.exclude, prev.bucketExtras);
        else now.setActiveProjectFilter(prev.project, prev.path, prev.exclude, prev.projectExtras);
      });
    };
  }, [projectId]);
}
