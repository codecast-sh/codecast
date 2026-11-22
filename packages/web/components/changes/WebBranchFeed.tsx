"use client";
// GitHub's branch list for a conversation's changes on the web (ChangesContext
// BranchFeed): a pushed branch with no pull request and no checkout here is
// still a change a message names.
import { useEffect } from "react";
import { useRepoBranchDetails } from "../../hooks/useRepoBrowse";
import type { RepoChangeRows } from "../../lib/changes/assemble";

export function WebBranchFeed({ repository, onRead }: { repository: string; onRead: (r: { data: RepoChangeRows["branches"]; read: boolean }) => void }) {
  const r = useRepoBranchDetails(repository);
  const read = r.ready || !!r.error;
  useEffect(() => onRead({ data: r.data ?? null, read }), [r.data, read, onRead]);
  return null;
}
