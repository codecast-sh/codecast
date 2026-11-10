import { useState } from "react";
import { pressable } from "../../ops/parts";
import { imageBoxStyle, knownImageDims, rememberImageDims, type ImageDims } from "../../../lib/imageDims";
import type { ImageData } from "../types";

// The Modern style's transcript image (CONV-18): the whole picture at its own
// aspect ratio, capped at 28rem tall, where Classic shows a 100px strip. Its
// box is reserved before the bytes arrive whenever the size is known
// (lib/imageDims), so a row does not jump when its image loads; only an image
// of unknown size starts as the 100px box and grows once, on decode. ImageBlock
// (interactiveBlocks) owns the source, the gallery and the loaded/failed state,
// and draws this in Modern.

/** The placeholder height while an image of unknown size loads (Classic's strip). */
const UNKNOWN_HEIGHT = 100;

export function ModernImage({
  image,
  src,
  loaded,
  onLoad,
  onError,
  onOpen,
}: {
  image: ImageData;
  src: string | undefined;
  loaded: boolean;
  onLoad: () => void;
  onError: () => void;
  onOpen: () => void;
}) {
  // A size learned from this mount's own decode; the message's or an earlier
  // decode's is read fresh, since the src can resolve after the first render.
  const [decoded, setDecoded] = useState<ImageDims | null>(null);
  const dims = decoded ?? knownImageDims(image, src);
  return (
    <div
      data-cc-image={dims ? "sized" : "unknown"}
      className="relative my-2 max-w-full cursor-pointer overflow-hidden rounded-[10px] border border-sol-border bg-sol-bg-alt transition-colors hover:border-sol-cyan/50"
      style={dims ? imageBoxStyle(dims) : { height: UNKNOWN_HEIGHT }}
      {...pressable(onOpen)}
      aria-label="Open image"
    >
      {src && (
        <img
          src={src}
          alt={image.tool_use_id ? "Image from a tool" : "Attached image"}
          className={`block h-full w-full object-contain ${loaded ? "" : "opacity-0"}`}
          onLoad={(e) => {
            const el = e.currentTarget;
            if (el.naturalWidth > 0 && el.naturalHeight > 0) {
              const next = { width: el.naturalWidth, height: el.naturalHeight };
              rememberImageDims(src, next);
              if (!dims || dims.width !== next.width || dims.height !== next.height) setDecoded(next);
            }
            onLoad();
          }}
          onError={onError}
        />
      )}
      {(!src || !loaded) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-meta text-sol-text-dim">Loading image…</span>
        </div>
      )}
      {image.uploading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <svg className="h-6 w-6 animate-spin text-white" fill="none" viewBox="0 0 24 24" aria-hidden>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}
    </div>
  );
}
