// ct-73198: "Failed to construct 'WebSocket': the provided URL is invalid".
// Every loopback daemon socket builds its URL through one check, every source
// of an endpoint is checked where it is produced, and a construction that
// still throws lands on the socket's own failure path, never the global
// error reporter.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ConvexReactClient } from "convex/react";
import { forwardHostPort, getTerminalEndpoint, termWsUrl, type TerminalEndpoint } from "../terminal/endpoint";
import { connectBrowserWatch, watchWsUrl, type WatchHandlers } from "../browserWatch";
import { subscribeVaultEvents } from "../vault/client";
import { openWebSocket } from "../openWebSocket";

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

const g = globalThis as any;
const saved = { local: g.localStorage, session: g.sessionStorage, ws: g.WebSocket, fetch: g.fetch };
let constructed = 0;
beforeEach(() => {
  g.localStorage = memoryStorage();
  g.sessionStorage = memoryStorage();
  constructed = 0;
  g.WebSocket = class { constructor() { constructed++; } close() {} };
});
afterEach(() => {
  g.localStorage = saved.local;
  g.sessionStorage = saved.session;
  g.WebSocket = saved.ws;
  g.fetch = saved.fetch;
});

const convex = {} as ConvexReactClient;
const ep = (port: unknown, token: unknown = "tok") => ({ port, token, deviceId: "d", tmux: true }) as unknown as TerminalEndpoint;

function watchHandlers(log: string[]): WatchHandlers {
  return {
    onReady: () => log.push("ready"),
    onFrame: () => {},
    onTab: () => {},
    onError: (code) => log.push(`error:${code}`),
    onExit: (r) => log.push(`exit:${r}`),
  } as WatchHandlers;
}

describe("one check builds every loopback socket URL", () => {
  for (const [label, bad] of [
    ["port NaN", ep(NaN)],
    ["port undefined", ep(undefined)],
    ["port 0", ep(0)],
    ["port 70000", ep(70000)],
    ['port "abc"', ep("abc")],
    ["empty token", ep(42871, "")],
  ] as const) {
    test(`${label}: no URL, no socket, a failure instead of a throw`, async () => {
      expect(termWsUrl(bad)).toBeNull();
      expect(watchWsUrl(bad)).toBeNull();

      const log: string[] = [];
      expect(() => connectBrowserWatch(bad, {}, watchHandlers(log))).not.toThrow();
      await Promise.resolve();
      expect(log).toEqual(["error:socket"]);

      const vault: string[] = [];
      const stop = subscribeVaultEvents(bad, "v", {
        onEvent: () => {},
        onDown: () => vault.push("down"),
        onStale: () => vault.push("stale"),
      });
      expect(vault).toEqual(["down", "stale"]);
      stop();

      expect(constructed).toBe(0);
    });
  }

  test("guard: a valid endpoint still builds its URLs and opens", () => {
    expect(termWsUrl(ep(42871))).toBe("ws://127.0.0.1:42871/term/ws");
    expect(watchWsUrl(ep(42871))).toBe("ws://127.0.0.1:42871/watch/ws");
    subscribeVaultEvents(ep(42871), "v", { onEvent: () => {} })();
    expect(constructed).toBe(1);
  });
});

describe("every endpoint source is checked where it is produced", () => {
  for (const raw of ["abc:tok", ":tok", "123x:tok", "42871:"]) {
    test(`dev override ${JSON.stringify(raw)} yields no endpoint`, async () => {
      localStorage.setItem("CAST_TERM_ENDPOINT", raw);
      // No signed-in user, so discovery ends at null without a round trip.
      expect(await getTerminalEndpoint(convex)).toBeNull();
    });
  }

  for (const [label, raw] of [
    ["malformed JSON", "{not json"],
    ["missing port", JSON.stringify({ token: "t", deviceId: "d", tmux: true })],
    ["non-numeric port", JSON.stringify({ port: "abc", token: "t", deviceId: "d", tmux: true })],
  ] as const) {
    test(`a cached entry with ${label} is not handed back, and is cleared`, async () => {
      sessionStorage.setItem("cast_term_endpoint", raw);
      expect(await getTerminalEndpoint(convex, { trustCache: true })).toBeNull();
      expect(sessionStorage.getItem("cast_term_endpoint")).toBeNull();
    });
  }

  test("a forward reply with no port field yields no port", async () => {
    localStorage.setItem("CAST_TERM_ENDPOINT", "42871:tok");
    g.fetch = async () => new Response(JSON.stringify({}), { status: 200 });
    expect(await forwardHostPort(convex, "cloud-host", 22)).toBeNull();
    g.fetch = async () => new Response(JSON.stringify({ port: 51000 }), { status: 200 });
    expect(await forwardHostPort(convex, "cloud-host", 22)).toBe(51000);
  });
});

describe("a WebSocket constructor that throws reaches the socket's failure path", () => {
  beforeEach(() => {
    g.WebSocket = class {
      constructor() {
        throw new SyntaxError("Failed to construct 'WebSocket': the provided URL is invalid.");
      }
    };
  });

  test("openWebSocket returns null", () => {
    expect(openWebSocket("ws://127.0.0.1:1/x")).toBeNull();
    expect(openWebSocket("wss://example.test", ["realtime"])).toBeNull();
  });

  test("browser watch reports a socket error", async () => {
    const log: string[] = [];
    expect(() => connectBrowserWatch(ep(42871), {}, watchHandlers(log))).not.toThrow();
    await Promise.resolve();
    expect(log).toEqual(["error:socket"]);
  });

  test("the vault subscription reports down and stale", () => {
    const vault: string[] = [];
    expect(() =>
      subscribeVaultEvents(ep(42871), "v", {
        onEvent: () => {},
        onDown: () => vault.push("down"),
        onStale: () => vault.push("stale"),
      })(),
    ).not.toThrow();
    expect(vault).toEqual(["down", "stale"]);
  });
});
