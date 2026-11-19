import type { MutableRefObject } from "react";
import { ImagePlus, Paperclip } from "lucide-react";
import "./chat.css";

// The attach picker in a framed composer's foot row. Picked files go through the
// same drop handler MessageInput fills, so they land in its attachment strip and
// upload pipeline exactly like a paste or a drop. `anyFile` (a session's
// composer) takes any file; otherwise it picks images.
export function ComposerAttachButton({ dropRef, className = "ch-composer-attach", anyFile = false }: { dropRef: MutableRefObject<((files: File[]) => void) | null>; className?: string; anyFile?: boolean }) {
  const label = anyFile ? "Attach files" : "Attach an image";
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      onClick={() => pickFiles(anyFile ? undefined : "image/*", (files) => dropRef.current?.(files))}
    >
      {anyFile ? <Paperclip className="w-3.5 h-3.5" /> : <ImagePlus className="w-3.5 h-3.5" />}
    </button>
  );
}

// The file input exists only while the picker is open. Kept mounted, it went
// in and out of the page with every conversation switch (the composer remounts
// per session), and the browser rewrote its attributes each time.
function pickFiles(accept: string | undefined, onPick: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  if (accept) input.accept = accept;
  input.onchange = () => {
    const files = Array.from(input.files ?? []);
    if (files.length) onPick(files);
  };
  input.click();
}
