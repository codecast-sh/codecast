import { useRef, useCallback } from "react";
import { toast } from "sonner";
import { useFileDragTarget } from "./useFileDragTarget";
import { isRecordingFile } from "./useScreenRecordingAttach";

/** Image drops on a conversation or a room thread: the composer registers
 *  where the images go through `dropFilesRef`. A session's composer also
 *  takes a screen recording (`recordings`; hooks/useScreenRecordingAttach). */
export function useConversationFileDrop(opts: { recordings?: boolean } = {}) {
  const dropFilesRef = useRef<((files: File[]) => void) | null>(null);
  const recordings = !!opts.recordings;
  const onFiles = useCallback((dropped: File[]) => {
    const files = dropped.filter(f => f.type.startsWith("image/") || (recordings && isRecordingFile(f)));
    if (files.length > 0 && dropFilesRef.current) {
      dropFilesRef.current(files);
    } else if (files.length === 0 && dropped.length > 0) {
      toast.error(recordings ? "Only images and screen recordings (MP4, MOV) can be attached" : "Only image files are supported");
    }
  }, [recordings]);
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
