import { expect, spyOn, test } from 'bun:test';
import { parseTranscriptFor, type ParsedMessage, type TranscriptEmission } from './parser.js';

test('Claude emission provenance follows UTF-8 source occurrences through filtering and preserves output', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const records = [
      '',
      JSON.stringify({ type: 'summary', summary: 'ignored emoji 🐈' }),
      '42',
      '"ignored primitive"',
      JSON.stringify({ type: 'assistant', message: { content: 'identical 🐈' } }),
      JSON.stringify({ type: 'assistant', isMeta: true, message: { content: 'filtered' } }),
      JSON.stringify({ type: 'assistant', timestamp: '', message: { content: 'identical 🐈' } }),
      JSON.stringify({ type: 'system', subtype: 'local_command', content: 'system' }),
      JSON.stringify({ type: 'user', timestamp: '2026-09-05T12:00:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: [{ type: 'image', source: { media_type: 'image/png', data: 'aW1hZ2U=' } }] }] } }),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', content: 'queued', timestamp: '2026-09-05T13:00:00Z' }),
      JSON.stringify({ type: 'attachment', timestamp: '2026-09-05T12:00:00Z', attachment: { type: 'queued_command', prompt: 'queued' } }),
    ];
    const content = records.join('\n') + '\n', observed: Array<{ message: ParsedMessage; source: TranscriptEmission }> = [];
    const output = parseTranscriptFor('claude', content, (message, source) => observed.push({ message, source }));
    expect(output).toEqual(parseTranscriptFor('claude', content));
    expect(observed.map(row => row.message)).toEqual(output);
    expect(observed.every((row, i) => row.message === output[i])).toBe(true);
    const offsets = records.map((_, i) => Buffer.byteLength(records.slice(0, i).join('\n')) + (i ? 1 : 0));
    expect(observed.map(row => row.source.occurrence)).toEqual([4, 6, 7, 8, 10].map(i => offsets[i]));
    expect(observed[0].source.timestampPresent).toBe(false);
    expect(observed[1].source.timestampPresent).toBe(true);
    expect(observed[1].source.nativeTimestamp).toBe('');
    expect(observed.slice(0, 3).map(row => row.source.receiptTimestamp)).toEqual([0, 0, 0]);
    expect(output[3].images?.length).toBe(1);
    expect(output[4].timestamp).toBe(2_000_000_000_000);
    expect(observed[4].source.receiptTimestamp).toBe(Date.parse('2026-09-05T13:00:00Z'));
    expect(observed[4].source.dequeue?.nativeTimestamp).toBe('2026-09-05T13:00:00Z');
    const tailFacts: TranscriptEmission[] = [];
    const tail = parseTranscriptFor('claude', records[10] + '\n', (_, source) => tailFacts.push(source));
    expect(tail[0].timestamp).toBe(Date.parse('2026-09-05T12:00:00Z'));
    expect(tailFacts[0].nativeTimestamp).toBe(observed[4].source.nativeTimestamp);
    expect(tailFacts[0].receiptTimestamp).not.toBe(observed[4].source.receiptTimestamp);
  } finally { clock.mockRestore(); }
});

test('Gemini emission provenance retains raw ordinal and native timestamp text without changing coalesced output', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(2_000_000_000_000);
  try {
    const content = JSON.stringify({ messages: [
      { type: 'info', content: 'ignored' },
      { type: 'gemini', content: 'identical' },
      { type: 'gemini', content: '' },
      { type: 'gemini', content: 'identical', timestamp: '' },
      { type: 'gemini', timestamp: '2026-09-05T12:00:00Z', toolCalls: [{ id: 'one', name: 'tool', args: { nested: { value: '🐈' } }, status: 'success', result: { value: 'nested' } }, { id: 'two', name: 'tool', status: 'error', result: 'failed' }] },
      { type: 'gemini', content: 'native text', timestamp: '2026-09-05T08:00:00-04:00' },
    ] });
    const facts: TranscriptEmission[] = [];
    const output = parseTranscriptFor('gemini', content, (_, source) => facts.push(source));
    expect(output).toEqual(parseTranscriptFor('gemini', content));
    expect(facts.map(source => source.occurrence)).toEqual([1, 3, 4, 5]);
    expect(facts[0].timestampPresent).toBe(false);
    expect(facts[1].timestampPresent).toBe(true);
    expect(facts[1].nativeTimestamp).toBe('');
    expect(output[2].toolCalls?.length).toBe(2);
    expect(output[2].toolResults?.length).toBe(2);
    expect(output[2].timestamp).toBe(output[3].timestamp);
    expect(facts[2].nativeTimestamp).not.toBe(facts[3].nativeTimestamp);
  } finally { clock.mockRestore(); }
});
