import { useRef, type MutableRefObject } from "react";
import { ImagePlus } from "lucide-react";
import "./chat.css";

// The image picker in a framed composer's foot row. Picked files go through the
// same drop handler MessageInput fills, so they land in its thumbnail strip and
// upload pipeline exactly like a paste or a drop.
export function ComposerAttachButton({ dropRef }: { dropRef: MutableRefObject<((files: File[]) => void) | null> }) {
  const pickerRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="ch-composer-attach"
        title="Attach an image"
        aria-label="Attach an image"
        onClick={() => pickerRef.current?.click()}
      >
        <ImagePlus className="w-3.5 h-3.5" />
      </button>
      <input
        ref={pickerRef}
        type="file"
        accept="image/*"
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
