import { test, expect, mock } from "bun:test";

// A video on a chat line plays in place; an image beside it stays a tile.

const STORAGE_URL = "https://convex.codecast.sh/api/storage/abc-123";

const real = await import("../../hooks/useStorageImageUrl");
mock.module("../../hooks/useStorageImageUrl", () => ({
  ...real,
  useStorageImageUrl: (storageId?: string | null) => (storageId ? STORAGE_URL : undefined),
  useStorageImageSrc: () => STORAGE_URL,
}));

const { renderToStaticMarkup } = await import("react-dom/server");
const { ChatAttachments } = await import("./ChatMessage");

test("a video attachment renders a player, never an image tile", () => {
  const html = renderToStaticMarkup(
    <ChatAttachments
      messageId="m1"
      attachments={[
        { storage_id: "st_video", name: "IMG_3071.MOV", mime: "video/mp4" },
        { storage_id: "st_image", name: "shot.png", mime: "image/png" },
      ]}
    />,
  );
  expect(html).toMatch(new RegExp(`<video[^>]*class="ch-att ch-att-video"[^>]*src="${STORAGE_URL}"[^>]*controls`));
  expect(html.match(/<img /g)).toHaveLength(1);
  expect(html).not.toContain('alt="IMG_3071.MOV"');
});
