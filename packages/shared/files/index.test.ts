import { describe, expect, it } from "bun:test";
import { fileKind, fileTypeLabel, formatFileSize, isPreviewableKind, mediaTypeForFile } from "./index";

describe("mediaTypeForFile", () => {
  it("reads the type off the name, case and path insensitive", () => {
    expect(mediaTypeForFile("/tmp/a/Report.PDF")).toBe("application/pdf");
    expect(mediaTypeForFile("notes.md")).toBe("text/markdown");
    expect(mediaTypeForFile("deck.pptx")).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
  });

  it("treats an unknown extension as opaque bytes", () => {
    expect(mediaTypeForFile("core.dump")).toBe("application/octet-stream");
    expect(mediaTypeForFile("LICENSE")).toBe("application/octet-stream");
  });
});

describe("fileKind", () => {
  it("groups by what a surface can do with it", () => {
    expect(fileKind("image/png")).toBe("image");
    expect(fileKind("application/pdf")).toBe("pdf");
    expect(fileKind("text/csv")).toBe("text");
    expect(fileKind("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("sheet");
    expect(fileKind("application/zip")).toBe("archive");
    expect(fileKind("application/json")).toBe("text");
  });

  it("falls back to the name when the stamp says nothing", () => {
    expect(fileKind("application/octet-stream", "plan.md")).toBe("text");
    expect(fileKind(undefined, "shot.png")).toBe("image");
  });

  // SVG served from our own storage origin executes script on direct
  // navigation, so it is a download like any document, never a preview.
  it("never previews SVG", () => {
    expect(fileKind("image/svg+xml")).toBe("binary");
    expect(isPreviewableKind(fileKind("image/svg+xml"))).toBe(false);
  });
});

describe("formatFileSize", () => {
  it("keeps a decimal only where it carries information", () => {
    expect(formatFileSize(812)).toBe("812 B");
    expect(formatFileSize(1_400)).toBe("1.4 KB");
    expect(formatFileSize(15_304)).toBe("15 KB");
    expect(formatFileSize(31_457_280)).toBe("31 MB");
  });
});

describe("fileTypeLabel", () => {
  it("names the type the way the file does", () => {
    expect(fileTypeLabel("report.pdf")).toBe("PDF");
    expect(fileTypeLabel("archive.tar.gz")).toBe("GZ");
    expect(fileTypeLabel("LICENSE", "text/plain")).toBe("PLAIN");
  });
});
