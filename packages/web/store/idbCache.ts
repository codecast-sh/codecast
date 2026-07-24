import type { Patch } from "mutative";
import {
  COLLECTION_STORE_KEYS,
  META_STORE_KEYS,
  collectionRowValidator,
  isPersistedClientStoreKey,
} from "./clientSyncRegistry";
import { diffCollection } from "./idbCollectionDiff";
import { isConvexId } from "../lib/entityLinks";
import {
  PrincipalStoreFenceError,
  type LegacyOutboxRecord,
  type PrincipalStoreAdapter,
  type PrincipalStoreFence,
  type StoreOperation,
} from "./local-first/persistence/adapter";
import type { PrincipalEpoch, PrincipalId } from "./local-first/types";

export type OutboxEntry = {
  id: string;
  action: string;
  args: any;
  patches: any;
  result: any;
  ts: number;
  attempts?: number;
};

export const PERSISTENCE_AVAILABLE =
  typeof window !== "undefined" && typeof indexedDB !== "undefined";
export const PRINCIPAL_SCOPED_PERSISTENCE = true;

// v2 uses a generic, typed compatibility table, so registry growth no longer
// requires a Dexie schema bump per legacy collection.
export const MISSING_COLLECTION_TABLES: string[] = [];

type PrincipalCacheBinding = {
  adapter: PrincipalStoreAdapter;
  fence: PrincipalStoreFence;
  principalId: PrincipalId;
  principalEpoch: PrincipalEpoch;
  acceptingWrites: boolean;
};

let binding: PrincipalCacheBinding | null = null;
let _hydrating = false;
let writeQueue: Promise<void> = Promise.resolve();
let persistenceErrorHandler: ((error: unknown) => void) | null = null;

const lastPersisted = new Map<string, Map<string, any>>();

export function bindPrincipalCache(next: Omit<PrincipalCacheBinding, "acceptingWrites">): void {
  binding = { ...next, acceptingWrites: true };
  _hydrating = true;
  lastPersisted.clear();
  _pendingMsgWrites.clear();
}

export function suspendPrincipalCache(expectedEpoch?: PrincipalEpoch): void {
  if (!binding || (expectedEpoch !== undefined && binding.principalEpoch !== expectedEpoch)) return;
  binding.acceptingWrites = false;
}

export function unbindPrincipalCache(expectedEpoch?: PrincipalEpoch): void {
  if (expectedEpoch !== undefined && binding?.principalEpoch !== expectedEpoch) return;
  binding = null;
  _hydrating = false;
  lastPersisted.clear();
  _pendingMsgWrites.clear();
  if (_msgWriteTimer) {
    clearTimeout(_msgWriteTimer);
    _msgWriteTimer = null;
  }
}

export function getBoundPrincipalEpoch(): PrincipalEpoch | null {
  return binding?.principalEpoch ?? null;
}

export function setPrincipalPersistenceErrorHandler(
  handler: ((error: unknown) => void) | null,
): void {
  persistenceErrorHandler = handler;
}

export function _resetPersistedShadow() {
  lastPersisted.clear();
}

export function isPersistedStoreKey(key: string): boolean {
  return isPersistedClientStoreKey(key);
}

function requireBinding(): PrincipalCacheBinding {
  if (!binding) throw new PrincipalStoreFenceError("No principal store is bound");
  if (!binding.acceptingWrites) throw new PrincipalStoreFenceError("Principal store writes are suspended");
  return binding;
}

function legacyCollectionKey(collection: string, rowId: string): string {
  return `${collection}\0${rowId}`;
}

function stillBound(captured: PrincipalCacheBinding): void {
  if (binding !== captured) throw new PrincipalStoreFenceError("Principal changed during persistence");
}

export function writePatchesToIDB(patches: Patch[], state: any): Promise<void> {
  if (_hydrating || !binding || !binding.acceptingWrites) return Promise.resolve();
  const captured = binding;
  const affectedKeys = new Set<string>();
  for (const patch of patches) {
    const path = patch.path as (string | number)[];
    if (path.length > 0) affectedKeys.add(String(path[0]));
  }

  writeQueue = writeQueue.catch(() => {}).then(async () => {
    stillBound(captured);
    const operations: StoreOperation[] = [];
    const nextShadows = new Map<string, Map<string, any>>();
    for (const key of affectedKeys) {
      if ((COLLECTION_STORE_KEYS as readonly string[]).includes(key)) {
        const data = state[key];
        if (!data || typeof data !== "object") continue;
        const prevShadow = lastPersisted.get(key);
        const { puts, deletes: rawDeletes, next } = diffCollection(prevShadow, data);
        const pending = (state.pending || {}) as Record<string, { type?: string }>;
        for (const id of rawDeletes) {
          if (pending[`${key}:${id}`]?.type === "exclude") {
            operations.push({ kind: "delete-legacy-collection", key: legacyCollectionKey(key, id) });
          } else if (prevShadow?.has(id)) {
            next.set(id, prevShadow.get(id));
          }
        }
        for (const row of puts) {
          operations.push({
            kind: "put-legacy-collection",
            record: {
              key: legacyCollectionKey(key, String(row._id)),
              collection: key,
              rowId: String(row._id),
              value: row,
            },
          });
        }
        nextShadows.set(key, next);
      } else if ((META_STORE_KEYS as readonly string[]).includes(key)) {
        operations.push({ kind: "put-legacy-meta", record: { key, value: state[key] } });
      }
    }
    if (operations.length === 0) return;
    await captured.adapter.commit(captured.fence, operations, () => stillBound(captured));
    for (const [key, shadow] of nextShadows) lastPersisted.set(key, shadow);
  }).catch((error) => {
    persistenceErrorHandler?.(error);
    throw error;
  });
  return writeQueue;
}

const SESSION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED_SESSIONS = 1200;

export function partitionSessionRetention(
  rows: any[],
  liveInboxIdList: string[] | undefined,
  lastFocusedId: string | null | undefined,
  now: number,
): { keep: any[]; drop: string[] } {
  const liveIds = new Set(liveInboxIdList ?? []);
  const pinnedKeep: any[] = [];
  const windowed: any[] = [];
  const drop: string[] = [];
  for (const row of rows) {
    const stampedAt = Math.max(
      row.updated_at ?? 0,
      row._creationTime ?? 0,
      row.inbox_stashed_at ?? 0,
      row.inbox_dismissed_at ?? 0,
    );
    if (liveIds.has(row._id) || row._id === lastFocusedId || !isConvexId(row._id) || row.is_pinned) {
      pinnedKeep.push(row);
    } else if (now - stampedAt <= SESSION_CACHE_TTL_MS) {
      windowed.push(row);
    } else {
      drop.push(row._id);
    }
  }
  if (windowed.length > MAX_CACHED_SESSIONS) {
    windowed.sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
    for (const row of windowed.splice(MAX_CACHED_SESSIONS)) drop.push(row._id);
  }
  return { keep: pinnedKeep.concat(windowed), drop };
}

export function expireExcludeTombstones(
  pending: Record<string, any>,
  now: number,
): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, entry] of Object.entries(pending)) {
    if (entry?.type === "exclude") {
      if (!entry.ts) { cleaned[key] = { ...entry, ts: now }; continue; }
      if (now - entry.ts > SESSION_CACHE_TTL_MS) continue;
    }
    cleaned[key] = entry;
  }
  return cleaned;
}

export async function loadCache(): Promise<Record<string, any> | null> {
  const captured = binding;
  if (!captured) return null;
    const snapshot = await captured.adapter.readLegacyCache(captured.fence);
    stillBound(captured);
    const result: Record<string, any> = { ...snapshot.meta };
    let hasData = Object.keys(snapshot.meta).length > 0;
    const cleanup: StoreOperation[] = [];
    for (const key of COLLECTION_STORE_KEYS) {
      let rows: any[] = Object.values(snapshot.collections[key] ?? {}) as any[];
      const validRow = collectionRowValidator(key);
      const valid: any[] = [];
      for (const row of rows) {
        const rowId = String((row as any)?._id ?? "");
        if (!rowId || (validRow && !validRow(row))) {
          if (rowId) cleanup.push({ kind: "delete-legacy-collection", key: legacyCollectionKey(key, rowId) });
          continue;
        }
        valid.push(row);
      }
      rows = valid;
      if (key === "sessions" && rows.length) {
        const retained = partitionSessionRetention(
          rows,
          snapshot.meta.liveInboxIdList as string[] | undefined,
          snapshot.meta.lastFocusedConversationId as string | null | undefined,
          Date.now(),
        );
        rows = retained.keep;
        for (const id of retained.drop) {
          cleanup.push({ kind: "delete-legacy-collection", key: legacyCollectionKey(key, id) });
        }
      }
      const map: Record<string, any> = {};
      const shadow = new Map<string, any>();
      for (const row of rows) {
        map[row._id] = row;
        shadow.set(row._id, row);
      }
      lastPersisted.set(key, shadow);
      if (rows.length) {
        result[key] = map;
        hasData = true;
      }
    }

    if (result.conversations && typeof result.conversations === "object") {
      const { keep } = partitionSessionRetention(
        Object.values(result.conversations),
        snapshot.meta.liveInboxIdList as string[] | undefined,
        snapshot.meta.lastFocusedConversationId as string | null | undefined,
        Date.now(),
      );
      result.conversations = Object.fromEntries(keep.map((row) => [row._id, row]));
    }
    if (result.pending && typeof result.pending === "object") {
      result.pending = expireExcludeTombstones(result.pending, Date.now());
    }
    if (cleanup.length) {
      await captured.adapter.commit(captured.fence, cleanup, () => stillBound(captured));
    }
    return hasData ? result : null;
}

export function setHydrating(value: boolean) {
  _hydrating = value;
}

const _pendingMsgWrites = new Map<string, { messages: any[]; pagination: any }>();
let _msgWriteTimer: ReturnType<typeof setTimeout> | null = null;
const MSG_WRITE_DEBOUNCE_MS = 300;

function latestTimestamp(messages: any[]): number {
  let latest = 0;
  for (const message of messages) {
    const timestamp = message?.timestamp || 0;
    if (timestamp > latest) latest = timestamp;
  }
  return latest;
}

function flushMessageWritesFor(captured: PrincipalCacheBinding | null): Promise<void> {
  if (_msgWriteTimer) {
    clearTimeout(_msgWriteTimer);
    _msgWriteTimer = null;
  }
  if (!captured || binding !== captured || _pendingMsgWrites.size === 0) return Promise.resolve();
  const batch = [..._pendingMsgWrites.entries()];
  return captured.adapter.commit(
    captured.fence,
    batch.map(([conversationId, value]) => ({
      kind: "put-conversation-messages" as const,
      record: {
        conversationId,
        messages: value.messages,
        pagination: value.pagination,
        latestTimestamp: latestTimestamp(value.messages),
      },
    })),
    () => stillBound(captured),
  ).then(() => {
    for (const [conversationId, value] of batch) {
      if (_pendingMsgWrites.get(conversationId) === value) {
        _pendingMsgWrites.delete(conversationId);
      }
    }
  });
}

export function flushConversationMessages(): Promise<void> {
  return flushMessageWritesFor(binding);
}

/**
 * Explicit purge policy for the temporary message compatibility buffer. This
 * is never used for account switching and never touches the durable command or
 * dispatch journals. The caller must already have synchronously gated memory.
 */
export function discardConversationMessageWrites(expectedEpoch?: PrincipalEpoch): void {
  if (expectedEpoch !== undefined && binding?.principalEpoch !== expectedEpoch) return;
  _pendingMsgWrites.clear();
  if (_msgWriteTimer) {
    clearTimeout(_msgWriteTimer);
    _msgWriteTimer = null;
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => {
    void flushConversationMessages().catch((error) => persistenceErrorHandler?.(error));
  });
  window.addEventListener("visibilitychange", () => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void flushConversationMessages().catch((error) => persistenceErrorHandler?.(error));
    }
  });
}

export async function loadConversationMessages(
  conversationId: string,
): Promise<{ messages: any[]; pagination: any; latestTimestamp: number } | null> {
  const pending = _pendingMsgWrites.get(conversationId);
  if (pending) {
    return {
      messages: pending.messages,
      pagination: pending.pagination,
      latestTimestamp: latestTimestamp(pending.messages),
    };
  }
  const captured = binding;
  if (!captured) return null;
  try {
    const row = await captured.adapter.readConversationMessages(captured.fence, conversationId);
    stillBound(captured);
    return row ? {
      messages: row.messages,
      pagination: row.pagination,
      latestTimestamp: row.latestTimestamp,
    } : null;
  } catch (error) {
    persistenceErrorHandler?.(error);
    throw error;
  }
}

export function writeConversationMessages(conversationId: string, messages: any[], pagination: any) {
  if (_hydrating || !binding || !binding.acceptingWrites) return;
  _pendingMsgWrites.set(conversationId, { messages, pagination });
  if (!_msgWriteTimer) {
    const captured = binding;
    _msgWriteTimer = setTimeout(() => {
      void flushMessageWritesFor(captured).catch((error) => {
        persistenceErrorHandler?.(error);
      });
    }, MSG_WRITE_DEBOUNCE_MS);
  }
}

export async function enqueueDispatch(entry: OutboxEntry): Promise<void> {
  const captured = requireBinding();
  const record: LegacyOutboxRecord = {
    ...entry,
    principalId: captured.principalId,
  };
  try {
    await captured.adapter.commit(
      captured.fence,
      [{ kind: "put-legacy-outbox", record }],
      () => stillBound(captured),
    );
  } catch (error) {
    persistenceErrorHandler?.(error);
    throw error;
  }
}

export async function removeDispatch(id: string): Promise<void> {
  const captured = requireBinding();
  try {
    await captured.adapter.commit(
      captured.fence,
      [{ kind: "delete-legacy-outbox", id }],
      () => stillBound(captured),
    );
  } catch (error) {
    persistenceErrorHandler?.(error);
    throw error;
  }
}

export async function loadOutbox(): Promise<OutboxEntry[]> {
  const captured = binding;
  if (!captured) return [];
  try {
    const rows = await captured.adapter.readLegacyOutbox(captured.fence);
    stillBound(captured);
    return rows.map(({ principalId: _principalId, ...entry }) => entry);
  } catch (error) {
    persistenceErrorHandler?.(error);
    throw error;
  }
}
