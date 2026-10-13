import { describe, expect, test } from 'bun:test';
import { foldToolRuns } from './toolRuns';

let n = 0;
const call = (name: string, input: Record<string, unknown> = {}) => ({ id: `t${++n}`, name, input: JSON.stringify(input) });
const said = (_id: string, content: string, ...tool_calls: ReturnType<typeof call>[]) => ({ _id, role: 'assistant', content, tool_calls });
const tools = (_id: string, ...tool_calls: ReturnType<typeof call>[]) => ({ _id, role: 'assistant', content: '', tool_calls });
const person = (_id: string, content: string) => ({ _id, role: 'user', content });
const result = (_id: string) => ({ _id, role: 'user', content: '', carrier: true });
const skip = (m: { carrier?: boolean }) => !!m.carrier;

describe('foldToolRuns', () => {
  test('a reply and the tool-only messages after it fold into one run headed by the reply', () => {
    const runs = foldToolRuns([
      person('u1', 'fix it'),
      said('a1', 'Looking.', call('Bash', { command: 'git status' })),
      result('r1'),
      tools('a2', call('Read', { file_path: '/x/a.ts' })),
      result('r2'),
      tools('a3', call('Bash', { command: 'bun test' })),
      said('a4', 'Done.'),
    ], skip);
    const run = runs.get('a1')!;
    expect(run.head).toBe('a1');
    expect(run.members).toEqual(['a1', 'a2', 'a3']);
    expect(run.steps).toBe(3);
    expect(run.summary).toBe('ran 2 commands · read 1 file');
    expect(runs.get('a3')).toBe(run);
    expect(runs.has('a4')).toBe(false);
    expect(runs.has('u1')).toBe(false);
  });

  test('a person, a new reply, or a card-drawing call closes the run', () => {
    const runs = foldToolRuns([
      tools('a1', call('Bash', { command: 'ls' }), call('Bash', { command: 'pwd' })),
      person('u1', 'and?'),
      tools('a2', call('Read', { file_path: '/a' })),
      said('a3', 'Next.', call('Read', { file_path: '/b' }), call('Read', { file_path: '/c' })),
      tools('a4', call('TodoWrite')),
      tools('a5', call('Read', { file_path: '/d' })),
    ], skip);
    expect(runs.get('a1')!.members).toEqual(['a1']);
    expect(runs.get('a2')!.members).toEqual(['a2']);
    expect(runs.get('a3')!.members).toEqual(['a3']);
    expect(runs.has('a4')).toBe(false);
    expect(runs.get('a5')!.members).toEqual(['a5']);
  });

  test('reasoning between calls stays inside the run; reasoning alone is left as it is', () => {
    const thought = (_id: string) => ({ _id, role: 'assistant', content: '', thinking: 'hmm', tool_calls: [] });
    const runs = foldToolRuns([
      said('a1', 'Looking.', call('Bash', { command: 'ls' })),
      thought('t1'),
      tools('a2', call('Bash', { command: 'pwd' })),
      said('a3', 'Done.'),
      thought('t2'),
      said('a4', 'Also.'),
    ], skip);
    expect(runs.get('a1')!.members).toEqual(['a1', 't1', 'a2']);
    expect(runs.has('t2')).toBe(false);
  });

  test('a lone call reads as what it ran', () => {
    const runs = foldToolRuns([said('a1', 'Checking.', call('Bash', { command: 'cd /repo && npx tsc --noEmit' })), said('a2', 'Fine.')], skip);
    expect(runs.get('a1')!.summary).toBe('ran npx tsc');
  });
});
