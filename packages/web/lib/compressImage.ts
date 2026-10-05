// Shrink large pasted/dropped images in the browser BEFORE they go on the wire.
//
// Why this exists: uploads go straight from the client to the (single, often
// busy) self-hosted Convex backend, which writes the bytes to its own local
// disk — there is no object store or CDN in front of it. The median paste is
// ~100KB and already fast, but the tail (multi-MB retina screenshots) is what
// makes uploads "hang". Re-encoding those to WebP turns a 3-4MB PNG into a few
// hundred KB, cutting both the transfer and the disk write.
//
// Contract: this helper is best-effort and SAFE. It never throws and never
// returns something larger than the input — on any failure, or if the
// re-encode doesn't actually win, it hands back the original File untouched.
// Callers can `await compressImage(file)` unconditionally.

// Below this size, compressing isn't worth the decode/encode round-trip — most
// pastes land here and skip the work entirely (zero overhead on the common path).
const COMPRESS_THRESHOLD_BYTES = 256 * 1024;

// Longest-edge cap. 2560px keeps full-resolution screenshots crisp (even on a
// retina display) while bounding the pixel count we have to encode.
const MAX_EDGE = 2560;

// WebP keeps transparency (clipboard PNGs are often opaque, but some aren't) and
// compresses far better than PNG/JPEG at a visually-lossless quality.
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;

// Formats we leave alone: GIF (canvas would flatten the animation), SVG (vector;
// re-rastering would bloat and blur it).
const SKIP_TYPES = new Set(["image/gif", "image/svg+xml"]);

function shouldAttempt(file: File): boolean {
  if (!file.type.startsWith("image/")) return false;
  if (SKIP_TYPES.has(file.type)) return false;
  if (file.size <= COMPRESS_THRESHOLD_BYTES) return false;
  return true;
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  // createImageBitmap is fast and honors EXIF orientation (phone photos);
  // fall back to an <img> for browsers/types it rejects.
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("image decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dims(source: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  const w = (source as ImageBitmap).width ?? (source as HTMLImageElement).naturalWidth;
  const h = (source as ImageBitmap).height ?? (source as HTMLImageElement).naturalHeight;
  return { w, h };
}

async function encode(canvas: HTMLCanvasElement | OffscreenCanvas, type: string, quality: number): Promise<Blob | null> {
  if (typeof (canvas as OffscreenCanvas).convertToBlob === "function") {
    try {
      return await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
    } catch {
      return null;
    }
  }
  return await new Promise<Blob | null>((resolve) =>
    (canvas as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality)
  );
}

// Decode an image and draw it onto a canvas no larger than MAX_EDGE on its
// longest side. Null when the bytes have no size or no 2D context exists.
export async function drawFitted(blob: Blob): Promise<{ canvas: HTMLCanvasElement | OffscreenCanvas; ctx: CanvasRenderingContext2D; w: number; h: number } | null> {
  const source = await decode(blob);
  const { w: srcW, h: srcH } = dims(source);
  if (!srcW || !srcH) return null;
  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const canvas: HTMLCanvasElement | OffscreenCanvas = typeof OffscreenCanvas === "function"
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const ctx = (canvas as HTMLCanvasElement).getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(source as CanvasImageSource, 0, 0, w, h);
  if ("close" in source && typeof source.close === "function") source.close();
  return { canvas, ctx, w, h };
}

// The canvas as WebP, or JPEG where the platform won't produce WebP.
export async function encodeCompact(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<Blob | null> {
  const webp = await encode(canvas, "image/webp", WEBP_QUALITY);
  if (webp && webp.type === "image/webp") return webp;
  return (await encode(canvas, "image/jpeg", JPEG_QUALITY)) ?? webp;
}

export async function compressImage(file: File): Promise<File> {
  if (!shouldAttempt(file)) return file;

  try {
    const drawn = await drawFitted(file);
    if (!drawn) return file;
    const blob = await encodeCompact(drawn.canvas);

    // Only adopt the result if it's genuinely smaller. Already-optimized inputs
    // (a tight JPEG, a small PNG) can re-encode larger — keep the original then.
    if (!blob || blob.size >= file.size) return file;

    const outType = blob.type;
    const ext = outType === "image/webp" ? "webp" : "jpg";
    const baseName = file.name?.replace(/\.[^./\\]+$/, "") || "image";
    return new File([blob], `${baseName}.${ext}`, { type: outType, lastModified: file.lastModified });
  } catch {
    // Best-effort: any failure (decode, canvas, encode, OOM) keeps the original.
    return file;
  }
}
