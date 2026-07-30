import { describe, expect, it } from "bun:test";
import { ARTIFACT_SLUG_RE, renderArtifactPage } from "./artifactPage";

describe("ARTIFACT_SLUG_RE", () => {
  it("accepts base62 slugs of plausible length", () => {
    expect(ARTIFACT_SLUG_RE.test("wbYnhK4Qv9zw")).toBe(true);
    expect(ARTIFACT_SLUG_RE.test("abc123")).toBe(true);
  });

  it("rejects path escapes and junk", () => {
    expect(ARTIFACT_SLUG_RE.test("../etc")).toBe(false);
    expect(ARTIFACT_SLUG_RE.test("a/b")).toBe(false);
    expect(ARTIFACT_SLUG_RE.test("x".repeat(40))).toBe(false);
    expect(ARTIFACT_SLUG_RE.test("")).toBe(false);
  });
});

describe("renderArtifactPage", () => {
  it("404s a malformed slug without touching the network", async () => {
    const { status, html } = await renderArtifactPage("../../etc/passwd");
    expect(status).toBe(404);
    expect(html).toContain("Invalid link");
  });
});
