// The changes a conversation's messages mention (docs/architecture/changes.md CH4): the
// context ChangesProvider fills, and the hook a code span asks with. A transcript holds
// hundreds of code spans: nothing is read until one looks like a branch, and each span
// re-renders only when its own change moves.
import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { RepoChange } from "./useRepoChanges";

export type ChangesStore = {
  repository: string;
  want: () => void;
  subscribe: (fn: () => void) => () => void;
  /** The change `ref` names, the same object until that change's now or stages move. */
  find: (ref: string) => RepoChange | null;
  /** The repository's changes have been read at least once: a name they lack is not one of them. */
  loaded: () => boolean;
  /**
   * Whether `name` may be looked up on its own: only when GitHub's branch list was cut short (otherwise a name it
   * lacks is no branch), never the repository's own name, and for at most UNLISTED_MAX names a conversation.
   */
  mayLookUp: (name: string) => boolean;
};

export const ChangesContext = createContext<ChangesStore | null>(null);

const NEVER = () => () => {};

/** Branch names a conversation looks up one by one, at most: each is a GitHub compare. */
export const UNLISTED_MAX = 8;

/**
 * Text an agent writes for a branch: segments of letters, digits, `.`, `_`, `-` joined by `/`, the last not a file
 * (`evals/budget-checks`, `ship/ct-98647`, `codecast/change-ct-98647`). A path to a file or a source directory is not.
 */
export function looksLikeBranch(text: string): boolean {
  if (text.length > 80 || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){1,3}$/.test(text)) return false;
  // A branch an agent names carries a word break or a number (`evals/budget-checks`, `ship/ct-98647`, `release/1.2`);
  // `origin/main`, `text/html`, `and/or` and `hooks/useX` do not.
  if (!/[-_]|[A-Za-z]\d|\d\.\d/.test(text) || /^\d+\/\d+$/.test(text)) return false;
  if (/\.[A-Za-z]{1,5}$/.test(text) || text.startsWith(".")) return false;
  return !/^(packages|src|lib|app|components|docs|tests?|outreach|node_modules|scripts|apps|hooks)\//.test(text);
}

/**
 * What a code span names, once the conversation's changes are read: its change; `unlisted` when it looks like a branch
 * the changes do not hold (GitHub lists only a repository's first hundred branches, so the span asks for that one);
 * null while reading, or for anything else.
 */
export function useMentionedChange(text: string, known: boolean): RepoChange | "unlisted" | null {
  const store = useContext(ChangesContext);
  const asks = !!store && (known || looksLikeBranch(text));
  useEffect(() => {
    if (asks) store!.want();
  }, [asks, store]);
  const snapshot = () => {
    if (!asks) return null;
    const change = store!.find(text);
    if (change) return change;
    // A worktree's branch keeps its worktree pill; only a name nothing here holds is looked up on its own.
    return !known && store!.loaded() && store!.mayLookUp(text) ? "unlisted" : null;
  };
  return useSyncExternalStore(asks ? store!.subscribe : NEVER, snapshot, () => null);
}

/** The repository a conversation's changes are read from, for a span that looks one branch up itself. */
export const useChangesRepository = () => useContext(ChangesContext)?.repository ?? null;
