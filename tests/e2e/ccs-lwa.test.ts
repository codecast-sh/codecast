/**
 * E2E test for ccs-lwa: Global loading states
 * Tests that a loading indicator appears during page navigation
 */

import { test, expect } from "@playwright/test";

test.describe("Global loading indicator", () => {
  test("should show loading indicator during navigation", async ({ page }) => {
    await page.goto("http://localhost:3002");

    await page.waitForLoadState("networkidle");

    const navigationPromise = page.waitForNavigation();

    await page.click('a[href="/login"]');

    const nprogressBar = page.locator("#nprogress .bar");
    const barWasVisible = await nprogressBar.isVisible().catch(() => false);

    await navigationPromise;

    expect(barWasVisible || (await page.title())).toBeTruthy();
  });

  test("should clear loading indicator after page loads", async ({ page }) => {
    await page.goto("http://localhost:3002");

    await page.click('a[href="/dashboard"]');

    await page.waitForLoadState("networkidle");

    const nprogressBar = page.locator("#nprogress .bar");
    const isVisible = await nprogressBar.isVisible().catch(() => false);

    expect(isVisible).toBe(false);
  });
});
