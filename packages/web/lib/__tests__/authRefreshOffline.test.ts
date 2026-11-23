// ct-74162: a token refresh that cannot reach Convex must not strand the app.
//
// The failing `POST convex.codecast.sh/api/action` ("no response", "Failed to
// fetch" in 1-207 ms) is Convex Auth's refresh of the access token. When the
// server rejects the current token, Convex's AuthenticationManager stops the
// websocket and asks the auth provider for a fresh token. If that request
// dies in transit the provider either rejects (nothing catches it: the
// socket stays stopped and the rejection escapes as an unhandled error) or
// answers with the stale token after a few quick retries (the manager then
// reports the person signed out). Either way nothing tries again once the
// network is back, so the app is stuck until a reload.
//
// Rendered for real: codecast's auth root over the durable storage, Convex
// Auth's provider, and Convex's own AuthenticationManager driven through the
// client's setAuth. Only the socket and the network are faked.
import { afterAll, describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

// What this file replaces on globalThis, put back in afterAll.
const savedGlobals = Object.fromEntries(["navigator", "HTMLElement", "Element", "Node", "Event", "StorageEvent", "MutationObserver", "localStorage", "sessionStorage", "BroadcastChannel"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "StorageEvent", "MutationObserver", "localStorage", "sessionStorage", "BroadcastChannel"]) {
  const value = (dom.window as any)[key];
  if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { closeDomWindow } = await import("../../test-helpers/domGlobals");
const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
const { CodecastAuthRoot } = await import("../authRoot");
const { AUTH_JWT_STORAGE_KEY, AUTH_REFRESH_TOKEN_STORAGE_KEY, CONVEX_URL } = await import("../localAuth");

const require = createRequire(import.meta.url);
const convexDir = dirname(dirname(dirname(require.resolve("convex/browser"))));
const { AuthenticationManager } = await import(join(convexDir, "esm/browser/sync/authentication_manager.js"));

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function issue(sessionId: string, lifetimeSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: `userA|${sessionId}`, iss: `${CONVEX_URL}/site`, aud: "convex", iat: now, exp: now + lifetimeSeconds })}.sig`;
}

// The network: down until the test brings it back.
let online = false;
const refreshCalls: number[] = [];
// The first fresh token lives 12 s, so with Convex's 10 s leeway its scheduled
// refetch fires 2 s after the server confirms it.
const fresh = issue("sA2", 12);
const fresh2 = issue("sA3");
const issued = [fresh, fresh2];
let served = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  refreshCalls.push(Date.now());
  if (!online) throw new TypeError("Failed to fetch");
  void url;
  const token = issued[Math.min(served++, issued.length - 1)];
  return new Response(JSON.stringify({ status: "success", value: { tokens: { token, refreshToken: `refresh-${served + 1}` } }, logLines: [] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
process.on("unhandledRejection", onUnhandled);

// The socket side of Convex's BaseClient, recorded.
const events: string[] = [];
const authReports: boolean[] = [];
let currentAuth: string | null = null;
let manager: any = null;
const syncState = {
  isCurrentOrNewerAuthVersion: () => true,
  markAuthCompletion: () => {},
  hasAuth: () => currentAuth !== null,
  clearAuth: () => { currentAuth = null; },
  isNewAuth: (t: string) => t !== currentAuth,
};
function fakeClient() {
  return {
    address: CONVEX_URL,
    options: {},
    verbose: false,
    action: async () => null,
    setAuth: (fetchToken: any, onChange: (ok: boolean) => void) => {
      manager = new AuthenticationManager(syncState, {
        authenticate: (t: string) => { currentAuth = t; events.push(`authenticate:${t === fresh ? "fresh" : t === fresh2 ? "fresh2" : "old"}`); return 1; },
        stopSocket: async () => { events.push("stopSocket"); },
        tryRestartSocket: () => { events.push("restartSocket"); },
        pauseSocket: () => {},
        resumeSocket: () => {},
        clearAuth: () => { currentAuth = null; },
      }, { logger: { logVerbose: () => {}, log: () => {}, warn: () => {}, error: () => {} }, refreshTokenLeewaySeconds: 10 });
      void manager.setConfig(fetchToken, (ok: boolean) => { authReports.push(ok); onChange(ok); });
    },
    clearAuth: () => {},
  } as any;
}

const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const old = issue("sA1");
localStorage.setItem(AUTH_JWT_STORAGE_KEY, old);
localStorage.setItem(AUTH_REFRESH_TOKEN_STORAGE_KEY, "refresh-1");
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);

afterAll(async () => {
  act(() => root.unmount());
  globalThis.fetch = realFetch;
  process.off("unhandledRejection", onUnhandled);
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  for (const [key, descriptor] of Object.entries(savedGlobals)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as any)[key];
  }
  closeDomWindow(dom);
});

describe("a token refresh that fails in transit (ct-74162)", () => {
  test("recovers without a reload once the network is back, still signed in", async () => {
    act(() => { root.render(React.createElement(CodecastAuthRoot, { client: fakeClient() }, null)); });
    for (let i = 0; i < 100 && !events.includes("authenticate:old"); i++) await sleep(10);
    expect(events).toContain("authenticate:old");

    // The server rejects the cached token: Convex stops the socket and refreshes.
    manager.onAuthError({ type: "AuthError", error: "Token expired", baseVersion: 0, authUpdateAttempted: true });

    // Offline long enough to outlast any quick in-call retry.
    await sleep(6000);
    expect(refreshCalls.length).toBeGreaterThan(0);

    // The network comes back.
    online = true;
    act(() => { window.dispatchEvent(new dom.window.Event("online")); });
    for (let i = 0; i < 300 && !events.includes("authenticate:fresh"); i++) await sleep(10);
    await sleep(50);

    const report = { events, authReports, unhandled: unhandled.map(String), refreshCalls: refreshCalls.length };
    // The fresh token reached the server and the socket runs again, without a reload.
    expect(report.events).toContain("authenticate:fresh");
    expect(report.events.lastIndexOf("restartSocket")).toBeGreaterThan(report.events.lastIndexOf("stopSocket"));
    // A network failure is not a sign-out.
    expect(report.authReports).not.toContain(false);
    expect(localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY)).not.toBeNull();
    // And it does not escape as an unhandled rejection (the Sentry groups).
    expect(report.unhandled).toEqual([]);
  }, 20000);

  test("the scheduled refetch recovers the same way when its refresh fails in transit", async () => {
    // The network drops again; then the server confirms the fresh token, which
    // schedules Convex's forced refetch (refetchToken) 2 s out.
    online = false;
    const callsBefore = refreshCalls.length;
    manager.onTransition({ type: "Transition", startVersion: { identity: 0 }, endVersion: { identity: 1 }, modifications: [] });

    // The scheduled refetch fires while offline and outlasts any quick in-call retry.
    await sleep(6000);
    expect(refreshCalls.length).toBeGreaterThan(callsBefore);
    expect(events).not.toContain("authenticate:fresh2");

    online = true;
    act(() => { window.dispatchEvent(new dom.window.Event("online")); });
    for (let i = 0; i < 300 && !events.includes("authenticate:fresh2"); i++) await sleep(10);
    await sleep(50);

    expect(events).toContain("authenticate:fresh2");
    expect(authReports).not.toContain(false);
    expect(localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY)).not.toBeNull();
    expect(unhandled.map(String)).toEqual([]);
  }, 20000);
});
