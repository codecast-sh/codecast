// What folded frames hold is off the canvas (pl-1145): not drawn, hit,
// marqueed, fitted or overviewed, and never in a selection, the viewer's or
// anyone else's. BoardView reads the board through this.
import { useMemo, useRef } from "react";
import type { ArtifactPresence } from "@codecast/shared/artifacts";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { boardFolds } from "./boardFolds";
import type { RemoteSelection } from "./BoardOverlay";
import type { BoardEl } from "./boardTypes";

export function useBoardFolds(
  elements: BoardEl[],
  byKey: Map<string, BoardEl>,
  selectionIn: string[],
  setSelection: (keys: string[]) => void,
  others: ArtifactPresence[],
) {
  const folds = useMemo(() => boardFolds(elements, byKey), [elements, byKey]);
  // Gestures and commands read the folds as they are when they run.
  const foldsRef = useRef(folds);
  foldsRef.current = folds;
  // The selection never holds what a fold hides: nothing folded away is moved, deleted or edited through a stale pick.
  const selection = useMemo(() => (folds.hidden.size ? selectionIn.filter((k) => !folds.hidden.has(k)) : selectionIn), [selectionIn, folds]);
  useWatchEffect(() => {
    if (selection.length !== selectionIn.length) setSelection(selection);
  }, [selection, selectionIn]);
  // Someone else's pick of something folded away draws nothing.
  const remote = useMemo<RemoteSelection[]>(() => others
    .map((p) => ({ p, keys: (p.selection ?? []).filter((k) => !folds.hidden.has(k)) }))
    .filter(({ keys }) => keys.length)
    .map(({ p, keys }) => ({ actor: p.actor, name: p.kind === "agent" ? `✳ ${p.name}` : p.name, color: p.color, keys, agent: p.kind === "agent" })), [others, folds]);
  return { folds, foldsRef, shown: folds.shown, selection, remote };
}
