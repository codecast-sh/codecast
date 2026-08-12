import { describe, expect, test } from "bun:test";
import { extractSessionImages, mergeSessionImages, type SessionImageEntry } from "./sessionImages";

// The header gallery used to scan only the loaded message window (200 messages
// a page), so a long thread showed its tail and nothing else. The server now
// materializes every image at ingest and the client merges that complete list
// with its window scan. These cover the two halves of that contract.

const trustOurs = (src: string) => src.startsWith("https://ours/");

describe("extractSessionImages", () => {
  test("stamps transcript position on every channel", () => {
    const entries = extractSessionImages(
      [
        { timestamp: 100, images: [{ media_type: "image/png", storage_id: "a" }] },
        {
          timestamp: 200,
          content: "before ![x](https://ours/1.png) after",
          images: [
            { media_type: "image/png", storage_id: "b" },
            { media_type: "image/png", storage_id: "c" },
          ],
        },
      ],
      trustOurs,
    );
    expect(entries.map((e) => [e.key, e.timestamp, e.seq])).toEqual([
      ["a", 100, 0],
      ["b", 200, 0],
      ["c", 200, 1],
      ["https://ours/1.png", 200, 2],
    ]);
  });

  test("drops untrusted markdown images and dedupes across channels", () => {
    const entries = extractSessionImages(
      [
        {
          timestamp: 1,
          content: "![a](https://ours/1.png) ![b](https://evil/px.png)",
          images: [{ media_type: "image/png", storage_id: "a" }],
        },
        { timestamp: 2, content: "![a again](https://ours/1.png)" },
      ],
      trustOurs,
    );
    expect(entries.map((e) => e.key)).toEqual(["a", "https://ours/1.png"]);
  });

  test("inline base64 images carry a ready data src", () => {
    const [entry] = extractSessionImages(
      [{ timestamp: 1, images: [{ media_type: "image/png", data: "AAAA" }] }],
      trustOurs,
    );
    expect(entry.src).toBe("data:image/png;base64,AAAA");
    expect(entry.storage_id).toBeUndefined();
  });
});

describe("mergeSessionImages", () => {
  const at = (key: string, timestamp: number, seq = 0): SessionImageEntry => ({
    key,
    storage_id: key,
    timestamp,
    seq,
  });

  test("orders the merged set by transcript position, not by source", () => {
    // The regression this exists for: the window holds the newest images, the
    // server list holds the whole thread. Concatenating would put old after new.
    const server = [at("old", 100), at("mid", 200), at("new", 300)];
    const window = [at("new", 300), at("newest", 400)];
    expect(mergeSessionImages(server, window).map((e) => e.key)).toEqual([
      "old",
      "mid",
      "new",
      "newest",
    ]);
  });

  test("keeps two images from one message in their in-message order", () => {
    const merged = mergeSessionImages([at("b", 100, 1), at("a", 100, 0)], []);
    expect(merged.map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("dedupes by key, server entry wins", () => {
    const server = [{ key: "a", storage_id: "a", timestamp: 100, seq: 0 }];
    const window = [{ key: "a", storage_id: "a" }];
    const merged = mergeSessionImages(server, window);
    expect(merged).toHaveLength(1);
    expect(merged[0].timestamp).toBe(100);
  });

  test("un-materialized entries (inline data:) survive the merge", () => {
    const dataSrc = "data:image/png;base64,AAAA";
    const merged = mergeSessionImages([at("a", 100)], [{ key: dataSrc, src: dataSrc, timestamp: 150, seq: 0 }]);
    expect(merged.map((e) => e.key)).toEqual(["a", dataSrc]);
  });

  test("an empty server list leaves the window order untouched", () => {
    const window = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(mergeSessionImages([], window).map((e) => e.key)).toEqual(["a", "b", "c"]);
  });

  test("timestamp-less entries sort after positioned ones, order preserved", () => {
    const merged = mergeSessionImages([at("a", 100)], [{ key: "x" }, { key: "y" }]);
    expect(merged.map((e) => e.key)).toEqual(["a", "x", "y"]);
  });
});
