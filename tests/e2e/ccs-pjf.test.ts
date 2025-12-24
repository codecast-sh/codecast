/**
 * E2E Test for ccs-pjf: Search response time
 *
 * Tests that search results appear in less than 500ms after typing.
 */

import { test, expect } from "@playwright/test";

test.describe("Search response time (ccs-pjf)", () => {
  test("should return search results in less than 500ms", async ({ page }) => {
    await page.goto("http://localhost:3001/login");
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || "test@example.com");
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || "testpass123");
    await page.click('button[type="submit"]');

    await page.waitForURL("**/dashboard");
    await expect(page.locator("text=Active")).toBeVisible({ timeout: 10000 });

    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();

    await searchInput.click();

    const startTime = Date.now();
    await searchInput.fill("test");

    await page.waitForSelector('[class*="animate-spin"]', { state: "visible", timeout: 1000 }).catch(() => {});

    const resultsSelector = 'button[class*="text-left"]';
    const noResultsSelector = 'text=/No conversations match/';

    await Promise.race([
      page.waitForSelector(resultsSelector, { timeout: 1000 }),
      page.waitForSelector(noResultsSelector, { timeout: 1000 })
    ]);

    const endTime = Date.now();
    const responseTime = endTime - startTime;

    console.log(`Search response time: ${responseTime}ms`);
    expect(responseTime).toBeLessThan(500);
  });

  test("should use debouncing to reduce query frequency", async () => {
    const globalSearchPath = "packages/web/components/GlobalSearch.tsx";
    const fs = require("fs");

    const content = fs.readFileSync(globalSearchPath, "utf-8");

    expect(content).toContain("debouncedQuery");
    expect(content).toContain("setTimeout");

    const debounceMatch = content.match(/setTimeout.*?(\d+)\s*\)/s);
    if (debounceMatch) {
      const delay = parseInt(debounceMatch[1]);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(300);
      console.log(`Search debounce delay: ${delay}ms`);
    }
  });

  test("should use Convex search index for performance", async () => {
    const schemaPath = "packages/convex/convex/schema.ts";
    const fs = require("fs");

    const content = fs.readFileSync(schemaPath, "utf-8");

    expect(content).toContain("searchIndex");
    expect(content).toContain("search_content");
    expect(content).toContain('searchField: "content"');

    console.log("Convex search index configured correctly");
  });
});
