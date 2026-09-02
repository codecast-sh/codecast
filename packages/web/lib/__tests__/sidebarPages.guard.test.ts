import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sidebar = readFileSync(join(import.meta.dir, "..", "..", "components", "Sidebar.tsx"), "utf8");

describe("Pages sidebar navigation", () => {
  test("stays visible in simple view", () => {
    const pagesSection = sidebar.match(/<NavSection\s+label="Pages"[\s\S]*?\/>/)?.[0];
    expect(pagesSection).toBeDefined();
    expect(pagesSection).toContain('href="/pages"');
    expect(pagesSection).not.toContain("simpleHide");
  });
});
