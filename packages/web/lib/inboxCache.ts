import { get, set, del } from "idb-keyval";
import type { InboxSession, ClientState } from "../store/inboxStore";

const CACHE_KEY = "inbox-cache-v1";
const CACHE_VERSION = 1;

export type InboxCacheData = {
  version: number;
  sessions: InboxSession[];
  dismissedSessions: InboxSession[];
  dismissedIds: string[];
  mruStack: string[];
  clientState: ClientState;
  savedAt: number;
};

export async function readInboxCache(): Promise<InboxCacheData | null> {
  try {
    const data = await get<InboxCacheData>(CACHE_KEY);
    if (!data || data.version !== CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

let pendingWrite: ReturnType<typeof setTimeout> | null = null;

export function writeInboxCache(data: Omit<InboxCacheData, "version" | "savedAt">) {
  if (pendingWrite) clearTimeout(pendingWrite);
  pendingWrite = setTimeout(() => {
    pendingWrite = null;
    set(CACHE_KEY, {
      ...data,
      version: CACHE_VERSION,
      savedAt: Date.now(),
    }).catch(() => {});
  }, 1000);
}

export async function clearInboxCache() {
  if (pendingWrite) clearTimeout(pendingWrite);
  await del(CACHE_KEY).catch(() => {});
}
