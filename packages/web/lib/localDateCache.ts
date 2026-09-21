import { LRUCache } from "./lruCache";

export function cacheLocalDateFormat(format: (date: Date) => string): (ts: number) => string {
  const cache = new LRUCache<readonly [number, number, string], string>(512);
  return (ts) => {
    const date = new Date(ts);
    const key = [ts, date.getTimezoneOffset(), typeof navigator === "undefined" ? "" : navigator.language] as const;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const value = format(date);
    cache.set(key, value);
    return value;
  };
}
