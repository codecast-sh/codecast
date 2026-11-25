// No React Native import here, so bun can test it: the caller passes the
// keychain and the app's foreground state (app/_layout.tsx).

export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface ForegroundSignal {
  current: () => string;
  onChange: (listener: (state: string) => void) => { remove: () => void };
}

function untilActive(signal: ForegroundSignal): Promise<void> {
  if (signal.current() === 'active') return Promise.resolve();
  return new Promise((resolve) => {
    const sub = signal.onChange((state) => {
      if (state !== 'active') return;
      sub.remove();
      resolve();
    });
  });
}

// The token store @convex-dev/auth reads and writes.
//
// A failed read must never be reported as "no token". The tokens are kept
// WHEN_UNLOCKED, so a read while the phone is locked (the app woken in the
// background by a push or a call) throws; answering null there made the
// library treat a live session as gone and sign the phone out. Such a read
// waits until the app is in the foreground, where the keychain is open, and
// tries again.
//
// A read that fails in the foreground degrades to null: a rejected getItem
// propagates into the library's boot read, which is fired as
// `void readStateFromStorage()`, so the rejection is swallowed, isLoading stays
// true forever, and the person is stuck on the skeleton inbox with no way to
// reach the login screen.
export function createAuthStorage(store: KeyValueStore, foreground: ForegroundSignal) {
  return {
    getItem: async (key: string): Promise<string | null> => {
      try {
        return await store.getItemAsync(key);
      } catch {
        if (foreground.current() === 'active') return null;
        await untilActive(foreground);
        try {
          return await store.getItemAsync(key);
        } catch {
          return null;
        }
      }
    },
    setItem: async (key: string, value: string) => {
      try {
        await store.setItemAsync(key, value);
      } catch {}
    },
    removeItem: async (key: string) => {
      try {
        await store.deleteItemAsync(key);
      } catch {}
    },
  };
}
