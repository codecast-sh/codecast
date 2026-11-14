// What happened to this window's disk cache, kept where it can be read after
// the fact. A cache that vanished or was purged left no trace before this:
// the desktop app keeps no renderer console on disk, so on 2026-11-13 a full
// wipe and refill could only be reconstructed from Chromium's own leveldb LOG,
// and which code path deleted the database stayed a guess.
//
// Every event goes three places: the console, a small ring buffer in
// localStorage (read it with `__cacheEvents()` in any window of the origin,
// and it survives the reload that usually follows), and Sentry for the kinds
// that mean the cache was lost or destroyed.
import { captureMessage } from "@sentry/react";

export type CacheEventKind =
  // The app deleted the database (detail.reason says why).
  | "purge"
  // The ownership check could not read the disk: nothing served, nothing purged.
  | "ownership-unreadable"
  // Dexie created the database from nothing. After this window had already
  // read a populated cache, the store was lost underneath it.
  | "db-created"
  // The connection closed without this window closing it (the browser
  // force-closed the backing store).
  | "db-closed"
  // Another connection asked this one to close (an upgrade or a delete).
  | "db-versionchange"
  // Opening the database failed.
  | "db-open-failed";

export type CacheEvent = { kind: CacheEventKind; at: string; path: string; detail: Record<string, unknown> };

export const CACHE_EVENTS_STORAGE_KEY = "codecast:cache-events";
const MAX_EVENTS = 50;
// Kinds that mean cached data was lost or destroyed: worth a server report.
const REPORTED: ReadonlySet<CacheEventKind> = new Set(["purge", "ownership-unreadable", "db-created", "db-closed", "db-open-failed"]);

function storage(): Pick<Storage, "getItem" | "setItem"> | null {
  try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; }
}

export function readCacheEvents(): CacheEvent[] {
  try {
    const raw = storage()?.getItem(CACHE_EVENTS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordCacheEvent(kind: CacheEventKind, detail: Record<string, unknown> = {}, opts?: { report?: boolean }): void {
  const event: CacheEvent = {
    kind,
    at: new Date().toISOString(),
    // Which window: the desktop app runs the palette, call ring, agent dock
    // and others as separate full-app windows on the same origin.
    path: typeof location !== "undefined" ? location.pathname : "",
    detail,
  };
  console.warn(`[cache] ${kind}`, detail);
  try {
    const events = readCacheEvents();
    events.push(event);
    storage()?.setItem(CACHE_EVENTS_STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // A full or blocked localStorage loses the record, never the caller.
  }
  if (opts?.report ?? REPORTED.has(kind)) {
    try {
      captureMessage(`cache ${kind}`, { level: "warning", tags: { source: "idb-cache", cache_event: kind }, extra: { ...detail, path: event.path } });
    } catch {
      // Reporting is best effort.
    }
  }
}

if (typeof window !== "undefined") (window as any).__cacheEvents = readCacheEvents;
