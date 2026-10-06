// Per-device preferences in localStorage, JSON encoded, never throwing (a
// private window or a full quota just forgets).
export function load<T>(key: string, fallback: T, store: Storage = localStorage): T {
  try {
    const raw = store.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown, store: Storage = localStorage): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* forgetting a preference is fine */
  }
}
