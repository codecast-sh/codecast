import { useState } from "react";

export type FileDrop = ReturnType<typeof useFileDrop>;

/** A field that takes a dropped file: the handlers to spread on it, and whether a file is over it now. Anything else dropped behaves as usual. */
export function useFileDrop(onFile: (file: File) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    props: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (!f) return;
        e.preventDefault();
        onFile(f);
      },
    },
  };
}
