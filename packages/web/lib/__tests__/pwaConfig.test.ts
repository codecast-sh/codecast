import { describe, expect, test } from "bun:test";
import { APP_SHELL_GLOB_IGNORES, APP_SHELL_GLOB_PATTERNS } from "../../vite.pwa";

describe("offline app shell precache", () => {
  test("keeps executable shell assets and excludes content media", () => {
    expect(APP_SHELL_GLOB_PATTERNS).toContain("**/*.{js,css,html,ico,png,svg,woff2}");
    expect(APP_SHELL_GLOB_IGNORES).toEqual(["docs/**", "blog/**"]);
  });
});
