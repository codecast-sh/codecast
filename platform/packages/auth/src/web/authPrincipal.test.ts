import { describe, expect, test } from "bun:test";
import { createAuthPrincipalTracker, type AuthPrincipalChange, type StorageEventLike } from "./authPrincipal";
import type { AuthStorageWriteListener } from "./durableAuthStorage";

const JWT_KEY = "__convexAuthJWT_test";

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** An unsigned token shaped like Convex Auth's: `sub` is `<user>|<session>`. */
export function fakeToken(principalId: string, sessionId = "s1"): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: `${principalId}|${sessionId}`, iss: "https://x.convex.site", aud: "convex" })}.sig`;
}

function harness(initial?: string) {
  const local = new Map<string, string>();
  if (initial) local.set(JWT_KEY, initial);
  const storageListeners = new Set<(e: StorageEventLike) => void>();
  const writeListeners = new Set<AuthStorageWriteListener>();
  let durable: string | null = initial ?? null;
  const nativeArea = { native: true };
  const tracker = createAuthPrincipalTracker({
    jwtKey: JWT_KEY,
    subscribeWrites: (l) => { writeListeners.add(l); return () => writeListeners.delete(l); },
    readDurable: async (key) => (key === JWT_KEY ? durable : null),
    localStorage: { getItem: (k) => local.get(k) ?? null },
    eventTarget: {
      addEventListener: (_t, l) => { storageListeners.add(l); },
      removeEventListener: (_t, l) => { storageListeners.delete(l); },
    },
    nativeStorageArea: nativeArea,
  });
  const changes: AuthPrincipalChange[] = [];
  tracker.subscribe((c) => changes.push(c));
  return {
    tracker, changes, local,
    setDurable: (v: string | null) => { durable = v; },
    /** A sibling window wrote the key: native storage event, native area. */
    siblingWrite: (key: string | null, value: string | null, area: unknown = nativeArea) => {
      if (key === null) local.clear(); else if (value === null) local.delete(key); else local.set(key, value);
      for (const l of storageListeners) l({ key, storageArea: area });
    },
    /** This window wrote through the durable wrapper (no storage event here). */
    ownWrite: (key: string | null, value: string | null) => {
      if (key === null) local.clear(); else if (value === null) local.delete(key); else local.set(key, value);
      for (const l of writeListeners) l(key, value);
    },
  };
}

describe("auth principal tracker", () => {
  test("starts from the stored token", () => {
    const h = harness(fakeToken("userA"));
    expect(h.tracker.current()).toBe("userA");
    expect(h.tracker.epoch()).toBe(0);
    expect(h.changes).toEqual([]);
  });

  test("a sibling's logout is a change; a sibling's login as another user is another", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(JWT_KEY, null);
    expect(h.tracker.current()).toBeNull();
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: null }]);
    h.siblingWrite(JWT_KEY, fakeToken("userB"));
    expect(h.tracker.current()).toBe("userB");
    expect(h.changes[1]).toEqual({ epoch: 2, previous: null, next: "userB" });
  });

  test("this window's own writes through the wrapper count too", () => {
    const h = harness(fakeToken("userA"));
    h.ownWrite(JWT_KEY, null);
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: null }]);
    h.ownWrite(null, null); // clear() with nothing stored: still nothing
    expect(h.changes.length).toBe(1);
  });

  test("same-user token rotation is silent, for sibling and own writes", () => {
    const h = harness(fakeToken("userA", "s1"));
    h.siblingWrite(JWT_KEY, fakeToken("userA", "s2"));
    h.ownWrite(JWT_KEY, fakeToken("userA", "s3"));
    expect(h.changes).toEqual([]);
    expect(h.tracker.epoch()).toBe(0);
    expect(h.tracker.current()).toBe("userA");
  });

  test("ignores other keys and other storage areas", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite("unrelated", "x");
    h.siblingWrite(JWT_KEY, null, { session: true });
    // The area check is the library's own rule; a foreign area is not our storage.
    expect(h.changes).toEqual([]);
  });

  test("a storage clear (key null) is a logout", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(null, null);
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: null }]);
  });

  test("resolve adopts a durable-only token silently and the later restore is not a change", async () => {
    const h = harness();
    h.setDurable(fakeToken("userA"));
    expect(h.tracker.current()).toBeNull();
    expect(await h.tracker.resolve()).toBe("userA");
    expect(h.tracker.current()).toBe("userA");
    expect(h.changes).toEqual([]);
    // The wrapper restores localStorage from IndexedDB on its next read.
    h.ownWrite(JWT_KEY, fakeToken("userA"));
    expect(h.changes).toEqual([]);
    expect(h.tracker.current()).toBe("userA");
  });

  test("resolve prefers localStorage and never adopts over a bound principal", async () => {
    const h = harness(fakeToken("userA"));
    h.setDurable(fakeToken("userB"));
    expect(await h.tracker.resolve()).toBe("userA");
    expect(h.changes).toEqual([]);
  });

  test("a token that is not a Convex Auth JWT names nobody", () => {
    const h = harness("garbage");
    expect(h.tracker.current()).toBeNull();
    h.siblingWrite(JWT_KEY, fakeToken("userA"));
    expect(h.changes).toEqual([{ epoch: 1, previous: null, next: "userA" }]);
  });

  test("check reports a change the events missed; dispose stops everything", () => {
    const h = harness(fakeToken("userA"));
    h.local.delete(JWT_KEY);
    expect(h.changes).toEqual([]);
    h.tracker.check();
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: null }]);
    h.tracker.dispose();
    h.siblingWrite(JWT_KEY, fakeToken("userB"));
    expect(h.changes.length).toBe(1);
  });
});

// A token that is present but does not parse is not a logout. The library
// still holds a token for someone; the tracker cannot say who, so it keeps
// the account it last knew, reports the state, and changes nothing. A purge
// on this path destroyed a signed-in user's cache, pending input and outbox.
describe("unparsable token", () => {
  test("after a valid principal, keeps the account and reports no change", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(JWT_KEY, "not.a.jwt");
    expect(h.changes).toEqual([]);
    expect(h.tracker.current()).toBe("userA");
    expect(h.tracker.tokenState()).toBe("unparsable");
    h.ownWrite(JWT_KEY, "header.payload");
    expect(h.changes).toEqual([]);
    expect(h.tracker.current()).toBe("userA");
  });

  test("a later valid token for another user is a change from the kept account", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(JWT_KEY, "garbage");
    h.siblingWrite(JWT_KEY, fakeToken("userB"));
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: "userB" }]);
    expect(h.tracker.tokenState()).toBe("named");
  });

  test("a removal after an unparsable token is the logout", () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(JWT_KEY, "garbage");
    h.siblingWrite(JWT_KEY, null);
    expect(h.changes).toEqual([{ epoch: 1, previous: "userA", next: null }]);
    expect(h.tracker.tokenState()).toBe("absent");
  });

  test("unparsable at boot names nobody and stays silent", async () => {
    const h = harness("garbage");
    expect(h.tracker.current()).toBeNull();
    expect(h.tracker.tokenState()).toBe("unparsable");
    expect(await h.tracker.resolve()).toBeNull();
    expect(h.changes).toEqual([]);
  });

  test("resolve keeps the account while the stored token is unparsable", async () => {
    const h = harness(fakeToken("userA"));
    h.siblingWrite(JWT_KEY, "garbage");
    expect(await h.tracker.resolve()).toBe("userA");
  });
});
