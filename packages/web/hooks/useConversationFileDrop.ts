import { dragCarriesPane } from "../lib/stage";
import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";

export function useConversationFileDrop() {
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);

  // These handlers exist for IMAGE drops. A pane-shaped drag (a session card,
  // a tab, a pane strip — lib/stage) must fall through untouched so it can
  // bubble to the stage's drop layer and offer a split; swallowing every drag
  // here is what made dropping a session onto a conversation a dead gesture.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (dragCarriesPane(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/"));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && e.dataTransfer.files.length > 0) {
      toast.error("Only image files are supported");
    }
  }, []);

  return { dropFilesRef, isDragging, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
