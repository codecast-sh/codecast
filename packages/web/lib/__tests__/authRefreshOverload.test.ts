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
// over the durable storage); only the network is fake. Each test scripts what
// Convex answers to successive auth:signIn calls.
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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

// auth:signIn goes over HTTP (ConvexHttpClient -> fetch). `answers` scripts
// the replies in order; the last one repeats. "ok" rotates the refresh token.
type Answer = "overloaded" | "network" | "ok" | "refused" | "invalid";
let answers: Answer[] = ["ok"];
let signInCalls: Array<{ refreshToken?: string; answer: Answer; at: number }> = [];
const realFetch = globalThis.fetch;
const json = (body: object, status: number) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (!url.startsWith(CONVEX_URL) || !url.includes("/api/action")) return realFetch(input, init);
  const body = JSON.parse(String(init?.body ?? "{}"));
  const args = Array.isArray(body.args) ? body.args[0] : body.args;
  const answer = answers[Math.min(signInCalls.length, answers.length - 1)];
  signInCalls.push({ refreshToken: args?.refreshToken, answer, at: Date.now() });
  switch (answer) {
    case "overloaded":
      return new Response(EXPIRED_IN_QUEUE, { status: 503, headers: { "content-type": "application/json" } });
    case "network":
      throw new TypeError("Failed to fetch");
    case "refused":
      return json({ status: "success", value: { tokens: null }, logLines: [] }, 200);
    case "invalid":
      return json({ status: "error", errorMessage: "Invalid refresh token", logLines: [] }, 560);
    case "ok":
      return json({ status: "success", value: { tokens: { token: issue(`s${signInCalls.length}`), refreshToken: `refresh-${signInCalls.length}` } }, logLines: [] }, 200);
  }
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

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(React.createElement(CodecastAuthRoot, { client: fakeClient() }, React.createElement(Probe)));
  });
  await flush();
  expect(shownToken).toBe(t1);
  expect(fetchAccessToken).not.toBeNull();
}

// The socket reconnecting and forcing a refresh. Returns what it resolved to,
// or the rejection a window would report as Uncaught.
async function forceRefresh(): Promise<{ value?: string | null; rejection?: string }> {
  let out: { value?: string | null; rejection?: string } = {};
  await act(async () => {
    try {
      out = { value: (await fetchAccessToken!({ forceRefreshToken: true })) ?? null };
    } catch (error) {
      out = { rejection: String((error as Error)?.message ?? error) };
    }
  });
  await flush();
  return out;
}

const stored = () => ({ jwt: localStorage.getItem(AUTH_JWT_STORAGE_KEY), refresh: localStorage.getItem(AUTH_REFRESH_TOKEN_STORAGE_KEY) });

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem(AUTH_JWT_STORAGE_KEY, t1);
  localStorage.setItem(AUTH_REFRESH_TOKEN_STORAGE_KEY, "refresh-0");
  signInCalls = [];
  answers = ["ok"];
  shownToken = null;
  fetchAccessToken = null;
  await flush();
  await mount();
});
afterEach(async () => {
  if (root) act(() => root!.unmount());
  root = null;
  await flush();
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await flush();
});

describe("a token refresh during a Convex overload", () => {
  test("retries ExpiredInQueue with at least 1s between attempts and lands the new tokens", async () => {
    answers = ["overloaded", "overloaded", "ok"];
    const out = await forceRefresh();

    expect(signInCalls.map((c) => c.answer)).toEqual(["overloaded", "overloaded", "ok"]);
    expect(signInCalls.every((c) => c.refreshToken === "refresh-0")).toBe(true);
    // Backoff: windows cannot hammer an overloaded backend.
    expect(signInCalls[1].at - signInCalls[0].at).toBeGreaterThanOrEqual(1000);
    expect(signInCalls[2].at - signInCalls[1].at).toBeGreaterThanOrEqual(2000);

    const newJwt = issue("s3");
    expect(out).toEqual({ value: newJwt });
    expect(shownToken).toBe(newJwt);
    expect(stored()).toEqual({ jwt: newJwt, refresh: "refresh-3" });
  }, 15_000);

  test("when every attempt fails in transit, keeps the original refresh token, rejects nothing, and the next refresh signs back in", async () => {
    answers = ["overloaded", "network", "overloaded", "ok"];
    const out = await forceRefresh();

    // Bounded: three attempts, then it stops.
    expect(signInCalls.map((c) => c.answer)).toEqual(["overloaded", "network", "overloaded"]);
    // Nothing for the window to report as Uncaught; the socket keeps its token.
    expect(out).toEqual({ value: t1 });
    expect(shownToken).toBe(t1);
    // An overload is not a logout.
    expect(stored()).toEqual({ jwt: t1, refresh: "refresh-0" });

    // Convex recovers; the kept token refreshes.
    const next = await forceRefresh();
    expect(signInCalls[3]).toMatchObject({ answer: "ok", refreshToken: "refresh-0" });
    expect(next).toEqual({ value: issue("s4") });
    expect(stored()).toEqual({ jwt: issue("s4"), refresh: "refresh-4" });
  }, 15_000);

  test("a refresh token the server refuses (tokens: null) still signs out, without retrying", async () => {
    answers = ["refused"];
    const out = await forceRefresh();

    expect(signInCalls).toHaveLength(1);
    expect(out).toEqual({ value: null });
    expect(shownToken).toBeNull();
    expect(stored()).toEqual({ jwt: null, refresh: null });
  });

  test("a server error that is not an overload clears both tokens, signs out and still rejects, without retrying", async () => {
    answers = ["invalid"];
    const out = await forceRefresh();

    expect(signInCalls).toHaveLength(1);
    expect(out.rejection).toContain("Invalid refresh token");
    expect(shownToken).toBeNull();
    expect(stored()).toEqual({ jwt: null, refresh: null });
  });
});
