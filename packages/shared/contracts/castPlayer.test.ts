import { expect, test } from "bun:test";
import { isVideoSrc } from "./castPlayer";

test("a video file in image markdown is told apart from an image by its extension", () => {
  expect(isVideoSrc("https://media.codecast.sh/media/abc.mp4")).toBe(true);
  expect(isVideoSrc("clip.MOV")).toBe(true);
  expect(isVideoSrc("https://x.test/a.webm?sig=1#t=3")).toBe(true);
  expect(isVideoSrc("https://convex.codecast.sh/api/storage/uuid")).toBe(false);
  expect(isVideoSrc("shot.png?name=a.mp4")).toBe(false);
  expect(isVideoSrc(undefined)).toBe(false);
});
