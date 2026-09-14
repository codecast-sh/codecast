import { describe, expect, it } from "bun:test";
import {
  browserPathLabel,
  browserRoutePath,
  displayHost,
  isBrowserRoutePath,
  isLoopbackUrl,
  normalizeUrl,
  pageAddress,
  parseBrowserRoute,
  probeAddress,
  prefersNativeRoute,
  rememberBrowserTitle,
  selectBackend,
} from "../browserPane";

describe("normalizeUrl", () => {
  it("keeps an http(s) URL as given", () => {
    expect(normalizeUrl("https://github.com/codecast")).toBe("https://github.com/codecast");
    expect(normalizeUrl("  http://localhost:3000/x  ")).toBe("http://localhost:3000/x");
  });

  it("a bare public host gets https", () => {
    expect(normalizeUrl("github.com")).toBe("https://github.com/");
    expect(normalizeUrl("docs.example.org/guide")).toBe("https://docs.example.org/guide");
  });

  it("a bare host only this machine or this network serves gets http", () => {
    // Nothing on a dev box serves TLS, so https would fail on every one of these.
    expect(normalizeUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeUrl("127.0.0.1:8080/app")).toBe("http://127.0.0.1:8080/app");
    expect(normalizeUrl("dev-box:8080")).toBe("http://dev-box:8080/");
    expect(normalizeUrl("mini.local")).toBe("http://mini.local/");
    expect(normalizeUrl("192.168.1.4:5173")).toBe("http://192.168.1.4:5173/");
  });

  it("refuses anything that is not a web address", () => {
    // An iframe src must never take these: this is the gate that keeps a
    // javascript: string out of the pane.
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeUrl("data:text/html,<b>x")).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
    expect(normalizeUrl("how do I split a pane")).toBeNull();
  });
});

describe("isLoopbackUrl", () => {
  it("knows the whole loopback block, not just 127.0.0.1", () => {
    expect(isLoopbackUrl("http://localhost:3000/")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8765/")).toBe(true);
    expect(isLoopbackUrl("http://127.2.3.4/")).toBe(true);
    expect(isLoopbackUrl("http://app.localhost:5173/")).toBe(true);
    expect(isLoopbackUrl("https://codecast.sh/")).toBe(false);
    expect(isLoopbackUrl("http://192.168.1.4/")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("displayHost", () => {
  it("is the host, with the port when there is one", () => {
    expect(displayHost("http://localhost:3000/x?y=1")).toBe("localhost:3000");
    expect(displayHost("https://www.github.com/a/b")).toBe("github.com");
    expect(displayHost("https://codecast.sh/")).toBe("codecast.sh");
  });
});

describe("parseBrowserRoute / browserRoutePath", () => {
  it("round-trips a URL source", () => {
    const path = browserRoutePath({ kind: "url", url: "http://localhost:8765/" });
    expect(path.startsWith("/browser?u=")).toBe(true);
    expect(parseBrowserRoute(path)).toEqual({ kind: "url", url: "http://localhost:8765/" });
  });

  it("round-trips a watched session", () => {
    const path = browserRoutePath({ kind: "watch", sessionUuid: "abc-123" });
    expect(parseBrowserRoute(path)).toEqual({ kind: "watch", sessionUuid: "abc-123" });
  });

  it("carries the native choice in the path so it survives a reload", () => {
    const path = browserRoutePath({ kind: "url", url: "https://github.com/" }, { native: true });
    expect(prefersNativeRoute(path)).toBe(true);
    expect(prefersNativeRoute("/browser?u=https%3A%2F%2Fgithub.com%2F")).toBe(false);
    expect(parseBrowserRoute(path)).toEqual({ kind: "url", url: "https://github.com/" });
  });

  it("normalizes a hand-typed url in the query", () => {
    expect(parseBrowserRoute("/browser?u=localhost:3000")).toEqual({
      kind: "url",
      url: "http://localhost:3000/",
    });
  });

  it("is null for any other path, and for a source it cannot load", () => {
    expect(parseBrowserRoute("/inbox")).toBeNull();
    expect(parseBrowserRoute("/browsers?u=x")).toBeNull();
    expect(parseBrowserRoute("/browser")).toBeNull();
    expect(parseBrowserRoute("/browser?u=javascript:alert(1)")).toBeNull();
  });

  it("ignores a hash the shell may append", () => {
    expect(parseBrowserRoute("/browser?u=https%3A%2F%2Fcodecast.sh%2F#x")).toEqual({
      kind: "url",
      url: "https://codecast.sh/",
    });
  });
});

describe("selectBackend", () => {
  const env = {
    desktop: false,
    nativeAvailable: false,
    refused: false,
    preferNative: false,
  };
  const url = { kind: "url", url: "https://github.com/" } as const;

  it("a watched tab is always the stream", () => {
    expect(selectBackend({ kind: "watch", sessionUuid: "u" }, env)).toBe("stream");
    expect(selectBackend({ kind: "watch", sessionUuid: "u" }, { ...env, desktop: true, nativeAvailable: true, preferNative: true })).toBe("stream");
  });

  it("a URL frames by default, everywhere", () => {
    expect(selectBackend(url, env)).toBe("frame");
    expect(selectBackend(url, { ...env, desktop: true, nativeAvailable: true })).toBe("frame");
  });

  it("goes native when the user asked and the desktop can", () => {
    expect(selectBackend(url, { ...env, desktop: true, nativeAvailable: true, preferNative: true })).toBe("native");
  });

  it("goes native when the frame was refused and the desktop can", () => {
    expect(selectBackend(url, { ...env, desktop: true, nativeAvailable: true, refused: true })).toBe("native");
  });

  it("stays framed when the native view is wanted but unreachable", () => {
    // In the web app, and on a desktop build without the bridge, the frame is
    // the only backend there is — the pane says so rather than rendering nothing.
    expect(selectBackend(url, { ...env, preferNative: true, refused: true })).toBe("frame");
    expect(selectBackend(url, { ...env, desktop: true, preferNative: true })).toBe("frame");
  });
});

describe("browserPathLabel", () => {
  it("is the host until a backend reports a title", () => {
    const path = browserRoutePath({ kind: "url", url: "http://localhost:8765/" });
    expect(browserPathLabel(path)).toBe("localhost:8765");
    rememberBrowserTitle("http://localhost:8765/", "Local test page");
    expect(browserPathLabel(path)).toBe("Local test page");
    rememberBrowserTitle("http://localhost:8765/", null);
    expect(browserPathLabel(path)).toBe("localhost:8765");
  });

  it("names a watched tab and falls back for a broken path", () => {
    expect(browserPathLabel(browserRoutePath({ kind: "watch", sessionUuid: "u" }))).toBe("Agent tab");
    expect(browserPathLabel("/browser")).toBe("Browser");
  });
});

describe("isBrowserRoutePath", () => {
  it("is true for a bare /browser pane, which still draws its own header", () => {
    expect(isBrowserRoutePath("/browser")).toBe(true);
    expect(isBrowserRoutePath("/browser?u=http%3A%2F%2Flocalhost%3A3000")).toBe(true);
    expect(isBrowserRoutePath("/browser#x")).toBe(true);
    expect(isBrowserRoutePath("/browser?watch=abc")).toBe(true);
  });

  it("is false for anything else", () => {
    expect(isBrowserRoutePath("/browsers")).toBe(false);
    expect(isBrowserRoutePath("/browser/x")).toBe(false);
    expect(isBrowserRoutePath("/inbox?u=/browser")).toBe(false);
  });
});

describe("pageAddress", () => {
  it("drops the scheme and a bare trailing slash, keeps the rest", () => {
    expect(pageAddress("http://localhost:8765/")).toBe("localhost:8765");
    expect(pageAddress("http://localhost:8765/path/?q=1#top")).toBe("localhost:8765/path?q=1#top");
    expect(pageAddress("https://www.github.com/codecast")).toBe("github.com/codecast");
  });

  it("passes through what is not a URL", () => {
    expect(pageAddress("")).toBe("");
  });
});

describe("probeAddress", () => {
  const refused = () => Promise.reject(new TypeError("Failed to fetch"));
  const permissionsWith = (states: Record<string, string>) => ({
    query: async ({ name }: { name: string }) => {
      if (!(name in states)) throw new TypeError(`unknown permission ${name}`);
      return { state: states[name] };
    },
  });

  it("asks with HEAD, no credentials and no referrer", async () => {
    const calls: RequestInit[] = [];
    const verdict = await probeAddress("http://localhost:3000/", {
      fetch: async (_u, init) => {
        calls.push(init);
      },
    });
    expect(verdict).toBe("answered");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "HEAD",
      mode: "no-cors",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("falls back to GET only when HEAD fails", async () => {
    const methods: string[] = [];
    const verdict = await probeAddress("http://localhost:3000/", {
      fetch: (_u, init) => {
        methods.push(init.method!);
        return init.method === "HEAD" ? refused() : Promise.resolve();
      },
    });
    expect(verdict).toBe("answered");
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("says nothing answered when both fail and no permission was denied", async () => {
    const verdict = await probeAddress("http://localhost:3000/", {
      fetch: refused,
      permissions: permissionsWith({ "local-network-access": "prompt" }),
    });
    expect(verdict).toBe("unreachable");
  });

  it("names Chrome's local network refusal instead of claiming nothing listens", async () => {
    expect(
      await probeAddress("http://localhost:3000/", {
        fetch: refused,
        permissions: permissionsWith({ "local-network-access": "denied" }),
      }),
    ).toBe("local-network-blocked");
    // The split permission names: loopback reads its own, a LAN host its own.
    expect(
      await probeAddress("http://127.0.0.1:3000/", {
        fetch: refused,
        permissions: permissionsWith({ "loopback-network": "denied", "local-network": "granted" }),
      }),
    ).toBe("local-network-blocked");
    expect(
      await probeAddress("http://192.168.1.20:3000/", {
        fetch: refused,
        permissions: permissionsWith({ "loopback-network": "denied", "local-network": "granted" }),
      }),
    ).toBe("unreachable");
  });

  it("never blames the local network permission for a public host", async () => {
    const verdict = await probeAddress("https://example.com/", {
      fetch: refused,
      permissions: permissionsWith({ "local-network-access": "denied" }),
    });
    expect(verdict).toBe("unreachable");
  });
});
