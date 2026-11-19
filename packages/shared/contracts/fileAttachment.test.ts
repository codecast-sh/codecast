import { describe, expect, test } from "bun:test";
import { appendFileTags, formatFileTag, materializeFileTags, parseFileTags, safeFileName } from "./fileAttachment";

const ID = "kg2abcdefghijklmnop";

describe("file attachment tags", () => {
  test("round trip: the words, then one tag per file", () => {
    const text = appendFileTags("read these", [{ storageId: ID, name: "Q3 report.pdf" }, { storageId: `${ID}x`, name: "data.csv" }]);
    expect(text).toBe(`read these\n\n[File Q3 report.pdf · upload ${ID}]\n[File data.csv · upload ${ID}x]`);
    expect(parseFileTags(text)).toEqual([{ name: "Q3 report.pdf", storageId: ID }, { name: "data.csv", storageId: `${ID}x` }]);
  });

  test("no files leaves the text alone; files alone are just tags", () => {
    expect(appendFileTags("hi", [])).toBe("hi");
    expect(appendFileTags("  ", [{ storageId: ID, name: "a.txt" }])).toBe(`[File a.txt · upload ${ID}]`);
  });

  test("names lose paths, brackets and line breaks", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("a]b[\nc.txt")).toBe("abc.txt");
    expect(safeFileName("..")).toBe("file");
    expect(parseFileTags(formatFileTag({ storageId: ID, name: "x · y].md" }))).toEqual([{ name: "x - y.md", storageId: ID }]);
  });

  test("materialize swaps each tag for its local path, and names a gone file", async () => {
    const text = appendFileTags("see", [{ storageId: ID, name: "a.pdf" }, { storageId: `${ID}z`, name: "b.pdf" }]);
    const out = await materializeFileTags(text, async (ref) => (ref.storageId === ID ? `/tmp/codecast/files/${ID}/a.pdf` : null));
    expect(out).toBe(`see\n\n[File /tmp/codecast/files/${ID}/a.pdf]\n[File b.pdf: no longer available]`);
  });

  test("a failed fetch propagates so delivery can retry", async () => {
    const text = appendFileTags("", [{ storageId: ID, name: "a.pdf" }]);
    await expect(materializeFileTags(text, async () => { throw new Error("HTTP 503"); })).rejects.toThrow("HTTP 503");
  });
});
