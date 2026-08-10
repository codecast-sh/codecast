import { describe, expect, it } from "bun:test";
import {
  extractHtmlTitle,
  resolveArtifactTitle,
  isHtmlPath,
  formatBytes,
  isMarkdownPath,
  resolveMarkdownTitle,
  parseExpires,
  buildAccessPayload,
  describeAccess,
  isSkippedBundlePath,
  filterBundlePaths,
  pickBundleEntry,
  bundleSizeError,
  gateGlyphs,
  formatAgeShort,
  formatArtifactTable,
  type ArtifactLsRow,
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

describe("isMarkdownPath", () => {
  it("accepts .md and .markdown in any case", () => {
    expect(isMarkdownPath("notes.md")).toBe(true);
    expect(isMarkdownPath("NOTES.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("notes.html")).toBe(false);
    expect(isMarkdownPath("md")).toBe(false);
  });
});

describe("resolveMarkdownTitle", () => {
  it("prefers the explicit override", () => {
    expect(resolveMarkdownTitle("# Doc", "/tmp/a.md", "Custom")).toBe("Custom");
  });

  it("uses the first heading, stripped of inline formatting", () => {
    expect(resolveMarkdownTitle("intro\n\n## The *Real* `Title`\n\ntext", "/tmp/a.md")).toBe("The Real Title");
  });

  it("falls back to the filename without extension", () => {
    expect(resolveMarkdownTitle("no headings here", "/tmp/q3-notes.md")).toBe("q3-notes");
  });
});

describe("parseExpires", () => {
  it("parses minutes, hours, days, weeks", () => {
    expect(parseExpires("30m")).toEqual({ ms: 30 * 60_000 });
    expect(parseExpires("24h")).toEqual({ ms: 24 * 3_600_000 });
    expect(parseExpires("7d")).toEqual({ ms: 7 * 86_400_000 });
    expect(parseExpires("2w")).toEqual({ ms: 14 * 86_400_000 });
  });

  it("maps never to null (clear)", () => {
    expect(parseExpires("never")).toEqual({ ms: null });
    expect(parseExpires(" NEVER ")).toEqual({ ms: null });
  });

  it("rejects garbage and zero", () => {
    expect(parseExpires("soon")).toHaveProperty("error");
    expect(parseExpires("0d")).toHaveProperty("error");
    expect(parseExpires("7")).toHaveProperty("error");
    expect(parseExpires("-1d")).toHaveProperty("error");
  });
});

describe("buildAccessPayload", () => {
  it("returns no payload when nothing was flagged", () => {
    expect(buildAccessPayload({})).toEqual({});
  });

  it("maps set/clear password", () => {
    expect(buildAccessPayload({ password: "hunter2" }).payload).toEqual({ password: "hunter2" });
    expect(buildAccessPayload({ password: false }).payload).toEqual({ password: null });
  });

  it("maps email gate, expiry, and edit mode together", () => {
    expect(
      buildAccessPayload({ emailGate: true, expiresMs: 60_000, editMode: "link" }).payload,
    ).toEqual({ email_gate: true, expires_in_ms: 60_000, edit_mode: "link" });
  });

  it("keeps explicit clears distinct from untouched", () => {
    expect(buildAccessPayload({ emailGate: false, expiresMs: null }).payload).toEqual({
      email_gate: false,
      expires_in_ms: null,
    });
  });

  it("rejects unknown edit modes", () => {
    expect(buildAccessPayload({ editMode: "everyone" }).error).toContain("everyone");
  });

  it("maps the session-link toggle both ways", () => {
    expect(buildAccessPayload({ session: false }).payload).toEqual({ show_session: false });
    expect(buildAccessPayload({ session: true }).payload).toEqual({ show_session: true });
  });
});

describe("describeAccess", () => {
  it("summarizes active gates", () => {
    const text = describeAccess({ password: "x", email_gate: true, expires_in_ms: 86_400_000, edit_mode: "link" });
    expect(text).toBe("password · email gate · expires in 1d · edit: link");
  });

  it("names clears explicitly", () => {
    expect(describeAccess({ password: null, expires_in_ms: null })).toBe("password cleared · never expires");
  });

  it("names the session-link toggle", () => {
    expect(describeAccess({ show_session: false })).toBe("session link hidden");
    expect(describeAccess({ show_session: true })).toBe("session link shown");
  });
});

describe("bundle path selection", () => {
  it("skips dotfiles, dot-dirs, node_modules, and sourcemaps", () => {
    expect(isSkippedBundlePath(".env")).toBe(true);
    expect(isSkippedBundlePath("sub/.git/config")).toBe(true);
    expect(isSkippedBundlePath("node_modules/x/index.js")).toBe(true);
    expect(isSkippedBundlePath("assets/app.js.map")).toBe(true);
    expect(isSkippedBundlePath("index.html")).toBe(false);
    expect(isSkippedBundlePath("assets/app.js")).toBe(false);
  });

  it("filters and sorts", () => {
    expect(
      filterBundlePaths(["b.css", ".DS_Store", "a.html", "node_modules/x.js", "app.js.map"]),
    ).toEqual(["a.html", "b.css"]);
  });
});

describe("pickBundleEntry", () => {
  it("prefers index.html even among several html files", () => {
    expect(pickBundleEntry(["about.html", "index.html", "app.js"])).toEqual({ entry: "index.html" });
  });

  it("accepts exactly one html file", () => {
    expect(pickBundleEntry(["report.html", "style.css"])).toEqual({ entry: "report.html" });
  });

  it("errors with no html or an ambiguous set", () => {
    expect(pickBundleEntry(["style.css"]).error).toContain("no .html");
    const ambiguous = pickBundleEntry(["a.html", "b.html"]);
    expect(ambiguous.error).toContain("index.html");
    expect(ambiguous.error).toContain("a.html");
  });
});

describe("bundleSizeError", () => {
  it("passes under the cap", () => {
    expect(bundleSizeError([{ path: "index.html", size: 1000 }], 8 * 1024 * 1024)).toBeNull();
  });

  it("names the biggest files when over the cap", () => {
    const files = [
      { path: "index.html", size: 10_000 },
      { path: "video.mp4", size: 9 * 1024 * 1024 },
      { path: "big.png", size: 2 * 1024 * 1024 },
    ];
    const err = bundleSizeError(files, 8 * 1024 * 1024);
    expect(err).toContain("limit is 8.0MB");
    expect(err).toContain("video.mp4");
    expect(err).toContain("big.png");
    expect(err!.indexOf("video.mp4")).toBeLessThan(err!.indexOf("big.png"));
  });
});

const lsRow = (over: Partial<ArtifactLsRow> = {}): ArtifactLsRow => ({
  slug: "abc123",
  title: "Q3 Report",
  version: 3,
  kind: "html",
  views: 12,
  comments_open: 2,
  has_password: false,
  email_gate: false,
  expires_at: null,
  edit_mode: "owner",
  session_short_id: "jx7c6zk",
  updated_at: Date.now() - 3 * 3_600_000,
  url: "https://codecast.sh/a/abc123",
  ...over,
});

describe("gateGlyphs", () => {
  it("shows nothing for an open owner-edited artifact", () => {
    expect(gateGlyphs(lsRow())).toBe("");
  });

  it("stacks glyphs for each active gate", () => {
    expect(
      gateGlyphs(lsRow({ has_password: true, email_gate: true, expires_at: 123, edit_mode: "link" })),
    ).toBe("⚿✉◷✎");
  });
});

describe("formatAgeShort", () => {
  it("compact units", () => {
    expect(formatAgeShort(30_000)).toBe("now");
    expect(formatAgeShort(5 * 60_000)).toBe("5m");
    expect(formatAgeShort(3 * 3_600_000)).toBe("3h");
    expect(formatAgeShort(49 * 3_600_000)).toBe("2d");
  });
});

describe("formatArtifactTable", () => {
  it("prints a hint when empty", () => {
    expect(formatArtifactTable([], 0)[0]).toContain("cast publish");
  });

  it("renders aligned rows with all columns", () => {
    const now = Date.now();
    const lines = formatArtifactTable(
      [lsRow(), lsRow({ slug: "xyz", title: "Dash", kind: "bundle", has_password: true, comments_open: 0, session_short_id: null })],
      now,
    );
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^SLUG\s+TITLE\s+VER\s+KIND\s+VIEWS\s+CMTS\s+GATES\s+SESSION\s+AGE\s+URL$/);
    expect(lines[1]).toContain("abc123");
    expect(lines[1]).toContain("v3");
    expect(lines[1]).toContain("jx7c6zk");
    expect(lines[1]).toContain("3h");
    expect(lines[1]).toContain("https://codecast.sh/a/abc123");
    expect(lines[2]).toContain("bundle");
    expect(lines[2]).toContain("⚿");
    // columns align: URL column starts at the same offset in every line
    const urlCol = lines[0].indexOf("URL");
    expect(lines[1].indexOf("https://")).toBe(urlCol);
  });

  it("truncates long titles", () => {
    const lines = formatArtifactTable([lsRow({ title: "x".repeat(80) })], Date.now());
    expect(lines[1]).toContain("…");
    expect(lines[1]).not.toContain("x".repeat(40));
  });
});
