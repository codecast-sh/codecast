/**
 * The marker that puts a command's screenshot into the conversation.
 *
 * This runs over TOOL OUTPUT, which includes text the agent did not write —
 * a fetched page, a file it printed, another program's logs. So the parsing
 * rules matter for more than tidiness: a marker honoured mid-sentence would let
 * quoted text cause a local file to be read and uploaded.
 */

import { describe, expect, test } from "bun:test";
import { extractInlineImages, inlineImageMarker } from "./inlineImage.js";

describe("extractInlineImages", () => {
  test("finds the path a command declared", () => {
    const out = `● /tmp/shot.png (12K)\n${inlineImageMarker("/tmp/shot.png")}`;
    expect(extractInlineImages(out).paths).toEqual(["/tmp/shot.png"]);
  });

  test("removes the marker from what the human reads", () => {
    const out = `● /tmp/shot.png (12K)\n${inlineImageMarker("/tmp/shot.png")}`;
    const { text } = extractInlineImages(out);
    expect(text).toBe("● /tmp/shot.png (12K)");
    expect(text).not.toContain("cast:image");
  });

  test("leaves output without a marker byte-identical", () => {
    // The common case by far — this must not reformat ordinary tool output.
    const out = "total 4\ndrwxr-xr-x  3 ashot  staff   96 Aug 14 10:00 .\n";
    expect(extractInlineImages(out)).toEqual({ text: out, paths: [] });
  });

  test("keeps several images in the order they were printed", () => {
    const out = [inlineImageMarker("/tmp/a.png"), "middle", inlineImageMarker("/tmp/b.png")].join("\n");
    expect(extractInlineImages(out).paths).toEqual(["/tmp/a.png", "/tmp/b.png"]);
  });

  test("does not repeat a path declared twice", () => {
    const out = [inlineImageMarker("/tmp/a.png"), inlineImageMarker("/tmp/a.png")].join("\n");
    expect(extractInlineImages(out).paths).toEqual(["/tmp/a.png"]);
  });

  test("ignores a marker quoted inside a line of prose", () => {
    // Tool output carries text from elsewhere. Honouring a marker that merely
    // appears within a line would make any quoted page able to name a file.
    const out = `the docs say to print ${inlineImageMarker("/etc/passwd.png")} at the end`;
    const r = extractInlineImages(out);
    expect(r.paths).toEqual([]);
    expect(r.text).toBe(out);
  });

  test("ignores a relative path", () => {
    // It would resolve against the syncing process's directory, not the one
    // the command ran in — so it names a different file, or none.
    const out = inlineImageMarker("shot.png");
    expect(extractInlineImages(out).paths).toEqual([]);
  });

  test("tolerates trailing whitespace on the marker line", () => {
    const out = `${inlineImageMarker("/tmp/a.png")}   `;
    expect(extractInlineImages(out).paths).toEqual(["/tmp/a.png"]);
  });

  test("handles a path containing spaces", () => {
    const p = "/Users/ashot/My Screenshots/shot 1.png";
    expect(extractInlineImages(inlineImageMarker(p)).paths).toEqual([p]);
  });

  test("costs nothing on large output with no marker", () => {
    // Guarded by a substring check before the regex, since this runs on every
    // tool result in every transcript the parser reads.
    const big = "x".repeat(2_000_000);
    expect(extractInlineImages(big).paths).toEqual([]);
  });

  test("survives empty output", () => {
    expect(extractInlineImages("")).toEqual({ text: "", paths: [] });
  });
});
