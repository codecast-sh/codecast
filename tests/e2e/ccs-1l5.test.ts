/**
 * E2E Test for ccs-1l5: Network Error Toast
 *
 * Tests that network errors show toast notification with retry button.
 */

import { test, expect, Page } from '@playwright/test';

test.describe('Network Error Toast (ccs-1l5)', () => {
  test('should show error toast when network is disconnected for 5+ seconds', async ({ page, context }) => {
    // Step 1: Login (prerequisite)
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard');

    // Step 2: Verify normal loading works
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10000 });

    // Step 3: Block network by setting offline mode
    await context.setOffline(true);

    // Step 4: Refresh to trigger network error
    await page.reload();

    // Step 5: Wait 6 seconds (toast appears after 5 seconds)
    await page.waitForTimeout(6000);

    // Step 6: Verify error toast appears
    const errorToast = page.locator('text=Network error loading conversations');
    await expect(errorToast).toBeVisible();

    // Step 7: Verify toast has description
    await expect(page.locator('text=Unable to connect to the server')).toBeVisible();

    // Step 8: Verify retry button exists
    const retryButton = page.locator('button:has-text("Retry")');
    await expect(retryButton).toBeVisible();

    // Step 9: Reconnect network
    await context.setOffline(false);

    // Step 10: Click retry button
    await retryButton.click();

    // Step 11: Verify page reloads and data loads successfully
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10000 });

    // Step 12: Verify success toast appears
    await expect(page.locator('text=Connected successfully')).toBeVisible({ timeout: 3000 });
  });

  test('should not show error toast when network is working', async ({ page }) => {
    // Step 1: Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Step 2: Navigate to dashboard
    await page.waitForURL('**/dashboard');

    // Step 3: Verify conversations load without error toast
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10000 });

    // Step 4: Verify NO error toast
    const errorToast = page.locator('text=Network error loading conversations');
    await expect(errorToast).not.toBeVisible();
  });
});
