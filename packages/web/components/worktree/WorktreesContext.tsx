// The worktrees of the repository a conversation works in, read once for the
// whole transcript. Inline code is matched against this list (EntityAwareCode),
// and a transcript holds hundreds of code spans: each asks the context, none
// mounts a read of its own.
import { useMemo, type ReactNode } from "react";
import { useRepoWorktrees } from "../../hooks/useRepoBrowse";
import { WorktreesContext } from "../../hooks/useKnownWorktrees";

export function WorktreesProvider({ repository, children }: { repository?: string | null; children: ReactNode }) {
  const checkouts = useRepoWorktrees(repository ?? undefined).data?.checkouts;
  const value = useMemo(() => (repository && checkouts?.length ? { repository, checkouts } : null), [repository, checkouts]);
  return <WorktreesContext.Provider value={value}>{children}</WorktreesContext.Provider>;
}
