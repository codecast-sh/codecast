import { expect, test } from 'bun:test';
import { readMeterLevel } from '../calls/walkieMeter';

test('the call and walkie meter use a visible, ordered speech range with silence at zero', () => {
  const bytes = new Uint8Array(256);
  const sample = (amplitude: number) => readMeterLevel({ getByteTimeDomainData: (out) => {
    for (let i = 0; i < out.length; i++) out[i] = 128 + (i % 2 ? amplitude : -amplitude);
  } }, bytes);
  expect(sample(0)).toBe(0);
  expect(sample(1)).toBeGreaterThan(0.15);
  expect(sample(8)).toBeGreaterThan(sample(1));
  expect(sample(32)).toBeGreaterThan(sample(8));
  expect(sample(64)).toBeGreaterThan(0.99);
});
