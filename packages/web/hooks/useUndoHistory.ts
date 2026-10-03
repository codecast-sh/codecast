import { useNowWhen } from "./useCoarseNow";
import { getUndoKeyboardWindowMs, useUndoHistory as useEngineUndoHistory, type UndoHistorySnapshot } from "../store/undoStack";
import { undoTimelineNowSig } from "../lib/undoHistory";

/**
 * The window's undo history plus the clock the timeline renders from. The
 * clock re-renders only when the minute turns or a done row crosses an expiry
 * step (the last minute counts down in 10s steps), never on a per-second tick.
 */
export function useUndoHistory(): { snapshot: UndoHistorySnapshot; now: number; windowMs: number } {
  const snapshot = useEngineUndoHistory();
  const windowMs = getUndoKeyboardWindowMs();
  const now = useNowWhen(undoTimelineNowSig(snapshot, windowMs), 1000);
  return { snapshot, now, windowMs };
}
