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

  test("backfills text-only navigator caches with loaded attachments without losing unloaded prompts", () => {
    const cached = [
      { _id: "older", content: "An earlier prompt", timestamp: 1 },
      { _id: "prompt", content: "[Image 1] Fix this", timestamp: 2 },
      { _id: "newer", content: "A later prompt", timestamp: 3 },
    ];
    const rows = buildNavigatorRows(cached, undefined, undefined, { prompt: [image] });
    expect(rows.map(row => [row._id, row.originalIndex])).toEqual([["older", 0], ["prompt", 1], ["newer", 2]]);
    expect(messagePreview(rows[1].display, rows[1].images, trusted).text).toBe("Fix this");
    expect(rows[1].images).toEqual([image]);
    expect(cached[1]).not.toHaveProperty("images");
  });

  test("keeps authoritative attachment metadata when the loaded window is stale", () => {
    const rows = buildNavigatorRows([
      { _id: "updated", content: "Updated image", timestamp: 1, images: [image] },
      { _id: "removed", content: "Removed image", timestamp: 2, images: [] },
    ], undefined, undefined, {
      updated: [{ ...image, storage_id: "old-image" }],
      removed: [image],
    });
    expect(rows[0].images).toEqual([image]);
    expect(rows[1].images).toBeUndefined();
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
