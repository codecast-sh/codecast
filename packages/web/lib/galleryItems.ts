// What the session gallery (components/ImageGallery) shows: the session's
// images and the pages it published, in the order they appeared.

// One image the lightbox can show. `src` is whatever paints (may be a blob: or
// data: URL from the byte cache); `href` is the shareable address of the same
// bytes (the storage URL or the remote markdown URL) — absent when there is
// none, e.g. an inline base64 image. `messageId` is the transcript message the
// image came from, when the registrar knows it. `storageId` names the stored
// bytes (so a quote can attach the picture itself) and `timestamp` when it
// landed, both when known.
export type GalleryImage = { src: string; href?: string; messageId?: string; storageId?: string; timestamp?: number };

// A published page the session produced, by slug, placed by when it was first
// published. The lightbox shows the live page, not a picture of it.
export type GalleryPage = { page: string; timestamp?: number };

export type GalleryItem = GalleryImage | GalleryPage;

export function isGalleryPage(item: GalleryItem): item is GalleryPage {
  return "page" in item;
}

/** A key unique across both kinds: an image's src, a page's slug. */
export function galleryItemKey(item: GalleryItem): string {
  return isGalleryPage(item) ? `page:${item.page}` : item.src;
}

/** Images in transcript order with pages (oldest first) slotted in by time:
 *  each page lands before the first image that came after it. An image with
 *  no timestamp keeps its place and moves no page. */
export function interleaveGalleryPages(images: GalleryImage[], pages: GalleryPage[]): GalleryItem[] {
  if (pages.length === 0) return images;
  const out: GalleryItem[] = [];
  let p = 0;
  for (const image of images) {
    if (image.timestamp != null) {
      while (p < pages.length && (pages[p].timestamp ?? Infinity) < image.timestamp) out.push(pages[p++]);
    }
    out.push(image);
  }
  while (p < pages.length) out.push(pages[p++]);
  return out;
}
