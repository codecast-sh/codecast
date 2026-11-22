"use client";
// A branch a message names that the repository's changes do not hold: GitHub
// lists only a repository's first hundred branches, so this one is compared with
// the default branch on its own. With commits main lacks it draws as its change;
// a name that is no branch at all stays the code it was written as.
import type { ReactNode } from "react";
import { useRepoBranches, useRepoCompare } from "../../hooks/useRepoBrowse";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { changeLifecycle } from "../../lib/changes/lifecycle";
import { repoCompareHref } from "../../lib/repoView";
import { ChangeChip } from "./ChangeChip";

export function UnlistedBranch({ repository, name, children }: { repository: string; name: string; children: ReactNode }) {
  const base = useRepoBranches(repository).data?.default_branch;
  const compare = useRepoCompare(repository, base, base && base !== name ? name : undefined);
  const now = useCoarseNow(60_000);
  const ahead = compare.data?.ahead_by ?? 0;
  if (!base || !ahead) return <>{children}</>;
  const lifecycle = changeLifecycle({ vehicle: { kind: "branch", name, worktree: null, pr: null }, work: { uncommitted: 0, ahead, pushed: true, writers: [] } }, now);
  return <ChangeChip lifecycle={lifecycle} label={name} links={{ href: repoCompareHref(repository, base, name) }} />;
}
