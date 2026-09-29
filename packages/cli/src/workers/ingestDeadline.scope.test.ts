import { expect, test } from 'bun:test';
import { currentTranscriptDeadline, outsideTranscriptDeadline, withTranscriptDeadline } from './ingestDeadline.js';

const later = <T>(ms: number, read: () => T) => new Promise<T>(resolve => setTimeout(() => resolve(read()), ms));

// A daemon-wide loop first armed during an ingest kept that ingest's deadline
// in its async context; once it expired, every heartbeat flush threw before its
// fetch and the whole fleet read as stopped (2026-09-28).
test('a timer armed inside a transcript scope stops seeing the deadline once the scope returns', async () => {
  let seen!: Promise<unknown>;
  await withTranscriptDeadline(async () => { seen = later(120, currentTranscriptDeadline); }, { timeoutMs: 50 });
  expect(await seen).toBeUndefined();
});

test('the deadline stays current inside its own scope', async () => {
  await withTranscriptDeadline(async () => {
    expect(currentTranscriptDeadline()).toBeDefined();
    expect(await later(5, currentTranscriptDeadline)).toBeDefined();
  });
});

test('outsideTranscriptDeadline arms work with no deadline even while the scope is live', async () => {
  await withTranscriptDeadline(async () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const seen = new Promise(resolve => { timer = outsideTranscriptDeadline(() => setInterval(() => resolve(currentTranscriptDeadline()), 5)); });
    expect(await seen).toBeUndefined();
    clearInterval(timer);
  });
});
