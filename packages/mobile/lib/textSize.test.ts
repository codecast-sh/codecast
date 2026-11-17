import { describe, expect, test } from 'bun:test';
import { resolveTextSize, sizedText } from './textSize';

describe('text size', () => {
  test('defaults to medium', () => {
    expect(resolveTextSize(undefined)).toBe('medium');
    expect(resolveTextSize(null)).toBe('medium');
    expect(resolveTextSize('huge')).toBe('medium');
    expect(resolveTextSize('small')).toBe('small');
    expect(resolveTextSize('large')).toBe('large');
  });

  test('small keeps the shipped size', () => {
    expect(sizedText(15, 24, 'small')).toEqual({ fontSize: 15, lineHeight: 24 });
    expect(sizedText(15, undefined, 'small')).toEqual({ fontSize: 15 });
  });

  test('steps grow the line height with the size', () => {
    expect(sizedText(15, 24, 'medium')).toEqual({ fontSize: 16.5, lineHeight: 26 });
    expect(sizedText(15, 24, 'large')).toEqual({ fontSize: 18, lineHeight: 29 });
  });
});
