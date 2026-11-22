// ct-73198: "Failed to construct 'WebSocket': the provided URL is invalid".
// The loopback terminal socket is built from whatever port endpoint discovery
// hands back. A malformed port (an unparseable dev override, a corrupted cached
// entry) must yield no endpoint, never one whose socket URL the browser rejects.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { ConvexReactClient } from "convex/react";
import { getTerminalEndpoint, termWsUrl } from "./endpoint";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}

const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
const saved = { local: g.localStorage, session: g.sessionStorage };
beforeEach(() => { g.localStorage = memoryStorage(); g.sessionStorage = memoryStorage(); });
afterEach(() => { g.localStorage = saved.local; g.sessionStorage = saved.session; });

const convex = {} as ConvexReactClient;

/** Whatever discovery returns must be openable: null, or a URL the browser accepts. */
function expectOpenable(ep: Awaited<ReturnType<typeof getTerminalEndpoint>>) {
  if (ep === null) return;
  expect(() => new URL(termWsUrl(ep))).not.toThrow();
  expect(Number.isInteger(ep.port) && ep.port >= 1 && ep.port <= 65535).toBe(true);
}

test("a dev override with an unparseable port yields no endpoint", async () => {
  localStorage.setItem("CAST_TERM_ENDPOINT", "notaport:dev-token");
  const ep = await getTerminalEndpoint(convex);
  expectOpenable(ep);
  expect(ep).toBeNull();
});

test("a dev override with an out-of-range port yields no endpoint", async () => {
  localStorage.setItem("CAST_TERM_ENDPOINT", "99999:dev-token");
  const ep = await getTerminalEndpoint(convex);
  expectOpenable(ep);
  expect(ep).toBeNull();
});

test("a malformed cached endpoint is not handed back", async () => {
  sessionStorage.setItem("cast_term_endpoint", JSON.stringify({ port: "abc", token: "t", deviceId: "d", tmux: true }));
  const ep = await getTerminalEndpoint(convex, { trustCache: true });
  expectOpenable(ep);
});

test("guard: a well-formed dev override still resolves", async () => {
  localStorage.setItem("CAST_TERM_ENDPOINT", "42871:dev-token");
  const ep = await getTerminalEndpoint(convex);
  expect(ep?.port).toBe(42871);
  expect(termWsUrl(ep!)).toBe("ws://127.0.0.1:42871/term/ws");
});
