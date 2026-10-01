import { describe, expect, test } from 'bun:test';

import { fillArgv, servedReadKey } from './served';

describe('served read keys', () => {
  test('the two vectors the guard asserts too', () => {
    expect(servedReadKey(['brief'])).toBe('5aade2e80f5dd74f765b32cf20b9954d5283af5331c34e0ad909d8a609cecbcf');
    expect(servedReadKey(['org', 'review', '--team', 'T'])).toBe('c3c8e1815ea12c65ef7b12528037651900c290fc2fe246959cf0beb491c3b04a');
  });

  test('matches the shell form the guard runs', () => {
    const argv = ['org', 'inputs', '--team', 'a b', '--json'];
    const r = Bun.spawnSync(['bash', '-c', `printf '%s\\x1f' "$@" | shasum -a 256 | cut -d' ' -f1`, 'x', ...argv]);
    expect(r.stdout.toString().trim()).toBe(servedReadKey(argv));
  });

  test('placeholders fill, and a missing one names itself', () => {
    expect(fillArgv(['org', 'ls', '--team', '{team}'], { team: 'T' })).toEqual(['org', 'ls', '--team', 'T']);
    expect(() => fillArgv(['org', 'ls', '--team', '{team}'], {})).toThrow('--team is required');
  });
});
