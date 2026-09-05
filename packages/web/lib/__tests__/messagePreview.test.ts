import { describe, expect, test } from "bun:test";
import { messagePreview } from "../messagePreview";
import { buildNavigatorRows } from "../messageNavigator";
import { filterUserMessages } from "../../../convex/convex/userMessagesFilter";

const image = { media_type: "image/png", storage_id: "stored-image" };
const trusted = (src: string) => src.startsWith("/images/");

describe("prompt image previews", () => {
  test("carries stored attachments from the server through navigator rows without image bytes or tool results", () => {
    const rows = buildNavigatorRows(filterUserMessages([{
      _id: "prompt", role: "user", timestamp: 1,
      content: "[Image 1] Fix this",
      images: [{ ...image, data: "large-base64-payload" }, { ...image, storage_id: "tool", tool_use_id: "tool-call" }],
    }]));
    expect(rows[0].images).toEqual([image]);
    expect(messagePreview(rows[0].display, rows[0].images, trusted)).toEqual({
      text: "Fix this", images: [{ key: "stored-image", storage_id: "stored-image", timestamp: undefined, seq: 0 }],
    });
  });

  test("retains image-only prompts while excluding blank and tool-only messages", () => {
    const base = { _id: "prompt", role: "user" as const, timestamp: 1, content: "" };
    const rows = buildNavigatorRows(filterUserMessages([{ ...base, images: [image] }]));
    expect(rows).toHaveLength(1);
    expect(rows[0].images).toEqual([image]);
    expect(filterUserMessages([base, { ...base, images: [{ ...image, tool_use_id: "call" }] }])).toEqual([]);
  });

  test("replaces leading placeholders but keeps references in the user's sentence", () => {
    expect(messagePreview("[Image 1] [Image #2] Compare [Image 2] with the first. [Image /tmp/shot.png]", [image], trusted).text)
      .toBe("Compare [Image 2] with the first.");
    expect(messagePreview("[Image 1] Fix this", [], trusted).text).toBe("[Image 1] Fix this");
  });

  test("previews trusted markdown images and leaves third-party images gated", () => {
    const preview = messagePreview("See ![Example](/images/shot.png) ![Remote](https://third-party.test/pixel)", [], trusted);
    expect(preview.images.map(entry => entry.src)).toEqual(["/images/shot.png"]);
    expect(preview.text).toBe("See Example ![Remote](https://third-party.test/pixel)");
  });

  test("supports local pending attachments and excludes tool screenshots", () => {
    const preview = messagePreview("[Image 1] Upload", [
      { media_type: "image/png", preview_url: "/images/pending.png" },
      { ...image, tool_use_id: "call" },
    ], trusted);
    expect(preview.images).toEqual([{ key: "/images/pending.png", src: "/images/pending.png" }]);
  });
});
