import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveCorrection } from '../../corrections/store';
import impl, { actionsOf, assertIsolated, firstDecisive, type GuidanceLabel } from './index';

const line = (o: unknown) => JSON.stringify(o);

function runDir(events: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'guidance-'));
  writeFileSync(join(dir, 'stream.jsonl'), events.map(line).join('\n'));
  return dir;
}

const use = (name: string, input: Record<string, unknown>, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', id: name, name, input }] } });

describe('guidance actions', () => {
  test('reads top-level tool calls in order, a shell call as its command, and skips subagent calls', () => {
    const dir = runDir([use('Read', { file_path: '/x' }), use('Bash', { command: 'cast spawn --subagent -- "a"' }), use('Grep', { pattern: 'y' }, 'toolu_parent')]);
    expect(actionsOf({ runSubdir: dir })).toEqual(['Read: {"file_path":"/x"}', 'Bash: cast spawn --subagent -- "a"']);
  });

  test('the first wanted or avoided action decides; neutral reads before it do not', () => {
    const label: GuidanceLabel = { want: ['cast\\s+trigger\\s+add\\b'], avoid: ['^ScheduleWakeup:'] };
    expect(firstDecisive(['Bash: gh run list', 'Bash: cast trigger add "x" --in 30m', 'ScheduleWakeup: {}'], label)).toEqual({ action: 'Bash: cast trigger add "x" --in 30m', wanted: true });
    expect(firstDecisive(['ScheduleWakeup: {"delaySeconds":1800}', 'Bash: cast trigger add "x"'], label)?.wanted).toBe(false);
    expect(firstDecisive(['Bash: gh run list'], label)).toBeNull();
  });

  test("every fixture's label compiles and names a want or a reply", () => {
    const dir = join(import.meta.dir, '../../../fixtures/guidance');
    for (const file of readdirSync(dir)) {
      const { label } = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { label: GuidanceLabel };
      for (const p of [...label.want, ...(label.avoid ?? []), ...(label.reply ? [label.reply] : [])]) expect(() => new RegExp(p, 'i')).not.toThrow();
      expect(`${file} ${label.want.length > 0 || Boolean(label.reply)}`).toBe(`${file} true`);
    }
  });
});

describe('guidance capture', () => {
  test('a drafted correction captures as its request, one subject per line, and an undrafted one is refused', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guidance-home-'));
    const prev = process.env.CODECAST_EVALS_HOME;
    process.env.CODECAST_EVALS_HOME = home;
    try {
      const base = { conversation: 'tst0000000000000000000000000000a', messageId: 'm1', at: '2026-01-02T03:04:00.000Z', title: 'Invoice export', before: '', said: 'no, export it yourself' };
      saveCorrection({ ...base, id: 'tst0000000000000000000000000000a:518', line: 518, status: 'drafted', draft: { rule: 'Run the steps within your reach.', request: 'Export last month as CSV.', want: ['export'], avoid: [], criteria: 'It runs the export itself.' } });
      saveCorrection({ ...base, id: 'tst0000000000000000000000000000a:367', line: 367, status: 'not-guidance' });
      const got = await impl.capture(`${base.conversation}:518`, { readConversation: async () => null });
      expect(got.snapshot).toEqual({ captured_at: base.at, request: 'Export last month as CSV.', correction: { conversation: base.conversation, line: 518, said: 'no, export it yourself', rule: 'Run the steps within your reach.' } });
      expect(got.subject.id).toBe(`${base.conversation}:518`);
      expect(got.anchor).toEqual({ kind: 'message', id: 'm1' });
      await expect(impl.capture(`${base.conversation}:367`, { readConversation: async () => null })).rejects.toThrow('no drafted correction');
    } finally {
      if (prev === undefined) delete process.env.CODECAST_EVALS_HOME;
      else process.env.CODECAST_EVALS_HOME = prev;
    }
  });
});

describe('guidance isolation', () => {
  test('a replay refuses unless the harness answers isolated', () => {
    expect(() => assertIsolated(() => 'not isolated: no sandbox-exec')).toThrow('refusing to run an agent with tools');
  });
});
