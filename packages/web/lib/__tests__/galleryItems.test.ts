import { describe, expect, test } from "bun:test";
import { galleryItemKey, interleaveGalleryPages } from "../galleryItems";

describe("interleaveGalleryPages", () => {
  const img = (src: string, timestamp?: number) => ({ src, timestamp });
  const page = (slug: string, timestamp?: number) => ({ page: slug, timestamp });

  test("slots each page before the first image that came after it", () => {
    const out = interleaveGalleryPages(
      [img("a", 10), img("b", 20), img("c", 30)],
      [page("p1", 5), page("p2", 25), page("p3", 40)],
    );
    expect(out.map(galleryItemKey)).toEqual(["page:p1", "a", "b", "page:p2", "c", "page:p3"]);
  });

  test("an image without a timestamp keeps its place", () => {
    const out = interleaveGalleryPages([img("inline"), img("b", 20)], [page("p", 15)]);
    expect(out.map(galleryItemKey)).toEqual(["inline", "page:p", "b"]);
  });

  test("pages alone, and images alone, pass through", () => {
    expect(interleaveGalleryPages([], [page("p", 1)]).map(galleryItemKey)).toEqual(["page:p"]);
    const images = [img("a", 1)];
    expect(interleaveGalleryPages(images, [])).toBe(images);
  });
});
