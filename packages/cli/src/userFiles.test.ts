import { describe, expect, it } from "bun:test";
import { extractSentFiles, filesForWire } from "./userFiles.js";

const call = (input: unknown, id = "toolu_1") => ({ id, name: "SendUserFile", input });

describe("extractSentFiles", () => {
  it("lifts each sent file with its caption and display mode", () => {
    const files = extractSentFiles(
      call({ files: ["/tmp/report.pdf", "/tmp/chart.png"], caption: "before vs after", display: "render" }),
    );
    expect(files).toEqual([
      { localPath: "/tmp/report.pdf", name: "report.pdf", toolUseId: "toolu_1", caption: "before vs after", display: "render" },
      { localPath: "/tmp/chart.png", name: "chart.png", toolUseId: "toolu_1", caption: "before vs after", display: "render" },
    ]);
  });

  it("resolves a relative path against the turn's working directory", () => {
    const [file] = extractSentFiles(call({ files: ["docs/plan.md"] }), "/Users/x/src/app");
    expect(file.localPath).toBe("/Users/x/src/app/docs/plan.md");
    expect(file.name).toBe("plan.md");
  });

  it("drops a relative path when the turn has no working directory", () => {
    expect(extractSentFiles(call({ files: ["docs/plan.md"] }))).toEqual([]);
  });

  it("accepts a bare string, dedupes, and ignores other tools", () => {
    expect(extractSentFiles(call({ files: "/tmp/a.txt" }))).toHaveLength(1);
    expect(extractSentFiles(call({ files: ["/tmp/a.txt", "/tmp/a.txt"] }))).toHaveLength(1);
    expect(extractSentFiles({ id: "t", name: "Read", input: { files: ["/tmp/a.txt"] } })).toEqual([]);
  });

  it("caps one call at ten files", () => {
    const many = Array.from({ length: 25 }, (_, i) => `/tmp/f${i}.txt`);
    expect(extractSentFiles(call({ files: many }))).toHaveLength(10);
  });
});

describe("filesForWire", () => {
  it("drops the local path and fills the media type from the name", () => {
    const wire = filesForWire([
      { localPath: "/tmp/report.pdf", name: "report.pdf", size: 4096, storageId: "st_1", toolUseId: "t" },
    ]);
    expect(wire).toEqual([
      { name: "report.pdf", media_type: "application/pdf", size: 4096, storage_id: "st_1", tool_use_id: "t", caption: undefined, display: undefined, error: undefined },
    ]);
    expect(JSON.stringify(wire)).not.toContain("/tmp/report.pdf");
  });

  it("keeps a failed delivery so the card can explain itself", () => {
    const wire = filesForWire([{ name: "huge.zip", mediaType: "application/zip", size: 90_000_000, error: "too_large" }]);
    expect(wire?.[0].error).toBe("too_large");
    expect(wire?.[0].storage_id).toBeUndefined();
  });

  it("is undefined when nothing was sent", () => {
    expect(filesForWire(undefined)).toBeUndefined();
    expect(filesForWire([])).toBeUndefined();
  });
});
