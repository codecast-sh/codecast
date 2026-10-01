import { useCallback, useRef, useState } from "react";
import { dragCarriesPane } from "../lib/stage";

/**
 * A drop target for files dragged in from outside the app. A pane-shaped drag
 * (a session card, a tab, a pane strip: lib/stage) falls through untouched, so
 * it can bubble to the stage's drop layer or to a label section behind the
 * target; swallowing every drag is what once made dropping a session onto a
 * conversation a dead gesture. `isOver` holds while files hover anywhere
 * inside the target, counted across the enter and leave of its children.
 */
export function useFileDragTarget(onFiles: (files: File[]) => void) {
  const [isOver, setIsOver] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current++;
    if (e.dataTransfer.types.includes("Files")) setIsOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current--;
    if (depth.current === 0) setIsOver(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    depth.current = 0;
    setIsOver(false);
    onFiles(Array.from(e.dataTransfer.files));
  }, [onFiles]);

  return { isOver, handlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
