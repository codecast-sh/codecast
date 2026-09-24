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

/**
 * absent: no token in either tier. named: the token names a principal.
 * unparsable: a token is stored but does not parse (a format the parser does
 * not know, a truncated write). unreadable: localStorage has no token and the
 * durable tier could not be read (IndexedDB failing to open: quota, a blocked
 * upgrade, private mode), so whether a token exists is unknown. Neither
 * unparsable nor unreadable is a logout: the tracker keeps the account it
 * last knew and reports no change. Only an absent token or a token naming
 * another principal moves the epoch.
 */
export type AuthTokenState = "absent" | "named" | "unparsable" | "unreadable";

export type AuthPrincipalTracker = {
  /** The principal this window acts for right now. Pure: never notifies. */
  current: () => string | null;
  tokenState: () => AuthTokenState;
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
  // The last durable read, while localStorage is empty, threw / held a token
  // that does not parse.
  let durableUnreadable = false;
  let durableUnparsable = false;
  let parsedToken: string | null = null;
  let parsedPrincipal: string | null = null;
  let warnedToken: string | null = null;

  function readLocal(): string | null {
    try { return local?.getItem(jwtKey) ?? null; } catch { return null; }
  }

  // The principal a token names, or null when it does not parse.
  function parse(token: string): string | null {
    if (token !== parsedToken) {
      parsedToken = token;
      parsedPrincipal = parseAccessIdentity(token)?.principalId ?? null;
    }
    return parsedPrincipal;
  }

  function stateOf(token: string | null): AuthTokenState {
    if (token === null) return durableUnreadable ? "unreadable" : durableUnparsable ? "unparsable" : "absent";
    return parse(token) === null ? "unparsable" : "named";
  }

  // What the window acts as for a stored token: the named principal, nobody
  // for no token, and for an unparsable token whatever it acted as before.
  function principalFor(token: string | null): string | null {
    if (token === null) return null;
    const named = parse(token);
    if (named !== null) return named;
    if (warnedToken !== token) {
      warnedToken = token;
      console.warn("[auth principal] the stored token could not be parsed; keeping the current account");
    }
    return principal;
  }

  function recompute(): void {
    const token = readLocal();
    if (token !== null) { durableUnreadable = false; durableUnparsable = false; }
    const next = principalFor(token);
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

  principal = principalFor(readLocal());

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
      return principalFor(token);
    },
    tokenState: () => stateOf(readLocal()),
    epoch: () => epoch,
    resolve: async () => {
      const token = readLocal();
      if (token !== null) return principalFor(token);
      let durable: string | null = null;
      try {
        durable = await opts.readDurable(jwtKey);
        durableUnreadable = false;
      } catch (error) {
        // Unknown, not absent: nothing built on this may treat it as a sign-out.
        durableUnreadable = true;
        console.warn("[auth principal] the durable token store could not be read", error);
        return principal;
      }
      const found = durable === null ? null : parse(durable);
      durableUnparsable = durable !== null && found === null;
      if (durableUnparsable && warnedToken !== durable) {
        warnedToken = durable;
        console.warn("[auth principal] the durable token could not be parsed; keeping the current account");
      }
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
