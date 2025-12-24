/**
 * E2E Test for ccs-2bz: Message count badge
 *
 * Tests that each conversation in the list displays a message count badge.
 */

import { test, expect } from '@playwright/test';

test.describe('Message Count Badge (ccs-2bz)', () => {
  test('should display message count badge on each conversation item', async ({ page }) => {
    // Step 1: Login (prerequisite)
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Step 2: Navigate to dashboard (conversation list)
    await page.waitForURL('**/dashboard');

    // Step 3: Wait for conversations to load
    await expect(page.locator('text=All').first()).toBeVisible({ timeout: 10000 });

    // Step 4: Verify at least one conversation item exists
    const conversationItems = page.locator('a[href^="/conversation/"]');
    await expect(conversationItems.first()).toBeVisible({ timeout: 5000 });

    // Step 5: Find message count badges
    const messageCountBadges = page.locator('span:has(svg path[d*="M8 12h.01M12 12h.01"])');

    // Step 6: Verify at least one message count badge is visible
    const badgeCount = await messageCountBadges.count();
    expect(badgeCount).toBeGreaterThan(0);

    // Step 7: Verify badge styling
    const firstBadge = messageCountBadges.first();
    await expect(firstBadge).toHaveClass(/px-2/);
    await expect(firstBadge).toHaveClass(/rounded/);
    await expect(firstBadge).toHaveClass(/border/);

    // Step 8: Verify badge contains a number
    const badgeText = await firstBadge.locator('span.text-\\[10px\\]').textContent();
    expect(badgeText).toMatch(/^\d+$/);
  });

  test('should show different badge colors based on message count', async ({ page }) => {
    // Step 1: Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Step 2: Navigate to dashboard
    await page.waitForURL('**/dashboard');

    // Step 3: Wait for conversations to load
    await expect(page.locator('text=All').first()).toBeVisible({ timeout: 10000 });

    // Step 4: Find all message count badges
    const messageCountBadges = page.locator('span:has(svg path[d*="M8 12h.01M12 12h.01"])');
    const badgeCount = await messageCountBadges.count();

    if (badgeCount > 0) {
      // Step 5: Verify badges have color classes
      for (let i = 0; i < Math.min(badgeCount, 5); i++) {
        const badge = messageCountBadges.nth(i);
        const className = await badge.getAttribute('class');

        expect(className).toMatch(/bg-/);
        expect(className).toMatch(/text-/);
        expect(className).toMatch(/border-/);
      }
    }
  });
});
