// Notes pinned to points of pictures in the phone's gallery
// (components/ImageGallery): which pins sit on which picture, where a tap
// lands on a contain-fitted, zoomed picture, and how another surface (the
// notes tray) opens a picture at one of its notes. No React Native here, so
// bun tests it directly.

import { pinNumbers, type PendingComment } from '@codecast/web/lib/quoteFormat';

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
/** A picture as a pin names it: the address it was pinned at, and its stored bytes when known. */
export type PictureRef = { src: string; storageId?: string };

// The picture's size drawn `contain` inside the page. Until the picture's own
// size is known it is taken to fill the page.
export function fitted(natural: Size | null, page: Size): Size {
  if (!natural || !natural.width || !natural.height) return page;
  const r = Math.min(page.width / natural.width, page.height / natural.height);
  return { width: natural.width * r, height: natural.height * r };
}

/** The fitted picture's box in the page, centred as `contain` draws it. */
export function fittedRect(natural: Size, page: Size): Size & { left: number; top: number } {
  const fit = fitted(natural, page);
  return { ...fit, left: (page.width - fit.width) / 2, top: (page.height - fit.height) / 2 };
}

// Same picture: the same stored bytes, or the same address. The rule
// composerPictureIndex (web lib/reviewActions) matches composer pictures by,
// so the gallery, the tray and the send agree on which notes a picture holds.
export function samePicture(a: PictureRef, b: PictureRef): boolean {
  return (!!a.storageId && a.storageId === b.storageId) || (!!a.src && a.src === b.src);
}

/** One pin as the gallery draws it; `number` is pinNumbers', so it matches the web and the sent markers. */
export type GalleryPin = { id: string; number: number; src: string; storageId?: string; point: Point; body: string };

// The batch's pins in one gallery: the transcript's pictures, or (`attached`)
// the composer's own, which a send names by [Image N].
export function galleryPins(comments: readonly PendingComment[] | undefined, attached: boolean): GalleryPin[] {
  if (!comments?.length) return [];
  const numbers = pinNumbers(comments);
  return comments.flatMap((c) => {
    const image = c.image;
    if (!image?.point || !!image.attached !== attached) return [];
    return [{ id: c.id, number: numbers.get(c.id) ?? 0, src: image.src, storageId: image.storageId, point: image.point, body: c.body }];
  });
}

export function pinsOn(pins: readonly GalleryPin[], picture: PictureRef): GalleryPin[] {
  return pins.filter((p) => samePicture(p, picture));
}

// A tap while this picture's open pin still has no note moves that pin: the
// first tap missed, it was not a second remark (web pinWhereClicked).
export function pinToMove(comments: readonly PendingComment[] | undefined, editingId: string | null, picture: PictureRef): string | null {
  if (!editingId) return null;
  const c = comments?.find((c) => c.id === editingId);
  return c?.image?.point && !c.body.trim() && samePicture(c.image, picture) ? c.id : null;
}

/** A page's zoom: scale about the page centre, then translate (ImageGallery's transform). */
export type PageView = { scale: number; tx: number; ty: number };

export const PIN_HIT_RADIUS = 22; // a 44px target, constant on screen like the badge

function toScreen(p: Point, page: Size, view: PageView): Point {
  return {
    x: (p.x - page.width / 2) * view.scale + page.width / 2 + view.tx,
    y: (p.y - page.height / 2) * view.scale + page.height / 2 + view.ty,
  };
}

function toPage(p: Point, page: Size, view: PageView): Point {
  return {
    x: (p.x - page.width / 2 - view.tx) / view.scale + page.width / 2,
    y: (p.y - page.height / 2 - view.ty) / view.scale + page.height / 2,
  };
}

/** Where a pin's point sits in the page, before the zoom. */
export function pinInPage(point: Point, natural: Size, page: Size): Point {
  const r = fittedRect(natural, page);
  return { x: r.left + point.x * r.width, y: r.top + point.y * r.height };
}

export type TapResult = { kind: 'pin'; id: string } | { kind: 'add'; point: Point } | { kind: 'chrome' };

// What a single tap on a gallery page does. A tap on a pin opens its note,
// from any zoom. An unzoomed tap on the picture pins a note there, as
// fractions of the picture; anywhere else (the letterbox, or a zoomed
// picture) shows or hides the chrome.
export function resolveTap({ tap, page, natural, view, pins, canAdd }: {
  tap: Point;
  page: Size;
  natural: Size | null;
  view: PageView;
  pins: readonly GalleryPin[];
  canAdd: boolean;
}): TapResult {
  if (!natural || !natural.width || !natural.height) return { kind: 'chrome' };
  let hit: { id: string; d: number } | null = null;
  for (const pin of pins) {
    const at = toScreen(pinInPage(pin.point, natural, page), page, view);
    const d = Math.hypot(at.x - tap.x, at.y - tap.y);
    if (d <= PIN_HIT_RADIUS && (!hit || d < hit.d)) hit = { id: pin.id, d };
  }
  if (hit) return { kind: 'pin', id: hit.id };
  if (!canAdd || view.scale > 1.01) return { kind: 'chrome' };
  const r = fittedRect(natural, page);
  const p = toPage(tap, page, view);
  const x = (p.x - r.left) / r.width;
  const y = (p.y - r.top) / r.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return { kind: 'chrome' };
  return { kind: 'add', point: { x, y } };
}

export function notesHeadline(count: number): string | null {
  return count > 0 ? `${count} ${count === 1 ? 'note' : 'notes'} on your next message` : null;
}

// ── Opening a picture at one of its notes ──────────────────────────────────
// The gallery that holds a pin's picture registers an opener for its
// conversation (the session screen for transcript pictures, the composer for
// its own). openImageNote asks each until one shows the picture with that
// pin's note open.

type Opener = (commentId: string) => boolean;
const openers = new Map<string, Set<Opener>>();

export function onImageNoteOpen(conversationId: string, opener: Opener): () => void {
  const set = openers.get(conversationId) ?? openers.set(conversationId, new Set()).get(conversationId)!;
  set.add(opener);
  return () => {
    set.delete(opener);
    if (!set.size) openers.delete(conversationId);
  };
}

/** Open the gallery holding this pin's picture, at that picture, with the pin's note editor open. False when no gallery holds it. */
export function openImageNote(conversationId: string, commentId: string): boolean {
  for (const open of openers.get(conversationId) ?? []) if (open(commentId)) return true;
  return false;
}
