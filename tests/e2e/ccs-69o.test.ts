/**
 * E2E Test for ccs-69o: Invite - non-admin cannot invite
 *
 * Tests that non-admin team members cannot see or access invite functionality.
 */

import { test, expect } from '@playwright/test';

test.describe('Invite Permissions (ccs-69o)', () => {
  test('non-admin should not see Invite button in dashboard header', async ({ page }) => {
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_MEMBER_EMAIL || 'member@example.com');
    await page.fill('input[type="password"]', process.env.TEST_MEMBER_PASSWORD || 'memberpass123');
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard');
    await page.waitForTimeout(1000);

    const inviteButton = page.locator('button:has-text("Invite")').first();
    await expect(inviteButton).not.toBeVisible();
  });

  test('non-admin should not see Invite button on team settings page', async ({ page }) => {
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_MEMBER_EMAIL || 'member@example.com');
    await page.fill('input[type="password"]', process.env.TEST_MEMBER_PASSWORD || 'memberpass123');
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard');

    await page.goto('http://localhost:3001/settings/team');
    await page.waitForTimeout(1000);

    const inviteButton = page.locator('button:has-text("Invite")');
    await expect(inviteButton).not.toBeVisible();
  });

  test('admin should see Invite button in dashboard header', async ({ page }) => {
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_ADMIN_EMAIL || 'admin@example.com');
    await page.fill('input[type="password"]', process.env.TEST_ADMIN_PASSWORD || 'adminpass123');
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard');
    await page.waitForTimeout(1000);

    const inviteButton = page.locator('button:has-text("Invite")').first();
    await expect(inviteButton).toBeVisible();
  });

  test('admin should see Invite button on team settings page', async ({ page }) => {
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_ADMIN_EMAIL || 'admin@example.com');
    await page.fill('input[type="password"]', process.env.TEST_ADMIN_PASSWORD || 'adminpass123');
    await page.click('button[type="submit"]');

    await page.waitForURL('**/dashboard');

    await page.goto('http://localhost:3001/settings/team');
    await page.waitForTimeout(1000);

    const inviteButton = page.locator('button:has-text("Invite")');
    await expect(inviteButton).toBeVisible();
  });
});
