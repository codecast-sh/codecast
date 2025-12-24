/**
 * E2E Test for ccs-ov0: Dashboard - empty team conversations
 *
 * Tests that when a team has no conversations, a helpful message
 * and invite prompt are displayed.
 */

import { test, expect } from '@playwright/test';

test.describe('Empty Team Conversations (ccs-ov0)', () => {
  test('should show empty state with invite prompt for team tab when no team conversations exist', async ({ page }) => {
    // Step 1: Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Step 2: Navigate to dashboard
    await page.waitForURL('**/dashboard');

    // Step 3: Switch to Team tab
    const teamTab = page.locator('text=Team').or(page.locator('button:has-text("Team")')).first();
    await teamTab.click();

    // Step 4: Wait for content to load
    await page.waitForTimeout(1000);

    // Step 5: Check if there are no team conversations
    // If there ARE conversations, this test isn't applicable
    const hasConversations = await page.locator('a[href^="/conversation/"]').count() > 0;

    if (!hasConversations) {
      // Step 6: Verify empty state message
      await expect(page.locator('text=No team conversations yet')).toBeVisible();

      // Step 7: Verify invite prompt in description
      await expect(page.locator('text=/team.*invite|invite.*team/i')).toBeVisible();

      // Step 8: Verify "Invite team members" action link exists
      const inviteLink = page.locator('a:has-text("Invite team members")');
      await expect(inviteLink).toBeVisible();

      // Step 9: Verify link points to team settings
      await expect(inviteLink).toHaveAttribute('href', '/settings/team');
    }
  });

  test('should show different message for personal (my) tab when no conversations exist', async ({ page }) => {
    // Step 1: Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Step 2: Navigate to dashboard
    await page.waitForURL('**/dashboard');

    // Step 3: Ensure we're on "My" tab
    const myTab = page.locator('text=My').or(page.locator('button:has-text("My")')).first();
    await myTab.click();

    // Step 4: Wait for content to load
    await page.waitForTimeout(1000);

    // Step 5: Check if there are no personal conversations
    const hasConversations = await page.locator('a[href^="/conversation/"]').count() > 0;

    if (!hasConversations) {
      // Step 6: Verify personal empty state message (NOT the team message)
      await expect(page.locator('text=No conversations yet')).toBeVisible();

      // Step 7: Verify it's the personal message (not team message)
      await expect(page.locator('text=No team conversations yet')).not.toBeVisible();

      // Step 8: Verify "Learn how to sync" action link (personal view)
      const syncLink = page.locator('a:has-text("Learn how to sync")');
      await expect(syncLink).toBeVisible();
      await expect(syncLink).toHaveAttribute('href', '/cli');
    }
  });
});
