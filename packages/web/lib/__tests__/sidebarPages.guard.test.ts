import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sidebar = readFileSync(join(import.meta.dir, "..", "..", "components", "sidebar", "SidebarNav.tsx"), "utf8");

describe("Pages sidebar navigation", () => {
  test("stays visible in simple view", () => {
    // The row is found by its href, whatever form its label takes. "Simple
    // view" is the .simple-view rail that hides [data-simple-hide] rows; the
    // hosted lane's own rule for Pages lives in lib/surfaceRules.ts.
    const pagesSection = sidebar.split("<NavSection").map((chunk) => chunk.slice(0, chunk.indexOf("/>"))).find((chunk) => chunk.includes('href="/pages"'));
    expect(pagesSection).toBeDefined();
    expect(pagesSection).toContain('href="/pages"');
    expect(pagesSection).not.toContain("simpleHide");
  });
});
