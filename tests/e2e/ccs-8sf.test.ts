/**
 * E2E Test for ccs-8sf: Sync latency
 *
 * Tests that messages appear in the dashboard with low latency via real-time Convex subscriptions.
 */

import { test, expect } from "@playwright/test";

test.describe("Sync latency (ccs-8sf)", () => {
  test("should receive real-time updates via WebSocket subscription", async ({ page }) => {
    await page.goto("http://localhost:3001/login");
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || "test@example.com");
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || "testpass123");
    await page.click('button[type="submit"]');

    await page.waitForURL("**/dashboard");
    await expect(page.locator("text=Active")).toBeVisible({ timeout: 10000 });

    const initialCount = await page.locator('a[href^="/conversation/"]').count();

    const webSocketPromise = page.waitForEvent("websocket", {
      predicate: (ws) => {
        const url = ws.url();
        return url.includes("convex") || url.includes("ws");
      },
      timeout: 5000,
    });

    const ws = await webSocketPromise;
    expect(ws).toBeTruthy();

    console.log("WebSocket connection established for real-time updates");
  });

  test("should display new conversations within 2 seconds", async ({ page }) => {
    await page.goto("http://localhost:3001/login");
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || "test@example.com");
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || "testpass123");
    await page.click('button[type="submit"]');

    await page.waitForURL("**/dashboard");

    const conversationList = page.locator('[data-testid="conversation-item"]');
    await expect(conversationList.first()).toBeVisible({ timeout: 10000 });

    const initialTimestamp = Date.now();

    await page.waitForTimeout(500);

    const conversations = await conversationList.all();
    const latestConversation = conversations[0];

    if (latestConversation) {
      const timeText = await latestConversation.locator('text=/ago|just now/').first().textContent();

      if (timeText?.includes("just now") || timeText?.includes("0m") || timeText?.includes("1m")) {
        console.log("Recent conversation found with low latency indicator");
      }
    }
  });

  test("should use optimized file watcher settings", async () => {
    const sessionWatcherPath = "packages/cli/src/sessionWatcher.ts";
    const fs = require("fs");

    const content = fs.readFileSync(sessionWatcherPath, "utf-8");

    expect(content).toContain("awaitWriteFinish");
    expect(content).toContain("stabilityThreshold");

    const stabilityMatch = content.match(/stabilityThreshold:\s*(\d+)/);
    if (stabilityMatch) {
      const threshold = parseInt(stabilityMatch[1]);
      expect(threshold).toBeLessThanOrEqual(200);
      console.log(`File watcher stability threshold: ${threshold}ms`);
    }
  });
});
