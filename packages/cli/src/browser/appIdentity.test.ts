import { describe, expect, test } from "bun:test";
import { shouldBrandBrowser, prepareBrowserApp } from "./appIdentity.js";

const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

describe("agent browser branding scope", () => {
  test("brands standard headed Chrome on macOS", () => {
    expect(shouldBrandBrowser(chrome, false, "darwin", "")).toBe(true);
  });

  test("preserves headless, other platforms, other channels and explicit overrides", () => {
    expect(shouldBrandBrowser(chrome, true, "darwin", "")).toBe(false);
    expect(shouldBrandBrowser(chrome, false, "linux", "")).toBe(false);
    expect(shouldBrandBrowser(chrome, false, "win32", "")).toBe(false);
    expect(shouldBrandBrowser(chrome.replaceAll("Google Chrome", "Google Chrome Canary"), false, "darwin", "")).toBe(false);
    expect(shouldBrandBrowser(chrome, false, "darwin", chrome)).toBe(false);
    expect(shouldBrandBrowser("/custom/chromium", false, "darwin", "")).toBe(false);
  });

  test("a source checkout without the compiled helper keeps Chrome usable", () => {
    expect(prepareBrowserApp(chrome, false)).toEqual({ binary: chrome, branded: false });
  });
});
