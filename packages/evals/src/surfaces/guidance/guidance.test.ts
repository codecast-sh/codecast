import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { actionsOf, firstDecisive, type GuidanceLabel } from './index';

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
