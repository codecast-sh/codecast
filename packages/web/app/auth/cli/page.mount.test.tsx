// /auth/cli and /login mounted together: a stored token the server has not
// confirmed (still validating, or about to be rejected) must not bounce the
// visitor between the two pages. /login sends a token holder back here, so
// this page waits for the token to settle and leaves for /login exactly once
// when it is cleared. Prod saw the ping-pong run ~50 round trips a second.
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation, useNavigate } from "react-router";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "https://codecast.test", pretendToBeVisual: true });
for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "Event", "sessionStorage", "localStorage"]) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let auth = { isAuthenticated: false, isLoading: false };
// cliAuth.requestInfo: what the server recorded when the CLI registered (undefined: an unregistered request).
let requestInfo: unknown = undefined;
let minted = 0;
let tokenStored = true;
const tokenListeners = new Set<() => void>();
const navigations: string[] = [];
const convex = await import("convex/react");
mock.module("convex/react", () => ({ ...convex, useConvexAuth: () => auth, useQuery: () => (auth.isAuthenticated ? { _id: "u1", email: "new@dev.test" } : undefined), useMutation: () => async () => { minted++; return { token: "tok" }; }, useQueries: (q: Record<string, unknown>) => Object.fromEntries(Object.keys(q).map((k) => [k, requestInfo])) }));
mock.module("next/navigation", () => ({
  useRouter: () => {
    const navigate = useNavigate();
    return React.useMemo(() => ({
      replace: (url: string) => { navigations.push(url); navigate(url, { replace: true }); },
      push: (url: string) => { navigations.push(url); navigate(url); },
    }), [navigate]);
  },
  useSearchParams: () => new URLSearchParams(useLocation().search),
}));
mock.module("next/link", () => ({ default: ({ children, ...props }: any) => <a {...props}>{children}</a> }));
const localAuth = await import("../../../lib/localAuth");
mock.module("../../../lib/localAuth", () => ({
  ...localAuth,
  useLocalAuth: () => React.useSyncExternalStore((cb) => { tokenListeners.add(cb); return () => tokenListeners.delete(cb); }, () => tokenStored),
}));
const platform = await import("@platform/auth/web");
mock.module("@platform/auth/web", () => ({ ...platform, useProviderSignIn: () => ({ buttons: [], start: async () => {}, loading: false }) }));
const authReact = await import("@convex-dev/auth/react");
mock.module("@convex-dev/auth/react", () => ({ ...authReact, useAuthActions: () => ({ signIn: async () => ({}), signOut: async () => {} }) }));

const { default: CliAuth } = await import("./page");
const { default: Login } = await import("../../login/page");
const { cliJustConnected, CLI_CONNECTED_KEY } = await import("../../../lib/cliConnected");

let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const render = () => act(async () => root.render(<BrowserRouter><Routes>
  <Route path="/auth/cli" element={<CliAuth />} />
  <Route path="/login" element={<Login />} />
  <Route path="/inbox" element={<h1>Inbox</h1>} />
</Routes></BrowserRouter>));

beforeEach(() => {
  document.body.innerHTML = "<div id='root'></div>";
  root = createRoot(document.getElementById("root")!);
  auth = { isAuthenticated: false, isLoading: false };
  tokenStored = true;
  navigations.length = 0;
  requestInfo = undefined;
  minted = 0;
  window.history.replaceState(null, "", "/auth/cli?nonce=n1&port=4242");
});
afterEach(async () => { await act(async () => root.unmount()); });

test("an unconfirmed stored token waits on /auth/cli instead of bouncing through /login", async () => {
  await render();
  await flush();
  expect(navigations).toEqual([]);
  expect(window.location.pathname).toBe("/auth/cli");
}, 60000);

test("a cleared token leaves for /login once and stays there", async () => {
  await render();
  await flush();
  await act(async () => { tokenStored = false; tokenListeners.forEach((cb) => cb()); });
  await flush();
  expect(window.location.pathname).toBe("/login");
  expect(navigations.length).toBe(1);
  expect(navigations[0]).toStartWith("/login?return_to=");
}, 60000);

test("authorizing hands the tab to the inbox, stamped as just connected", async () => {
  auth = { isAuthenticated: true, isLoading: false };
  sessionStorage.removeItem(CLI_CONNECTED_KEY);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
  try {
    await render();
    await flush();
    const authorize = [...document.querySelectorAll("button")].find((b) => b.textContent === "Authorize")!;
    await act(async () => { authorize.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 1700)); });
    expect(window.location.pathname).toBe("/inbox");
    expect(cliJustConnected()).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
  }
}, 60000);

test("a registered request shows the network it came from, and a used one cannot be authorized", async () => {
  auth = { isAuthenticated: true, isLoading: false };
  const now = Date.now();
  requestInfo = { device_name: "build-box", ip: "198.51.100.7", country: "NL", created_at: now - 30_000, expires_at: now + 300_000, used: false };
  await render();
  await flush();
  const text = document.body.textContent ?? "";
  expect(text).toContain("198.51.100.7");
  expect(text).toContain("build-box");
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Authorize")).toBe(true);

  await act(async () => root.unmount());
  root = createRoot(document.getElementById("root")!);
  requestInfo = { ...(requestInfo as object), used: true };
  await render();
  await flush();
  const buttons = [...document.querySelectorAll("button")];
  expect(buttons.some((b) => b.textContent === "Authorize")).toBe(false);
  expect(document.body.textContent).toContain("Already used");
  buttons.forEach((b) => b.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  await flush();
  expect(minted).toBe(0);
}, 60000);
