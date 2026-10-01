import { useRef, useCallback } from "react";
import { toast } from "sonner";
import { useFileDragTarget } from "./useFileDragTarget";

/** Image drops on a conversation or a room thread: the composer registers
 *  where the images go through `dropFilesRef`. */
export function useConversationFileDrop() {
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const onFiles = useCallback((dropped: File[]) => {
    const files = dropped.filter(f => f.type.startsWith("image/"));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && dropped.length > 0) {
      toast.error("Only image files are supported");
    }
  }, []);
  const { isOver, handlers } = useFileDragTarget(onFiles);
  return {
    dropFilesRef,
    isDragging: isOver,
    handleDragEnter: handlers.onDragEnter,
    handleDragOver: handlers.onDragOver,
    handleDragLeave: handlers.onDragLeave,
    handleDrop: handlers.onDrop,
  };
}
