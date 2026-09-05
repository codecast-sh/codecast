import { expect, test } from 'bun:test';
import { ingestReceiptSignature } from './ingestReceipt.js';
import type { ParsedMessage, TranscriptEmission } from '../parser.js';

test('receipt equality distinguishes source timestamp facts while generated clocks and queued ordering stay incidental', () => {
  const message: ParsedMessage = { role: 'assistant', content: 'same', timestamp: 100 };
  const source: TranscriptEmission = { occurrence: 0, timestampPresent: false, nativeTimestamp: undefined, receiptTimestamp: 0 };
  const signature = ingestReceiptSignature(message, source);
  expect(ingestReceiptSignature({ ...message, timestamp: 200 }, source)).toBe(signature);
  expect(ingestReceiptSignature(message, { ...source, timestampPresent: true, nativeTimestamp: '' })).not.toBe(signature);
  const native = { ...source, timestampPresent: true, nativeTimestamp: '2026-09-05T12:00:00Z', receiptTimestamp: Date.parse('2026-09-05T12:00:00Z') };
  expect(ingestReceiptSignature(message, native)).not.toBe(ingestReceiptSignature(message, { ...native, nativeTimestamp: '2026-09-05T08:00:00-04:00' }));
  const queued = { ...native, queued: true };
  const queuedSignature = ingestReceiptSignature(message, queued);
  expect(ingestReceiptSignature(message, { ...queued, nativeTimestamp: '2026-09-05T08:00:00-04:00' })).not.toBe(queuedSignature);
  expect(ingestReceiptSignature({ ...message, timestamp: 999 }, { ...queued, receiptTimestamp: 999, dequeue: { timestampPresent: true, nativeTimestamp: 'later dependency' } })).toBe(queuedSignature);
  for (const change of [
    { content: 'changed' },
    { model: 'changed' },
    { thinking: 'changed' },
    { images: [{ mediaType: 'image/png', data: 'changed' }] },
    { toolCalls: [{ id: 'one', name: 'tool', input: { changed: true } }] },
    { toolResults: [{ toolUseId: 'one', content: 'changed' }] },
  ]) expect(ingestReceiptSignature({ ...message, ...change }, queued)).not.toBe(queuedSignature);
});
