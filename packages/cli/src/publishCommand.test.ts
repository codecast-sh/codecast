import { describe, expect, it } from "bun:test";
import {
  extractHtmlTitle,
  resolveArtifactTitle,
  isHtmlPath,
  formatBytes,
} from "./publishCommand";

describe("extractHtmlTitle", () => {
  it("reads a simple title", () => {
    expect(extractHtmlTitle("<html><head><title>Q3 Report</title></head></html>")).toBe("Q3 Report");
  });

  it("is case-insensitive and tolerates attributes", () => {
    expect(extractHtmlTitle('<TITLE data-x="1">Hello</TITLE>')).toBe("Hello");
  });

  it("collapses whitespace across lines", () => {
    expect(extractHtmlTitle("<title>\n  Spaced\n  Out\n</title>")).toBe("Spaced Out");
  });

  it("decodes common entities", () => {
    expect(extractHtmlTitle("<title>Fish &amp; Chips &lt;3</title>")).toBe("Fish & Chips <3");
  });

  it("returns null when missing or empty", () => {
    expect(extractHtmlTitle("<html><body>no title</body></html>")).toBeNull();
    expect(extractHtmlTitle("<title>   </title>")).toBeNull();
  });

  it("caps absurdly long titles", () => {
    const title = extractHtmlTitle(`<title>${"x".repeat(500)}</title>`);
    expect(title?.length).toBe(200);
  });
});

describe("resolveArtifactTitle", () => {
  it("prefers the explicit override", () => {
    expect(resolveArtifactTitle("<title>Doc</title>", "/tmp/page.html", "Custom")).toBe("Custom");
  });

  it("falls back to the title tag", () => {
    expect(resolveArtifactTitle("<title>Doc</title>", "/tmp/page.html")).toBe("Doc");
  });

  it("falls back to the filename without extension", () => {
    expect(resolveArtifactTitle("<div/>", "/tmp/growth-report.html")).toBe("growth-report");
    expect(resolveArtifactTitle("<div/>", "/tmp/page.HTM")).toBe("page");
  });

  it("ignores a whitespace-only override", () => {
    expect(resolveArtifactTitle("<title>Doc</title>", "/tmp/page.html", "  ")).toBe("Doc");
  });
});

describe("isHtmlPath", () => {
  it("accepts .html and .htm in any case", () => {
    expect(isHtmlPath("a.html")).toBe(true);
    expect(isHtmlPath("a.htm")).toBe(true);
    expect(isHtmlPath("A.HTML")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isHtmlPath("a.md")).toBe(false);
    expect(isHtmlPath("a.html.bak")).toBe(false);
    expect(isHtmlPath("html")).toBe(false);
  });
});

describe("formatBytes", () => {
  it("picks sensible units", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
