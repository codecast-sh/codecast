import { useCallback } from "react";
import { useInboxStore } from "../store/inboxStore";
import { decisionDraftKey } from "../lib/decisionQueue";

// A decision's answer in progress, kept in the store's persisted `drafts`
// (decisionDraftKey) rather than component state: the card folds, the page
// changes and the window reloads, and the reader's ticks are still there,
// on every surface that answers the same decision. answerDecision clears it.
// A patch may be a function of the current draft, read fresh from the store,
// so two keys pressed before a re-render both land.
export function useDecisionDraft<T extends Record<string, any>>(
  decisionId: string,
): [Partial<T>, (patch: Partial<T> | ((cur: Partial<T>) => Partial<T>)) => void] {
  const key = decisionDraftKey(decisionId);
  const draft = useInboxStore((s) => s.drafts[key]) as Partial<T> | undefined;
  const patch = useCallback((fields: Partial<T> | ((cur: Partial<T>) => Partial<T>)) => {
    const s = useInboxStore.getState();
    const cur = (s.drafts[key] ?? {}) as Partial<T>;
    s.setDraft(key, { ...cur, ...(typeof fields === "function" ? fields(cur) : fields) });
  }, [key]);
  return [draft ?? EMPTY, patch];
}

const EMPTY = Object.freeze({});
