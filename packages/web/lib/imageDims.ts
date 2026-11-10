// What size a transcript image is, for the Modern style's natural-aspect image
// (components/conversation/blocks/ModernImage.tsx). Classic crops every image to
// a 100px strip so a row's height never changes when its image loads; Modern
// shows the whole picture, so it reserves the picture's box before the bytes
// arrive whenever the size is known: from the message (ImageData width and
// height, when the sender recorded them) or from an earlier decode of the same
// src in this tab. Only an image of unknown size starts as the 100px box, and
// grows once, when it decodes; the virtualizer measures that like any resize.

export type ImageDims = { width: number; height: number };

/** The tallest an image is drawn, in rem (28rem = 448px at the root size). */
export const IMAGE_MAX_REM = 28;

const DECODED = new Map<string, ImageDims>();
const DECODED_MAX = 2000;

function valid(d: Partial<ImageDims> | null | undefined): d is ImageDims {
  return !!d && typeof d.width === "number" && typeof d.height === "number" && d.width > 0 && d.height > 0;
}

/** The size this image is known to have, or null while nobody knows it yet. */
export function knownImageDims(image: { width?: number; height?: number }, src: string | undefined): ImageDims | null {
  if (valid(image)) return { width: image.width, height: image.height };
  const seen = src ? DECODED.get(src) : undefined;
  return seen ?? null;
}

/** Remember a decoded size, so the next mount of this src reserves its box. */
export function rememberImageDims(src: string, dims: ImageDims): void {
  if (!valid(dims)) return;
  if (!DECODED.has(src) && DECODED.size >= DECODED_MAX) {
    const oldest = DECODED.keys().next().value;
    if (oldest !== undefined) DECODED.delete(oldest);
  }
  DECODED.set(src, { width: dims.width, height: dims.height });
}

/**
 * The box an image of this size takes: its own aspect ratio, never wider than
 * the column or its natural width, never taller than IMAGE_MAX_REM.
 */
export function imageBoxStyle(dims: ImageDims): { width: string; aspectRatio: string } {
  const ratio = dims.width / dims.height;
  return {
    width: `min(100%, ${dims.width}px, ${(IMAGE_MAX_REM * ratio).toFixed(4)}rem)`,
    aspectRatio: `${dims.width} / ${dims.height}`,
  };
}
