// ct-91563: a refresh rejected by a transient Convex overload must not cost
// the person their session.
//
// @convex-dev/auth refreshes through fetchAccessToken({ forceRefreshToken }),
// which removes the stored refresh token BEFORE it calls auth:signIn. On
// 2026-11-10 Convex answered that call with ExpiredInQueue in every window at
// once: the token was gone, the socket went anonymous, the next expiry signed
// people out, and the rejection escaped as an "Uncaught" toast.
//
// The window here is the real one every codecast page mounts (CodecastAuthRoot
// over the durable storage); only the network is fake. The first refresh hits
// the overload, the second finds Convex healthy again.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import "fake-indexeddb/auto";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "StorageEvent", "MutationObserver", "localStorage", "sessionStorage", "BroadcastChannel"]) {
  const value = (dom.window as any)[key];
  if (value !== undefined) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const React = await import("react");
const { act } = React;
const { createRoot } = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { useAuthToken } = await import("@convex-dev/auth/react");
const { CodecastAuthRoot } = await import("../authRoot");
const { AUTH_JWT_STORAGE_KEY, AUTH_REFRESH_TOKEN_STORAGE_KEY, CONVEX_URL } = await import("../localAuth");

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function issue(sessionId: string): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ sub: `userA|${sessionId}`, iss: `${CONVEX_URL}/site`, aud: "convex", iat: 1, exp: 2 })}.sig`;
}

// The body Convex sent on 2026-11-10 (eg-2972).
const EXPIRED_IN_QUEUE = JSON.stringify({
  code: "ExpiredInQueue",
  message: "Too many concurrent requests in a short period of time. Spread out your requests out over time or throttle them to avoid errors.",
});

// auth:signIn goes over HTTP (ConvexHttpClient -> fetch). Overloaded answers
// as Convex does under saturation; healthy rotates the refresh token.
let convexOverloaded = true;
const signInCalls: Array<{ refreshToken?: string; overloaded: boolean }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(CONVEX_URL) || !url.includes("/api/action")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const args = Array.isArray(body.args) ? body.args[0] : body.args;
  signInCalls.push({ refreshToken: args?.refreshToken, overloaded: convexOverloaded });
  if (convexOverloaded) return new Response(EXPIRED_IN_QUEUE, { status: 503, headers: { "content-type": "application/json" } });
  const token = issue(`s${signInCalls.length}`);
  return new Response(JSON.stringify({ status: "success", value: { tokens: { token, refreshToken: `refresh-${signInCalls.length}` } }, logLines: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

// The ConvexReactClient the provider wraps. setAuth hands us the provider's
// fetchAccessToken, the function the Convex socket calls on every reconnect.
let fetchAccessToken: ((args: { forceRefreshToken: boolean }) => Promise<string | null | undefined>) | null = null;
function fakeClient() {
  return {
    address: CONVEX_URL,
    options: {},
    verbose: false,
    action: async () => null,
    setAuth: (fetcher: typeof fetchAccessToken, onChange: (ok: boolean) => void) => {
      fetchAccessToken = fetcher;
      onChange(true);
    },
    clearAuth: () => {},
  } as any;
}

let shownToken: string | null = null;
function Probe() {
  shownToken = useAuthToken();
  return null;
}

const flush = () => act(async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 2)); });
const t1 = issue("s0");
let root: Root | null = null;

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, t1);
  localStorage.setItem(AUTH_REFRESH_TOKEN_STORAGE_KEY, "refresh-0");
  await flush();
});
afterAll(async () => {
  if (root) act(() => root!.unmount());
  globalThis.fetch = realFetch;
  await flush();
});

describe("a token refresh during a Convex overload", () => {
  test("keeps the refresh token, rejects nothing, and the next refresh signs back in", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(React.createElement(CodecastAuthRoot, { client: fakeClient() }, React.createElement(Probe)));
    });
    await flush();
    expect(shownToken).toBe(t1);
    expect(fetchAccessToken).not.toBeNull();

    // The socket reconnects mid-overload and forces a refresh.
    convexOverloaded = true;
    let rejection: unknown = null;
    await act(async () => {
      try {
        await fetchAccessToken!({ forceRefreshToken: true });
      } catch (error) {
        rejection = error;
      }
    });
    await flush();
    expect(signInCalls.some((c) => c.overloaded && c.refreshToken === "refresh-0")).toBe(true);

    // An overload is not a logout: the refresh token is still there to try again.
    expect(localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY)).not.toBeNull();
    // And it surfaces as nothing: no rejection for the window to report as Uncaught.
    expect(rejection === null ? null : String((rejection as Error)?.message ?? rejection)).toBeNull();

    // Convex recovers; the next refresh rotates the session instead of dropping it.
    convexOverloaded = false;
    let next: string | null | undefined;
    await act(async () => {
      next = await fetchAccessToken!({ forceRefreshToken: true });
    });
    await flush();
    expect(next).toBeTruthy();
    expect(shownToken).toBeTruthy();
    expect(localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY)).not.toBeNull();
  });
});
