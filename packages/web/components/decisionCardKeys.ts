// The decision card's keys: digits answer, arrows step the queue, Escape and
// the sheet keys fold and leave. Split out of SessionDecisionCard.tsx; the
// routing itself is routeQueueKey's (lib/decisionQueue).
import type { RefObject } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { routeQueueKey } from "../lib/decisionQueue";
import { hasOpenModal } from "../shortcuts";
import { keyScopeHasFocus, keysOwnedElsewhere } from "../shortcuts/keyOwnership";

export type DecisionCardKeys = {
  options: { index: number }[];
  answer: (index: number) => void;
  answerFreeText: (text: string) => void;
  otherText: string;
  openSession: () => void;
  onSkip?: () => void;
  onPrev?: () => void;
  dismiss: () => void;
  onExit?: () => void;
  full: boolean;
  stepper?: { total?: number } | null;
  blocking?: boolean;
  isPermissionCard: boolean;
  isInfraDialog: boolean;
  richControls: boolean;
  shrink: () => void;
  grow: () => void;
  hosted: boolean;
  passOpen: boolean;
  canPass: boolean;
  threadAsks?: readonly unknown[] | null;
  setOtherOpen: (open: boolean) => void;
  setPassOpen: (open: boolean) => void;
  otherRef: RefObject<HTMLTextAreaElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
};

export function useDecisionCardKeys(k: DecisionCardKeys): void {
  const { options, answer, answerFreeText, otherText, openSession, onSkip, onPrev, dismiss, onExit, full, stepper, blocking, isPermissionCard, isInfraDialog, richControls, shrink, grow, hosted, passOpen, canPass, threadAsks, setOtherOpen, setPassOpen, otherRef, rootRef } = k;
  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The pass menu owns the keys while it is open: its search and Escape.
      if (passOpen) return;
      const target = e.target as HTMLElement | null;
      const action = routeQueueKey(e, {
        modalOpen: hasOpenModal(),
        ownedElsewhere: keysOwnedElsewhere(target, rootRef.current),
        editing: !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable),
        inOwnFreeTextBox: !!target && target === otherRef.current,
        isPermissionCard,
        // An infra dialog's options commit money — no digit may reach them;
        // a multi, rank or form takes its own digits in its controls.
        optionCount: isInfraDialog || richControls ? 0 : options.length,
        sheet: full ? "full" : "peek",
      });
      if (!action) return;
      // Outside the queue, a folded card must not claim the thread's keys:
      // j/k/digits belong to the conversation until the card owns the pane.
      // Only a blocking ask comes back on a key: an advisory one never
      // interrupts, and raising it on the thread's own j would put its
      // answers one digit away from a reader who never opened it.
      // Stepping is the queue's: with nothing to step to, the arrows stay the page's.
      // Back also reaches the decisions answered in this visit, so it lives while the stepper offers it.
      if (action.kind === "skip" && !((stepper?.total ?? 0) > 1) && !(threadAsks && !stepper)) return;
      if (action.kind === "prev" && !onPrev) return;
      if (!stepper && !full && action.kind !== "commit-free-text" && action.kind !== "close-free-text") {
        if (action.kind !== "full" || !blocking) return;
      }
      // An answer, a dismissal or a typed answer is the card's only while it
      // is the thing in focus: a digit typed into anything else in this
      // window (another pane, a tab an agent drives) never answers it.
      if ((action.kind === "answer" || action.kind === "dismiss" || action.kind === "pass" || action.kind === "open-free-text") && !keyScopeHasFocus(rootRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      switch (action.kind) {
        case "commit-free-text": answerFreeText(otherText); break;
        case "close-free-text": setOtherOpen(false); break;
        case "answer": { const opt = options[action.option]; if (opt) answer(opt.index); break; }
        case "open-session": if (stepper) openSession(); break;
        case "skip": onSkip?.(); break;
        case "prev": onPrev?.(); break;
        case "dismiss": if (!hosted) dismiss(); break;
        case "pass": if (canPass) setPassOpen(true); break;
        case "open-free-text": if (!isPermissionCard && !isInfraDialog && !richControls) { setOtherOpen(true); setTimeout(() => otherRef.current?.focus(), 0); } break;
        case "peek": shrink(); break;
        case "full": grow(); break;
        case "restore-question": grow(); break;
        // Escape from the full card: leave the queue, or — in a plain session
        // view — hand the pane back to the thread.
        case "exit-queue": if (onExit) onExit(); else shrink(); break;
      }
    };
    // CAPTURE phase: the global shortcut layer claims arrows and digits for
    // list navigation and would eat them first.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [options, answer, answerFreeText, otherText, openSession, onSkip, onPrev, dismiss, onExit, full, stepper, isPermissionCard, isInfraDialog, richControls, shrink, grow, hosted, passOpen, canPass, threadAsks, blocking]);
}
