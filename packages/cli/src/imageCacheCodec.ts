export interface CachedImageUpload {
  storageId: string;
  url: string;
  at: number;
}

export type ImageCacheOperation = { action: 'hash' | 'path'; key: string } | { action: 'store'; hash: string; absPath?: string; storageId: string; url: string; at: number };

function readCache(bytes: Buffer) {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    return { byHash: parsed.byHash ?? {}, byPath: parsed.byPath ?? {} };
  } catch {
    return { byHash: {}, byPath: {} };
  }
}

function prune(map: Record<string, CachedImageUpload>): Record<string, CachedImageUpload> {
  const entries = Object.entries(map);
  if (entries.length <= 500) return map;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, 500));
}

export function transformImageCache(bytes: Buffer, operation: ImageCacheOperation): unknown {
  const cache = readCache(bytes);
  if (operation.action !== 'store') return (operation.action === 'hash' ? cache.byHash : cache.byPath)[operation.key] ?? null;
  const entry = { storageId: operation.storageId, url: operation.url, at: operation.at };
  cache.byHash[operation.hash] = entry;
  if (operation.absPath) cache.byPath[operation.absPath] = entry;
  cache.byHash = prune(cache.byHash);
  cache.byPath = prune(cache.byPath);
  return Buffer.from(JSON.stringify(cache));
}
