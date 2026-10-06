const cache = new WeakMap<object, boolean>();

export function hasCollectionRows(collection: Record<string, unknown>): boolean {
  const cached = cache.get(collection);
  if (cached !== undefined) return cached;
  const result = Object.keys(collection).length > 0;
  cache.set(collection, result);
  return result;
}
