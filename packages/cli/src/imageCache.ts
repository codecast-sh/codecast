// Persistent upload cache for shared images (~/.codecast/image-cache.json).
//
// The same screenshot gets shared more than once — a `cast image` retried by an
// agent, a watch loop, or the daemon's link-rescue pass re-syncing a message.
// Without a durable cache each pass mints a new storage object and a new URL,
// so message text flips between URLs across daemon restarts and storage fills
// with duplicates. Keyed two ways:
//   - by content hash (sha256 of the bytes) — the authoritative dedup;
//   - by absolute path — a fallback for the daemon's rescue pass when the file
//     has since been deleted (temp screenshots are short-lived) and the bytes
//     can no longer be read. Last-known URL for that exact path wins.
//
// Respected by both the CLI command (imageCommand.ts) and the daemon
// (syncService link rescue), so this module must stay importable by daemon.ts
// (no index.ts imports — it runs program.parse() on import).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface CachedUpload {
  storageId: string;
  url: string;
  at: number;
}

interface ImageCacheFile {
  byHash: Record<string, CachedUpload>;
  byPath: Record<string, CachedUpload>;
}

const MAX_ENTRIES = 500;

function cacheFilePath(): string {
  const dir = process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
  return path.join(dir, "image-cache.json");
}

export function hashImageBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readCache(): ImageCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFilePath(), "utf-8"));
    return {
      byHash: parsed.byHash ?? {},
      byPath: parsed.byPath ?? {},
    };
  } catch {
    return { byHash: {}, byPath: {} };
  }
}

/** Drop oldest entries beyond the cap so the file can't grow unbounded. */
function prune(map: Record<string, CachedUpload>): Record<string, CachedUpload> {
  const entries = Object.entries(map);
  if (entries.length <= MAX_ENTRIES) return map;
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_ENTRIES));
}

export function lookupByHash(hash: string): CachedUpload | null {
  return readCache().byHash[hash] ?? null;
}

export function lookupByPath(absPath: string): CachedUpload | null {
  return readCache().byPath[absPath] ?? null;
}

export function storeUpload(opts: { hash: string; absPath?: string; storageId: string; url: string }): void {
  const cache = readCache();
  const entry: CachedUpload = { storageId: opts.storageId, url: opts.url, at: Date.now() };
  cache.byHash[opts.hash] = entry;
  if (opts.absPath) cache.byPath[opts.absPath] = entry;
  cache.byHash = prune(cache.byHash);
  cache.byPath = prune(cache.byPath);
  const file = cacheFilePath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cache), { mode: 0o600 });
  } catch {
    // Cache is an optimization — never fail an upload over it.
  }
}
