import { useCallback, useState } from "react";
import { useWatchEffect } from "./useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { decisionDraftKey } from "../lib/decisionQueue";
import { flushDraftWrite, hasPendingDraftWrite, scheduleDraftWrite } from "../lib/pendingDraftWrites";

// A decision's answer in progress, kept in the store's persisted `drafts`
// (decisionDraftKey) rather than component state: the card folds, the page
// changes and the window reloads, and the reader's ticks are still there,
// on every surface that answers the same decision. answerDecision clears it.
// A patch may be a function of the current draft, read fresh from the store,
// so two keys pressed before a re-render both land. Typed text still in the
// box lands first (useDecisionDraftText), so a patch never overwrites it.
export function useDecisionDraft<T extends Record<string, any>>(
  decisionId: string,
): [Partial<T>, (patch: Partial<T> | ((cur: Partial<T>) => Partial<T>)) => void] {
  const key = decisionDraftKey(decisionId);
  const draft = useInboxStore((s) => s.drafts[key]) as Partial<T> | undefined;
  const patch = useCallback((fields: Partial<T> | ((cur: Partial<T>) => Partial<T>)) => {
    flushDraftWrite(key);
    const s = useInboxStore.getState();
    const cur = (s.drafts[key] ?? {}) as Partial<T>;
    s.setDraft(key, { ...cur, ...(typeof fields === "function" ? fields(cur) : fields) });
  }, [key]);
  return [draft ?? EMPTY, patch];
}

// One typed field of a decision's draft. A store write wakes every
// subscriber and persists to IndexedDB, so the text lives in the component
// while the person types and reaches the store on a pause, the way the
// composer's draft does (pendingDraftWrites). Unmounting (the card folds)
// and leaving the page flush it; answering cancels it (answerDecisionDraft).
// When the store's copy changes and nothing typed is waiting, the box follows
// it: another window's edit, or the draft cleared by an answer.
export function useDecisionDraftText(decisionId: string, field: string): [string, (text: string) => void] {
  const key = decisionDraftKey(decisionId);
  const stored = useInboxStore((s) => (s.drafts[key]?.[field] as string | undefined) ?? "");
  const [text, setText] = useState(stored);
  useWatchEffect(() => { if (!hasPendingDraftWrite(key)) setText(stored); }, [key, stored]);
  useWatchEffect(() => () => flushDraftWrite(key), [key]);
  const type = useCallback((next: string) => {
    setText(next);
    scheduleDraftWrite(key, () => {
      const s = useInboxStore.getState();
      s.setDraft(key, { ...(s.drafts[key] ?? {}), [field]: next });
    });
  }, [key, field]);
  return [text, type];
}

const EMPTY = Object.freeze({});
