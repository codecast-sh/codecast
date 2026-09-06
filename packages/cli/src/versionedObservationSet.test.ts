import { expect, test } from 'bun:test';
import { VersionedObservationSet } from './versionedObservationSet.js';

test('observation consumption preserves Set contracts and newer same-key additions', () => {
  const values = new VersionedObservationSet(['a', 'b', 'a']);
  expect([...values]).toEqual(['a', 'b']);
  expect(values.size).toBe(2);
  expect([...values.keys()]).toEqual([...values.values()]);
  expect([...values.entries()]).toEqual([['a', 'a'], ['b', 'b']]);
  const visited: unknown[] = [];
  values.forEach((value, key, set) => visited.push([value, key, set === values]));
  expect(visited).toEqual([['a', 'a', true], ['b', 'b', true]]);
  const first = values.capture('a');
  expect(values.add('a')).toBe(values);
  expect(values.consume('a', first)).toBe(false);
  expect(values.has('a')).toBe(true);
  expect(values.consume('a', values.capture('a'))).toBe(true);
  expect(values.delete('a')).toBe(false);
  expect(values.consume('a', undefined)).toBe(false);
  for (const operation of ['delete', 'clear']) {
    values.add('a');
    const captured = values.capture('a');
    if (operation === 'delete') expect(values.delete('a')).toBe(true);
    else expect(values.clear()).toBeUndefined();
    values.add('a');
    expect(values.consume('a', captured)).toBe(false);
    expect(values.consume('a', values.capture('a'))).toBe(true);
  }
  values.clear();
  expect(values.size).toBe(0);
  expect(values.capture('b')).toBeUndefined();
});
