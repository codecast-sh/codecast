import { describe, expect, test } from "bun:test";
import { parseRelease, parseReleaseTag } from "./classify";

describe("parseReleaseTag", () => {
  test("a bare version is the catch-all release surface", () => {
    expect(parseReleaseTag("v1.2.3")).toEqual({ surface: "release", version: "1.2.3" });
    expect(parseReleaseTag("1.2.3")).toEqual({ surface: "release", version: "1.2.3" });
    expect(parseReleaseTag("release-1.2.0")).toEqual({ surface: "release", version: "1.2.0" });
    expect(parseReleaseTag("v1.2.3-beta.1")).toEqual({ surface: "release", version: "1.2.3-beta.1" });
  });

  test("the name before the version picks the surface, as a release commit's scope does", () => {
    expect(parseReleaseTag("cli-v1.1.163")).toEqual({ surface: "cli", version: "1.1.163" });
    expect(parseReleaseTag("desktop/1.1.123")).toEqual({ surface: "desktop", version: "1.1.123" });
    expect(parseReleaseTag("@codecast/cli@1.2.3")).toEqual({ surface: "cli", version: "1.2.3" });
    expect(parseReleaseTag("codecast-cli-v1.2.3")).toEqual({ surface: "cli", version: "1.2.3" });
    expect(parseReleaseTag("electron-v1.1.0")).toEqual({ surface: "desktop", version: "1.1.0" });
    expect(parseReleaseTag("chrome-extension-v1.0.5")).toEqual({ surface: "extension", version: "1.0.5" });
    expect(parseReleaseTag("refs/tags/backend-v0.4.0")).toEqual({ surface: "backend", version: "0.4.0" });
    expect(parseReleaseTag("api-v2.0.0")).toEqual({ surface: "api", version: "2.0.0" });
  });

  test("a tag with no version is a moving pointer, not a release", () => {
    expect(parseReleaseTag("latest")).toBeNull();
    expect(parseReleaseTag("nightly")).toBeNull();
    expect(parseReleaseTag("v2")).toBeNull();
  });

  test("release commits keep naming the same surfaces", () => {
    expect(parseRelease("chore(cli): bump version to 1.1.163")?.surface).toBe("cli");
    expect(parseRelease("chore(electron): release desktop 1.1.123")?.surface).toBe("desktop");
    expect(parseRelease("chore(convex): bump 0.4.0")?.surface).toBe("backend");
    expect(parseRelease("chore: bump 1.0.0")?.surface).toBe("release");
  });
});
