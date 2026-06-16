import { describe, expect, test } from "bun:test";
import { packSnapshotContent, readSnapshotContent } from "./docSnapshot";

// A realistic ProseMirror doc JSON: many repeated structural keys, which is what
// makes gzip win big and is exactly the shape that blew past Convex's 1 MiB
// per-document limit before compression.
function bigProseMirrorJson(paragraphs: number): string {
  const content: any[] = [];
  for (let i = 0; i < paragraphs; i++) {
    content.push({
      type: "paragraph",
      content: [
        { type: "text", text: `Paragraph ${i}: the quick brown fox jumps over the lazy dog. ` },
        { type: "text", marks: [{ type: "bold" }], text: "emphasis " },
        { type: "text", text: "and more ordinary prose to pad the document out." },
      ],
    });
  }
  return JSON.stringify({ type: "doc", content });
}

describe("doc snapshot codec", () => {
  test("round-trips content exactly", () => {
    const json = bigProseMirrorJson(50);
    const packed = packSnapshotContent(json);
    expect(readSnapshotContent({ content_gz: packed })).toBe(json);
  });

  test("returns a plain ArrayBuffer (Convex bytes validator requirement)", () => {
    const packed = packSnapshotContent(bigProseMirrorJson(10));
    expect(packed).toBeInstanceOf(ArrayBuffer);
  });

  test("compresses a >1 MiB doc to well under the 1 MiB Convex limit", () => {
    // Enough paragraphs to push the raw JSON past 1 MiB — the case that used to
    // throw "Value is too large" on insert.
    const json = bigProseMirrorJson(12_000);
    expect(json.length).toBeGreaterThan(1_048_576);
    const packed = packSnapshotContent(json);
    expect(packed.byteLength).toBeLessThan(1_048_576);
    // And it still round-trips.
    expect(readSnapshotContent({ content_gz: packed })).toBe(json);
  });

  test("reads legacy uncompressed rows verbatim", () => {
    expect(readSnapshotContent({ content: '{"type":"doc"}' })).toBe('{"type":"doc"}');
  });

  test("prefers compressed content when both fields are present", () => {
    const json = '{"type":"doc","content":[]}';
    const packed = packSnapshotContent(json);
    expect(readSnapshotContent({ content: "STALE", content_gz: packed })).toBe(json);
  });

  test("treats a missing/empty row as empty string", () => {
    expect(readSnapshotContent({})).toBe("");
    expect(readSnapshotContent({ content: null, content_gz: null })).toBe("");
  });
});
