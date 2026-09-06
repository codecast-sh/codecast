import { createHash } from 'node:crypto';
import type { ParsedMessage, TranscriptEmission } from '../parser.js';

export function ingestReceiptSignature(message: ParsedMessage, source: TranscriptEmission): string {
  const timestamp = source.queued ? 0 : source.receiptTimestamp;
  const native = source.timestampPresent ? ['present', source.nativeTimestamp] : ['absent'];
  return createHash('sha256').update(JSON.stringify([native, { ...message, timestamp }])).digest('hex');
}
