import { describe, expect, test } from "bun:test";
import { isFullWidthRoute } from "../pageLayout";

// FULL_WIDTH_PATTERNS is the single source of truth for full-bleed routes,
// shared by TabContent and DashboardLayout. These pins caught real drift:
// /capabilities, /crosstalk and /files were hand-patched in DashboardLayout
// but missing here, so the tab shell rendered them narrow + double-scrolled.
describe("isFullWidthRoute", () => {
  test("capabilities and crosstalk are full-width (exact match only)", () => {
    expect(isFullWidthRoute("/capabilities")).toBe(true);
    expect(isFullWidthRoute("/crosstalk")).toBe(true);
    expect(isFullWidthRoute("/capabilities-other")).toBe(false);
    expect(isFullWidthRoute("/crosstalk-other")).toBe(false);
  });

  test("/files and its pre-rename /vault alias are full-width, subpaths included", () => {
    expect(isFullWidthRoute("/files")).toBe(true);
    expect(isFullWidthRoute("/files/some-vault")).toBe(true);
    expect(isFullWidthRoute("/vault")).toBe(true);
    expect(isFullWidthRoute("/vault/some-vault")).toBe(true);
    expect(isFullWidthRoute("/filesystem")).toBe(false);
  });

  test("plain reading pages stay in the shell", () => {
    expect(isFullWidthRoute("/team")).toBe(false);
    expect(isFullWidthRoute("/pages")).toBe(false);
  });

  test("query and hash are stripped before matching", () => {
    expect(isFullWidthRoute("/files?path=x#y")).toBe(true);
  });
});
