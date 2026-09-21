import { createContext, useContext } from "react";
import { type RepoCheckout } from "./useRepoBrowse";

type KnownWorktrees = { repository: string; checkouts: RepoCheckout[] };

export const WorktreesContext = createContext<KnownWorktrees | null>(null);

/** Null outside a conversation, for a repository nobody publishes, and until the list arrives. */
export function useKnownWorktrees(): KnownWorktrees | null {
  return useContext(WorktreesContext);
}
