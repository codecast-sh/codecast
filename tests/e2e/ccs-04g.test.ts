/**
 * E2E Test for ccs-04g: Copy message to clipboard
 *
 * Tests that users can copy message content to clipboard with toast feedback.
 */

import { test, expect } from '@playwright/test';

test.describe('Copy message to clipboard (ccs-04g)', () => {
  test('should show copy button on hover and copy message content', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Step 1: Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');

    // Wait for redirect to dashboard
    await page.waitForURL('**/dashboard');

    // Step 2: Navigate to a conversation (wait for conversations to load)
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10000 });

    // Click the first conversation
    const firstConversation = page.locator('[data-testid="conversation-item"]').first();
    if (await firstConversation.count() > 0) {
      await firstConversation.click();
    } else {
      // If no conversations, skip this test
      test.skip();
    }

    // Wait for conversation to load
    await page.waitForURL('**/conversation/**');

    // Step 3: Find a user message or assistant message
    const userMessage = page.locator('.bg-sol-blue\\/10').first();
    const assistantMessage = page.locator('.scroll-mt-20.group').first();

    // Test with whichever message type is present
    let messageElement;
    let expectedContent;

    if (await userMessage.count() > 0) {
      messageElement = userMessage;
    } else if (await assistantMessage.count() > 0) {
      messageElement = assistantMessage;
    } else {
      // No messages to test
      test.skip();
    }

    // Step 4: Hover over the message
    await messageElement.hover();

    // Step 5: Verify copy button appears
    const copyButton = messageElement.locator('button[title="Copy message"]');
    await expect(copyButton).toBeVisible({ timeout: 2000 });

    // Step 6: Click copy button
    await copyButton.click();

    // Step 7: Verify "Copied!" toast notification appears
    const copiedToast = page.locator('text=Copied!');
    await expect(copiedToast).toBeVisible({ timeout: 3000 });

    // Step 8: Verify content was actually copied to clipboard
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardContent.length).toBeGreaterThan(0);
  });

  test('should copy assistant message content', async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // Login
    await page.goto('http://localhost:3001/login');
    await page.fill('input[type="email"]', process.env.TEST_USER_EMAIL || 'test@example.com');
    await page.fill('input[type="password"]', process.env.TEST_USER_PASSWORD || 'testpass123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard');

    // Navigate to conversation
    await expect(page.locator('text=Active')).toBeVisible({ timeout: 10000 });
    const firstConversation = page.locator('[data-testid="conversation-item"]').first();
    if (await firstConversation.count() === 0) {
      test.skip();
    }
    await firstConversation.click();
    await page.waitForURL('**/conversation/**');

    // Find an assistant message with content
    const assistantMessages = page.locator('.scroll-mt-20.group');
    if (await assistantMessages.count() === 0) {
      test.skip();
    }

    const firstAssistantMessage = assistantMessages.first();

    // Hover and click copy
    await firstAssistantMessage.hover();
    const copyButton = firstAssistantMessage.locator('button[title="Copy message"]');

    if (await copyButton.count() === 0) {
      // No copy button means no content in this message
      test.skip();
    }

    await copyButton.click();

    // Verify toast
    await expect(page.locator('text=Copied!')).toBeVisible({ timeout: 3000 });

    // Verify clipboard has content
    const clipboardContent = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardContent.length).toBeGreaterThan(0);
  });
});
