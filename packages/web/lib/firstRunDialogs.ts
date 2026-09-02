import { useCallback, useEffect, useSyncExternalStore } from "react";

// One first-run dialog at a time.
//
// Several surfaces introduce themselves the first time the dashboard opens:
// the device-setup dialog (permissions, once per machine) and the inbox tour
// (once per account). Each decides to open on its own clock — a permission
// read, a beat after the page paints — and with no knowledge of the other,
// two of them can land on the same first visit stacked, the tour's modal over
// the setup card. This is the registry that stops that: an open first-run
// dialog holds the turn, and every other first-run auto-open waits until the
// turn is free. Whichever is ready first goes first; the next follows once
// the first is closed. A dialog the user opened on purpose (a replay from the
// bar, "set up this browser" from settings) still holds the turn while open,
// so an unprompted dialog never lands over a chosen one either.
//
// Two parts, because two dialogs can decide in the same render pass: `claim`
// takes the turn synchronously at the moment of decision, so the second
// effect in that pass already sees it taken; `blocked` is the reactive view,
// so the waiting dialog's auto-open effect re-runs the moment the holder
// closes and the hand-off needs no polling.

const holders = new Set<string>();
const listeners = new Set<() => void>();
// Snapshot key: useSyncExternalStore compares snapshots by identity, so the
// hook reads one string that changes exactly when the holder set does.
let snapshot = "";

function emit(): void {
  snapshot = Array.from(holders).sort().join("\n");
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => "";

/**
 * Register a first-run dialog. It holds the turn while `open`; `blocked` says
 * another one holds it; `claim()` takes the turn now, or refuses. An
 * auto-open effect depends on `blocked` and opens only when `claim()` agrees.
 * A deliberate open by the user needs neither: it just opens, and holds.
 */
export function useFirstRunDialog(id: string, open: boolean): { blocked: boolean; claim: () => boolean } {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(() => {
    if (open) {
      if (!holders.has(id)) {
        holders.add(id);
        emit();
      }
    } else if (holders.delete(id)) {
      emit();
    }
  }, [id, open]);
  useEffect(
    () => () => {
      if (holders.delete(id)) emit();
    },
    [id],
  );
  const claim = useCallback(() => {
    for (const h of holders) if (h !== id) return false;
    if (!holders.has(id)) {
      holders.add(id);
      emit();
    }
    return true;
  }, [id]);
  const blocked = snap.split("\n").some((h) => h !== "" && h !== id);
  return { blocked, claim };
}

/** Test hook: forget every holder. */
export function resetFirstRunDialogsForTests(): void {
  holders.clear();
  emit();
}
