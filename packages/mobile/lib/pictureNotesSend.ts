// What a phone send carries when notes are pinned on pictures, decided
// without react-native so it is tested in bun: the message text and the
// attachments in the order the web's composer sends them
// (components/MessageInput.tsx): the composer's own pictures first, each
// pinned one replaced by its marked copy, then the pictures quoted from the
// transcript, each as its marked copy. Every [Image N] the text names then
// points at the attachment the agent receives as image N.
import { attachReviewToMessage, composerMarkers, quotedImages, type ComposerPicture } from '@codecast/web/lib/reviewActions';
import { MAX_EDGE } from '@codecast/web/lib/compressImage';
import type { ImageMarker } from '@codecast/web/lib/markerGeometry';

export type SendPicture = {
  /** What the bubble paints, and what the marker drawing reads. */
  src: string;
  /** The stored original; absent while a composer picture still uploads. */
  storageId?: string;
  mime: string;
  width?: number;
  height?: number;
  /** Notes drawn on this picture; none sends the original as it is. */
  markers?: ImageMarker[];
};

export type ComposerPictureIn = { uri: string; mime: string; width?: number; height?: number; storageId?: string };

/**
 * The text and attachments of a send, taking the pending batch (which this
 * clears, as attachReviewToMessage does). The quoted pictures and the
 * composer's markers are read before the take, which empties the batch.
 */
export function composePictureSend(conversationId: string, typed: string, composer: readonly ComposerPictureIn[]): { content: string; pictures: SendPicture[] } {
  const held: ComposerPicture[] = composer.map((img) => ({ previewUrl: img.uri, storageId: img.storageId }));
  const quoted = quotedImages(conversationId, held);
  const marked = composerMarkers(conversationId, held);
  const content = attachReviewToMessage(conversationId, typed, { composer: held, firstQuoted: quoted.length ? held.length + 1 : undefined });
  const pictures: SendPicture[] = [
    ...composer.map((img, i): SendPicture => ({
      src: img.uri, storageId: img.storageId, mime: img.mime, width: img.width, height: img.height,
      ...(marked.has(i) ? { markers: marked.get(i) } : {}),
    })),
    ...quoted.map((q): SendPicture => ({ src: q.src, storageId: q.storageId, mime: 'image/png', markers: q.markers })),
  ];
  return { content, pictures };
}

/** The picture's size once capped on its long side the way the web's
 *  drawFitted caps it (lib/compressImage MAX_EDGE). */
export function fittedSize(w: number, h: number): { w: number; h: number } {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/**
 * How to lay out the offscreen SVG and what to ask its snapshot for, so the
 * PNG comes out `w` x `h` pixels. iOS draws the view's own bounds into an
 * image at the screen's scale, so the view is laid out at w/ratio points and
 * asked for that size. Android draws into a bitmap of exactly the size asked,
 * mapping the viewBox onto it, so it is asked for w x h pixels.
 */
export function snapshotPlan(os: string, w: number, h: number, pixelRatio: number): { layout: { width: number; height: number }; options: { width: number; height: number } } {
  // Whole points: iOS sizes its image renderer in whole units.
  const layout = { width: Math.round(w / pixelRatio), height: Math.round(h / pixelRatio) };
  return { layout, options: os === 'ios' ? layout : { width: w, height: h } };
}

/** The snapshot's base64 as bytes: iOS wraps it in line feeds. */
export function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
