// Two windows of one browser profile: two mounted auth providers over the
// same localStorage, with the browser's storage event relayed between them
// the way Chrome does it (a native StorageEvent whose storageArea is the
// native localStorage). No network, no real account: the "server" is a fake
// token issuer that mints unsigned tokens shaped like Convex Auth's.
//
// What must hold: when one window signs out or signs in as someone else,
// every other window drops the old account before anything renders or
// dispatches for the next one, and a token rotated for the same user changes
// nothing.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "StorageEvent", "MutationObserver", "localStorage", "sessionStorage", "BroadcastChannel"]) {
  const value = (dom.window as any)[key];
  if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The profile relay. A browser fires a storage event in every OTHER window of
// the origin; both of our windows live in this one JSDOM window, so each write
// is echoed back as the native-shaped event a sibling would receive.
const relayed: Array<{ key: string | null; newValue: string | null }> = [];
{
  const proto = dom.window.Storage.prototype;
  const original = { setItem: proto.setItem, removeItem: proto.removeItem, clear: proto.clear };
  const relay = (key: string | null, oldValue: string | null, newValue: string | null) => {
    relayed.push({ key, newValue });
    setTimeout(() => {
      dom.window.dispatchEvent(new dom.window.StorageEvent("storage", {
        key, oldValue, newValue, storageArea: dom.window.localStorage, url: dom.window.location.href,
      }));
    }, 0);
  };
  proto.setItem = function (this: Storage, key: string, value: string) {
    const oldValue = this.getItem(key);
    original.setItem.call(this, key, value);
    if (this === dom.window.localStorage && oldValue !== value) relay(key, oldValue, value);
  };
  proto.removeItem = function (this: Storage, key: string) {
    const oldValue = this.getItem(key);
    original.removeItem.call(this, key);
    if (this === dom.window.localStorage && oldValue !== null) relay(key, oldValue, null);
  };
  proto.clear = function (this: Storage) {
    original.clear.call(this);
    if (this === dom.window.localStorage) relay(null, null, null);
  };
}

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { useAuthActions, useAuthToken } = await import("@convex-dev/auth/react");
const { CodecastAuthRoot } = await import("../authRoot");
const { AUTH_JWT_STORAGE_KEY, CONVEX_URL } = await import("../localAuth");
const { useInboxStore, ensureHydrated } = await import("../../store/inboxStore");
const store = useInboxStore;

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** The fake issuer: an unsigned token shaped like Convex Auth's (`sub` = `<user>|<session>`). */
function issue(principalId: string, sessionId: string): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: `${principalId}|${sessionId}`, iss: `${CONVEX_URL}/site`, aud: "convex", iat: 1, exp: 2 })}.sig`;
}

// The Convex client the providers talk to. Sign-in answers with the tokens
// the test decided; sign-out answers at once; nothing leaves the process.
let nextSignIn: { principalId: string; sessionId: string } = { principalId: "userB", sessionId: "sB1" };
function fakeClient() {
  return {
    address: CONVEX_URL,
    options: {},
    verbose: false,
    action: async (name: string) => {
      if (String(name).includes("signOut")) return null;
      const token = issue(nextSignIn.principalId, nextSignIn.sessionId);
      return { tokens: { token, refreshToken: `refresh-${token.slice(-8)}` } };
    },
    setAuth: (_fetch: unknown, onChange: (ok: boolean) => void) => { onChange(true); },
    clearAuth: () => {},
  } as any;
}

type Probe = { token: string | null; actions: ReturnType<typeof useAuthActions>; renders: number };
const probes: Record<string, Probe> = {};
/** Every render of a window, with the store's inbox rows at that moment. */
const timeline: Array<{ id: string; token: string | null; sessionRows: number }> = [];
function WindowProbe({ id }: { id: string }) {
  const token = useAuthToken();
  const actions = useAuthActions();
  const prior = probes[id];
  probes[id] = { token, actions, renders: (prior?.renders ?? 0) + 1 };
  timeline.push({ id, token, sessionRows: Object.keys(store.getState().sessions).length });
  return null;
}

function mountWindow(id: string): Root {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(CodecastAuthRoot, { client: fakeClient(), children: React.createElement(WindowProbe, { id }) }));
  });
  return root;
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 2)); });
const seedInbox = (owner: string) => {
  const id = owner.padEnd(32, "0");
  store.setState({ sessions: { [id]: { _id: id, session_id: `s-${id}`, updated_at: 1, user_id: owner } as any }, currentUser: { _id: owner } as any });
};
const inboxRows = () => Object.keys(store.getState().sessions).length;

const tA1 = issue("userA", "sA1");
let roots: Root[] = [];
beforeEach(async () => {
  for (const r of roots) act(() => r.unmount());
  roots = [];
  timeline.length = 0;
  relayed.length = 0;
  localStorage.clear();
  await flush();
  store.setState({ sessions: {}, currentUser: null } as any);
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, tA1);
  await flush();
});
afterAll(() => { for (const r of roots) act(() => r.unmount()); });

async function twoWindowsSignedInAsA() {
  roots.push(mountWindow("A"), mountWindow("B"));
  await flush();
  expect(probes.A.token).toBe(tA1);
  expect(probes.B.token).toBe(tA1);
}

describe("logout and account change across windows", () => {
  test("a sign-out in one window signs every window out", async () => {
    await twoWindowsSignedInAsA();
    seedInbox("userA");
    (store.getState() as any)._setDispatch(async () => null);
    expect((store.getState() as any)._isDispatchWired()).toBe(true);

    await act(() => probes.A.actions.signOut());
    await flush();

    // The relay delivered the native event for the JWT key to window B.
    expect(relayed.some((r) => r.key === AUTH_JWT_STORAGE_KEY && r.newValue === null)).toBe(true);
    expect(probes.A.token).toBeNull();
    expect(probes.B.token).toBeNull();
    // Window B's memory of account A is gone and nothing can dispatch for it.
    expect(inboxRows()).toBe(0);
    expect((store.getState() as any)._isDispatchWired()).toBe(false);
  });

  test("a sign-in as another user elsewhere reaches every window with a cleared store", async () => {
    await twoWindowsSignedInAsA();
    seedInbox("userA");
    await act(() => probes.A.actions.signOut());
    await flush();
    seedInbox("userA"); // stale rows a slow window might still hold
    nextSignIn = { principalId: "userB", sessionId: "sB1" };
    await act(async () => { await probes.A.actions.signIn("password", { email: "b@test", password: "x", flow: "signIn" }); });
    await flush();

    const tB = issue("userB", "sB1");
    expect(probes.A.token).toBe(tB);
    expect(probes.B.token).toBe(tB);
    // Every render of B under account B saw an empty inbox: the clear came first.
    const bUnderB = timeline.filter((t) => t.id === "B" && t.token === tB);
    expect(bUnderB.length).toBeGreaterThan(0);
    expect(bUnderB.every((t) => t.sessionRows === 0)).toBe(true);
  });

  test("a token rotated for the same user changes nothing", async () => {
    await twoWindowsSignedInAsA();
    seedInbox("userA");
    const rendersBefore = probes.B.renders;
    localStorage.setItem(AUTH_JWT_STORAGE_KEY, issue("userA", "sA2"));
    await flush();
    expect(inboxRows()).toBe(1);
    expect(probes.B.renders).toBe(rendersBefore);
  });

  test("a cache read still in flight at the boundary lands nowhere", async () => {
    await twoWindowsSignedInAsA();
    const { default: Dexie } = await import("dexie");
    const db = new Dexie("codecast-store");
    await db.open();
    const now = Date.now();
    await db.table("conversationMessages").put({ convId: "c1", messages: [{ _id: "m1", role: "user", content: "old account", timestamp: now }], pagination: { initialized: true, hasMore: false }, latestTimestamp: now });
    db.close();
    const read = ensureHydrated("c1");
    // The sibling signs out while the read is in flight.
    await act(() => probes.A.actions.signOut());
    await read;
    await flush();
    expect(store.getState().messages.c1).toBeUndefined();
  });
});
