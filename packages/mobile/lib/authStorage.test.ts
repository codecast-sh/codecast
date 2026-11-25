import { describe, expect, it } from 'bun:test';
import { createAuthStorage, type ForegroundSignal } from './authStorage';

function foreground(initial: string) {
  let state = initial;
  const listeners = new Set<(s: string) => void>();
  const signal: ForegroundSignal = {
    current: () => state,
    onChange: (l) => {
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    },
  };
  const set = (next: string) => {
    state = next;
    for (const l of [...listeners]) l(next);
  };
  return { signal, set, listeners };
}

function keychain(locked: () => boolean, items: Record<string, string>) {
  return {
    getItemAsync: async (k: string) => {
      if (locked()) throw new Error('User interaction is not allowed.');
      return items[k] ?? null;
    },
    setItemAsync: async (k: string, v: string) => { items[k] = v; },
    deleteItemAsync: async (k: string) => { delete items[k]; },
  };
}

describe('createAuthStorage', () => {
  it('waits for the foreground when the keychain is locked, then reads the token', async () => {
    const fg = foreground('background');
    const storage = createAuthStorage(keychain(() => fg.signal.current() !== 'active', { jwt: 't' }), fg.signal);
    let result: string | null | undefined;
    const read = storage.getItem('jwt').then((v) => { result = v; });
    await Promise.resolve();
    await Promise.resolve();
    expect(result).toBeUndefined();
    fg.set('inactive');
    await Promise.resolve();
    expect(result).toBeUndefined();
    fg.set('active');
    await read;
    expect(result).toBe('t');
    expect(fg.listeners.size).toBe(0);
  });

  it('answers null for a read that fails in the foreground', async () => {
    const fg = foreground('active');
    const storage = createAuthStorage(keychain(() => true, { jwt: 't' }), fg.signal);
    expect(await storage.getItem('jwt')).toBeNull();
  });

  it('reads normally when the keychain is open', async () => {
    const fg = foreground('background');
    const storage = createAuthStorage(keychain(() => false, { jwt: 't' }), fg.signal);
    expect(await storage.getItem('jwt')).toBe('t');
    expect(await storage.getItem('missing')).toBeNull();
  });
});
