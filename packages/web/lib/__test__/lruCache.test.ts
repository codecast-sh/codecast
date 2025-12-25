import { LRUCache } from '../lruCache';

describe('LRUCache', () => {
  it('should cache and retrieve values', () => {
    const cache = new LRUCache<string, number>(3);

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size()).toBe(3);
  });

  it('should evict oldest entry when max size exceeded', () => {
    const cache = new LRUCache<string, number>(2);

    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
    expect(cache.size()).toBe(2);
  });

  it('should move accessed item to end', () => {
    const cache = new LRUCache<string, number>(2);

    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
  });

  it('should clear all entries', () => {
    const cache = new LRUCache<string, number>(3);

    cache.set('a', 1);
    cache.set('b', 2);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('should handle complex keys', () => {
    const cache = new LRUCache<{ id: number; name: string }, string>(2);

    const key1 = { id: 1, name: 'foo' };
    const key2 = { id: 2, name: 'bar' };

    cache.set(key1, 'value1');
    cache.set(key2, 'value2');

    expect(cache.get({ id: 1, name: 'foo' })).toBe('value1');
    expect(cache.get({ id: 2, name: 'bar' })).toBe('value2');
  });
});
