// Which account this window acts for, read from the stored JWT.
//
// @convex-dev/auth keeps its token in React state and learns about sibling
// windows only through a storage listener that compares `event.storageArea`
// to the storage object it was given. An app that hands it a wrapper (the
// durable storage here) never passes that comparison, so a window whose
// sibling signed out or switched accounts keeps rendering and dispatching for
// the old account. This tracker is the supported replacement: it watches the
// JWT key through native storage events (siblings) and the wrapper's own
// writes (this window), parses the principal out of the token, and reports a
// change only when the PRINCIPAL changes. A token rotated for the same user
// is silent, so routine refresh never disturbs the app.
import { useSyncExternalStore } from "react";
import { parseAccessIdentity } from "../accessIdentity";
import type { AuthStorageWriteListener } from "./durableAuthStorage";

export type AuthPrincipalChange = { epoch: number; previous: string | null; next: string | null };

export type AuthPrincipalTracker = {
  /** The principal the stored JWT names right now. Pure: never notifies. */
  current: () => string | null;
  /** Increments on every principal change; a React key for the auth tree. */
  epoch: () => number;
  /**
   * The principal from either storage tier. A token found only in the
   * durable tier (localStorage wiped, IndexedDB intact) is adopted silently:
   * nothing has rendered for anyone else yet, and the wrapper restores
   * localStorage on its next read without that counting as a change.
   */
  resolve: () => Promise<string | null>;
  /** Re-read storage and report a change if one was missed. */
  check: () => void;
  subscribe: (listener: (change: AuthPrincipalChange) => void) => () => void;
  dispose: () => void;
};

export type StorageEventLike = { key: string | null; storageArea?: unknown };
export type StorageEventTarget = {
  addEventListener: (type: "storage", listener: (event: StorageEventLike) => void) => void;
  removeEventListener: (type: "storage", listener: (event: StorageEventLike) => void) => void;
};

export function createAuthPrincipalTracker(opts: {
  jwtKey: string;
  subscribeWrites: (listener: AuthStorageWriteListener) => () => void;
  readDurable: (key: string) => Promise<string | null>;
  /** Defaults to the browser globals; injected for tests and headless hosts. */
  localStorage?: Pick<Storage, "getItem"> | null;
  eventTarget?: StorageEventTarget | null;
  /** The object native storage events carry (window.localStorage). Events for another area are ignored. */
  nativeStorageArea?: unknown;
}): AuthPrincipalTracker {
  const { jwtKey } = opts;
  const local = opts.localStorage === undefined
    ? (typeof localStorage !== "undefined" ? localStorage : null)
    : opts.localStorage;
  const target = opts.eventTarget === undefined
    ? (typeof window !== "undefined" ? (window as unknown as StorageEventTarget) : null)
    : opts.eventTarget;
  const nativeArea = opts.nativeStorageArea === undefined ? local : opts.nativeStorageArea;

  const listeners = new Set<(change: AuthPrincipalChange) => void>();
  let epoch = 0;
  let principal: string | null = null;
  let durableAdopted = false;
  let parsedToken: string | null = null;
  let parsedPrincipal: string | null = null;

  function readLocal(): string | null {
    try { return local?.getItem(jwtKey) ?? null; } catch { return null; }
  }

  function parse(token: string | null): string | null {
    if (token === null) return null;
    if (token !== parsedToken) {
      parsedToken = token;
      parsedPrincipal = parseAccessIdentity(token)?.principalId ?? null;
    }
    return parsedPrincipal;
  }

  function recompute(): void {
    const next = parse(readLocal());
    durableAdopted = false;
    if (next === principal) return;
    const previous = principal;
    principal = next;
    epoch++;
    const change = { epoch, previous, next };
    for (const listener of listeners) {
      try { listener(change); } catch (error) { console.error("[auth principal] listener failed", error); }
    }
  }

  principal = parse(readLocal());

  const onStorage = (event: StorageEventLike) => {
    if (nativeArea && event.storageArea !== undefined && event.storageArea !== nativeArea) return;
    if (event.key !== null && event.key !== jwtKey) return;
    recompute();
  };
  target?.addEventListener("storage", onStorage);
  const unsubscribeWrites = opts.subscribeWrites((key) => {
    if (key !== null && key !== jwtKey) return;
    recompute();
  });

  return {
    current: () => {
      const token = readLocal();
      if (token === null) return durableAdopted ? principal : null;
      return parse(token);
    },
    epoch: () => epoch,
    resolve: async () => {
      const token = readLocal();
      if (token !== null) return parse(token);
      let durable: string | null = null;
      try { durable = await opts.readDurable(jwtKey); } catch { durable = null; }
      const found = parse(durable);
      if (found !== null && principal === null && readLocal() === null) {
        principal = found;
        durableAdopted = true;
      }
      return principal ?? found;
    },
    check: recompute,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispose: () => {
      target?.removeEventListener("storage", onStorage);
      unsubscribeWrites();
      listeners.clear();
    },
  };
}

/** The tracker's epoch as React state: subscribe once, re-render per principal change. */
export function useAuthPrincipalEpoch(tracker: AuthPrincipalTracker): number {
  return useSyncExternalStore(
    (onChange) => tracker.subscribe(() => onChange()),
    () => tracker.epoch(),
    () => tracker.epoch(),
  );
}

export function useAuthPrincipal(tracker: AuthPrincipalTracker): { principalId: string | null; epoch: number } {
  const epoch = useAuthPrincipalEpoch(tracker);
  return { principalId: tracker.current(), epoch };
}
