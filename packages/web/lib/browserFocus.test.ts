import { describe, expect, test } from "bun:test";
import { extractBrowserTabId, focusBrowserTab, reopenBrowserTab, type FocusTabDeps } from "./browserFocus";
import type { TerminalEndpoint } from "./terminal/endpoint";

// convex is only touched when no getEndpoint override is passed; every test
// here injects one, so a bare object stands in for the client.
const convex = {} as never;

const endpoint: TerminalEndpoint = { port: 4242, token: "tok", deviceId: "dev-1", tmux: true };
const fresh: TerminalEndpoint = { port: 5151, token: "tok2", deviceId: "dev-1", tmux: true };

function response(status: number, body: unknown = null): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/** A fake daemon: records every request, answers by url. */
function daemon(answer: (url: string, init?: RequestInit) => Response | Error, seen: { url: string; auth?: string; body?: string }[] = []): FocusTabDeps["fetchImpl"] {
  return (async (url: string, init?: RequestInit) => {
    seen.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.Authorization, body: init?.body as string | undefined });
    const out = answer(String(url), init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
}

describe("extractBrowserTabId", () => {
  test("reads the tab line the CLI prints after open", () => {
    expect(extractBrowserTabId("Example Domain\nhttps://example.com/\ntab 4A2CDC7E — next: cast browser snapshot")).toBe("4A2CDC7E");
  });

  test("last mention wins when a wedged tab was replaced", () => {
    expect(extractBrowserTabId("tab 11111111 was wedged, replaced\ntab 22222222 — next: cast browser snapshot")).toBe("22222222");
  });

  test("ignores --tab flags in recovery hints", () => {
    expect(extractBrowserTabId("try: cast browser close --tab 4A2CDC7E")).toBeNull();
  });

  test("sees through ANSI color codes", () => {
    expect(extractBrowserTabId("\x1b[2mtab 4A2CDC7E\x1b[0m")).toBe("4A2CDC7E");
  });

  test("requires exactly the 8-char short id", () => {
    expect(extractBrowserTabId("tab 4A2C")).toBeNull();
    expect(extractBrowserTabId("")).toBeNull();
  });
});

describe("focusBrowserTab — what the pill learns", () => {
  test("daemon confirms focus, straight off the trusted cache with no probe", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const asked: unknown[] = [];
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async (opts) => (asked.push(opts), endpoint),
      fetchImpl: daemon(() => response(200, { ok: true }), seen),
    });
    expect(out).toEqual({ ok: true });
    expect(seen).toEqual([{ url: "http://127.0.0.1:4242/browser/focus?tab=4A2CDC7E", auth: "Bearer tok" }]);
    expect(asked).toEqual([{ trustCache: true }]);
  });

  test("no local endpoint (other machine / daemon down) → no-daemon", async () => {
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => null,
      fetchImpl: daemon(() => response(200, { ok: true })),
    });
    expect(out).toEqual({ ok: false, reason: "no-daemon" });
  });

  test("the daemon's tab-not-found becomes tab-gone; browser-stopped stays", async () => {
    const gone = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: daemon(() => response(404, { ok: false, reason: "tab-not-found" })),
    });
    expect(gone).toEqual({ ok: false, reason: "tab-gone" });
    const stopped = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: daemon(() => response(404, { ok: false, reason: "browser-stopped" })),
    });
    expect(stopped).toEqual({ ok: false, reason: "browser-stopped" });
  });

  test("a dead cached endpoint re-runs discovery once and retries there", async () => {
    const seen: { url: string; auth?: string }[] = [];
    const asked: unknown[] = [];
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async (opts) => (asked.push(opts), opts.force ? fresh : endpoint),
      fetchImpl: daemon((url) => (url.includes(":4242/") ? new TypeError("Failed to fetch") : response(200, { ok: true })), seen),
    });
    expect(out).toEqual({ ok: true });
    expect(asked).toEqual([{ trustCache: true }, { force: true }]);
    expect(seen.map((s) => s.auth)).toEqual(["Bearer tok", "Bearer tok2"]);
  });

  test("a stale token (403) is treated like a dead endpoint", async () => {
    const asked: unknown[] = [];
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async (opts) => (asked.push(opts), opts.force ? fresh : endpoint),
      fetchImpl: daemon((url) => (url.includes(":4242/") ? response(403, { error: "forbidden" }) : response(200, { ok: true }))),
    });
    expect(out).toEqual({ ok: true });
    expect(asked).toHaveLength(2);
  });

  test("a daemon that times out is unreachable, not gone — no reopen offer", async () => {
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: daemon(() => Object.assign(new Error("timed out"), { name: "TimeoutError" })),
    });
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });

  test("an older daemon without the route (plain 404, no body) is unreachable", async () => {
    const out = await focusBrowserTab(convex, "4A2CDC7E", {
      getEndpoint: async () => endpoint,
      fetchImpl: daemon(() => ({ ok: false, status: 404, json: async () => { throw new SyntaxError("no body"); } }) as unknown as Response),
    });
    expect(out).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("reopenBrowserTab", () => {
  test("posts the page and the session, returns the new tab", async () => {
    const seen: { url: string; body?: string }[] = [];
    const out = await reopenBrowserTab(
      convex,
      { url: "https://example.com/x", sessionUuid: "u-1", tmuxSession: "cc-1" },
      { getEndpoint: async () => endpoint, fetchImpl: daemon(() => response(200, { ok: true, tabId: "2BE86883", focused: true }), seen) },
    );
    expect(out).toEqual({ ok: true, tabId: "2BE86883" });
    expect(seen[0].url).toBe("http://127.0.0.1:4242/browser/reopen");
    expect(JSON.parse(seen[0].body!)).toEqual({ url: "https://example.com/x", session_uuid: "u-1", tmux_session: "cc-1" });
  });

  test("the CLI's refusal comes back with its last line", async () => {
    const out = await reopenBrowserTab(
      convex,
      { url: "https://example.com", sessionUuid: "u-1" },
      { getEndpoint: async () => endpoint, fetchImpl: daemon(() => response(502, { ok: false, reason: "open-failed", detail: "site is walled off" })) },
    );
    expect(out).toEqual({ ok: false, reason: "open-failed", detail: "site is walled off" });
  });

  test("no daemon here means nothing to reopen into", async () => {
    const out = await reopenBrowserTab(convex, { url: "https://example.com" }, { getEndpoint: async () => null, fetchImpl: daemon(() => response(200)) });
    expect(out).toEqual({ ok: false, reason: "no-daemon" });
  });
});
