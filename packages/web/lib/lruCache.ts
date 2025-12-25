export class LRUCache<K, V> {
  private cache: Map<string, { value: V; key: K }>;
  private maxSize: number;

  constructor(maxSize: number = 50) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const keyStr = this.serialize(key);
    const item = this.cache.get(keyStr);

    if (!item) {
      return undefined;
    }

    this.cache.delete(keyStr);
    this.cache.set(keyStr, item);

    return item.value;
  }

  set(key: K, value: V): void {
    const keyStr = this.serialize(key);

    this.cache.delete(keyStr);

    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(keyStr, { value, key });
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  private serialize(key: K): string {
    return JSON.stringify(key);
  }
}
