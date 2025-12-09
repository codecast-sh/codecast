/**
 * E2E Test for ccs-eq0: Team name display in dashboard header
 *
 * This test verifies that:
 * 1. When a user belongs to a team, the team name is displayed in the dashboard header
 * 2. When a user has no team, "codecast" is displayed as fallback
 */

import { test, expect } from '@playwright/test';

test.describe('Team name display (ccs-eq0)', () => {
  test('displays team name in dashboard header when user has a team', async ({ page }) => {
    // Navigate to login page
    await page.goto('/login');

    // Sign in with a test user that has a team
    await page.fill('input[name="email"]', 'testuser@team.com');
    await page.fill('input[name="password"]', 'testpass123');
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL('/dashboard');

    // Verify team name is displayed in header
    const header = page.locator('header h1');
    await expect(header).not.toHaveText('codecast');
    await expect(header).toBeVisible();

    // The team name should be displayed (exact name depends on test data)
    const teamName = await header.textContent();
    expect(teamName).toBeTruthy();
    expect(teamName).not.toBe('codecast');
  });

  test('displays "codecast" as fallback when user has no team', async ({ page }) => {
    // Navigate to login page
    await page.goto('/login');

    // Sign in with a test user that has NO team
    await page.fill('input[name="email"]', 'noteam@example.com');
    await page.fill('input[name="password"]', 'testpass123');
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL('/dashboard');

    // Verify "codecast" is displayed as fallback
    const header = page.locator('header h1');
    await expect(header).toHaveText('codecast');
  });
});
