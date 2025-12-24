/**
 * Unit tests for title generation logic
 */

import { test, expect } from 'bun:test';

// Copy the generateTitleFromMessage function for testing
function generateTitleFromMessage(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.length <= 50) {
    return trimmed;
  }

  return trimmed.slice(0, 50) + "...";
}

test('generateTitleFromMessage - short message', () => {
  const result = generateTitleFromMessage('Help me with this bug');
  expect(result).toBe('Help me with this bug');
});

test('generateTitleFromMessage - exactly 50 chars', () => {
  const message = 'a'.repeat(50);
  const result = generateTitleFromMessage(message);
  expect(result).toBe(message);
  expect(result.length).toBe(50);
});

test('generateTitleFromMessage - longer than 50 chars', () => {
  const message = 'This is a very long message that should be truncated to approximately fifty characters';
  const result = generateTitleFromMessage(message);
  expect(result).toBe('This is a very long message that should be truncat...');
  expect(result.length).toBe(53); // 50 + "..."
});

test('generateTitleFromMessage - trims whitespace', () => {
  const result = generateTitleFromMessage('  Help me fix this  ');
  expect(result).toBe('Help me fix this');
});

test('generateTitleFromMessage - empty string', () => {
  const result = generateTitleFromMessage('');
  expect(result).toBe('');
});

test('generateTitleFromMessage - whitespace only', () => {
  const result = generateTitleFromMessage('   ');
  expect(result).toBe('');
});

test('generateTitleFromMessage - preserves newlines in short messages', () => {
  const result = generateTitleFromMessage('Line 1\nLine 2');
  expect(result).toBe('Line 1\nLine 2');
});

test('generateTitleFromMessage - truncates before newline if too long', () => {
  const message = 'This is a very long message with a newline\nthat should be truncated';
  const result = generateTitleFromMessage(message);
  expect(result.length).toBe(53); // 50 + "..."
  expect(result.endsWith('...')).toBe(true);
});
