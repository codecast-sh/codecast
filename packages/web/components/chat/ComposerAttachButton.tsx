import { useRef, type MutableRefObject } from "react";
import { ImagePlus, Paperclip } from "lucide-react";
import "./chat.css";

// The attach picker in a framed composer's foot row. Picked files go through the
// same drop handler MessageInput fills, so they land in its attachment strip and
// upload pipeline exactly like a paste or a drop. `anyFile` (a session's
// composer) takes any file; otherwise it picks images.
export function ComposerAttachButton({ dropRef, className = "ch-composer-attach", anyFile = false }: { dropRef: MutableRefObject<((files: File[]) => void) | null>; className?: string; anyFile?: boolean }) {
  const label = anyFile ? "Attach files" : "Attach an image";
  const pickerRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        title={label}
        aria-label={label}
        onClick={() => pickerRef.current?.click()}
      >
        {anyFile ? <Paperclip className="w-3.5 h-3.5" /> : <ImagePlus className="w-3.5 h-3.5" />}
      </button>
      <input
        ref={pickerRef}
        type="file"
        accept={anyFile ? undefined : "image/*"}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) dropRef.current?.(files);
          e.target.value = "";
        }}
      />
    </>
  );
}
