import { describe, expect, test } from 'bun:test';

import { splitLineRef, toConvoMessages, toRows, type CliReadMessage } from './convo';

// /cli/read as conversations.readConversationLines returns it (synthetic).
const READ: CliReadMessage[] = [
  { id: 'msg-a', line: 1, role: 'user', content: 'rename the flag', timestamp: '2026-03-01T10:00:00.000Z', message_uuid: 'u-1' },
  { id: 'msg-b', line: 2, role: 'assistant', content: 'Renaming it now.', timestamp: '2026-03-01T10:00:05.000Z', tool_calls: [{ id: 't1', name: 'Edit', input: '{"file":"a.ts"}' }] },
  { line: 3, role: 'user', content: '', timestamp: '2026-03-01T10:00:09.000Z', tool_results: [{ tool_use_id: 't1', content: 'ok', is_error: false }] },
  { id: 'msg-d', line: 4, role: 'system', content: 'compacted', timestamp: '2026-03-01T10:01:00.000Z', tool_calls: [], tool_results: [] },
];

describe('toRows', () => {
  test('maps /cli/read messages to the stored row fields the selectors read', () => {
    expect(toRows(READ)).toEqual([
      { _id: 'msg-a', role: 'user', content: 'rename the flag', timestamp: Date.parse('2026-03-01T10:00:00.000Z'), message_uuid: 'u-1', line: 1 },
      { _id: 'msg-b', role: 'assistant', content: 'Renaming it now.', timestamp: Date.parse('2026-03-01T10:00:05.000Z'), tool_calls: [{ id: 't1', name: 'Edit', input: '{"file":"a.ts"}' }], line: 2 },
      { _id: 'line:3', role: 'user', content: '', timestamp: Date.parse('2026-03-01T10:00:09.000Z'), tool_results: [{ tool_use_id: 't1', content: 'ok', is_error: false }], line: 3 },
      { _id: 'msg-d', role: 'system', content: 'compacted', timestamp: Date.parse('2026-03-01T10:01:00.000Z'), line: 4 },
    ]);
  });

  test('rows become conversation messages the moment cut can read', () => {
    const msgs = toConvoMessages(toRows(READ));
    expect(msgs.map((m) => [m.n, m.direction, m.from, m.channel, m.at])).toEqual([
      [1, 'in', 'user', 'session', '2026-03-01T10:00:00.000Z'],
      [2, 'out', 'assistant', 'session', '2026-03-01T10:00:05.000Z'],
      [3, 'in', 'user', 'session', '2026-03-01T10:00:09.000Z'],
      [4, 'system', 'system', 'session', '2026-03-01T10:01:00.000Z'],
    ]);
    expect(msgs.every((m) => m.isGroup === false)).toBe(true);
  });

  test('line refs split; bare refs stay whole', () => {
    expect(splitLineRef('jx7c6zk:142')).toEqual({ conversation: 'jx7c6zk', line: 142 });
    expect(splitLineRef('jx7c6zk')).toEqual({ conversation: 'jx7c6zk', line: null });
  });
});
