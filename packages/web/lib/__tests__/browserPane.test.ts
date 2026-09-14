import { describe, expect, it } from "bun:test";
import {
  appDocumentTitle,
  browserPathLabel,
  browserRoutePath,
  displayHost,
  isAppOrigin,
  isBrowserRoutePath,
  isLoopbackUrl,
  keepEmbedFlagOnUrl,
  normalizeUrl,
  hasPaneHost,
  pageAddress,
  paneSrc,
  parseBrowserRoute,
  postToPaneHost,
  probeAddress,
  prefersNativeRoute,
  readPaneMessage,
  rememberBrowserTitle,
  selectBackend,
  withEmbedFlag,
  withoutEmbedFlag,
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

describe("embed mode", () => {
  // The pane frames the app inside the app, so the framed copy has to be told
  // to render one route and no shell. These are the two halves of that: which
  // addresses get told, and how the telling survives the app moving around.

  function withWindow<T>(origin: string, run: () => T): T {
    const had = "window" in globalThis;
    const before = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = { location: { origin, search: "" } };
    try {
      return run();
    } finally {
      if (had) (globalThis as Record<string, unknown>).window = before;
      else delete (globalThis as Record<string, unknown>).window;
    }
  }

  it("flags an address this app serves", () => {
    expect(paneSrc("https://codecast.sh/inbox")).toBe("https://codecast.sh/inbox?embed=1");
    expect(paneSrc("https://local.codecast.sh/tasks?p=x")).toBe(
      "https://local.codecast.sh/tasks?p=x&embed=1",
    );
    // A prod link framed on a local checkout is still codecast inside codecast.
    withWindow("http://localhost:3200", () => {
      expect(isAppOrigin("https://codecast.sh/inbox")).toBe(true);
      expect(paneSrc("http://localhost:3200/docs")).toBe("http://localhost:3200/docs?embed=1");
    });
  });

  it("hands a foreign address to the frame exactly as given", () => {
    // Byte for byte: a site's own query is its business, and re-serializing it
    // is a change the pane has no reason to make.
    expect(paneSrc("https://github.com/codecast/codecast?tab=readme")).toBe(
      "https://github.com/codecast/codecast?tab=readme",
    );
    expect(paneSrc("http://localhost:3000/app#top")).toBe("http://localhost:3000/app#top");
    expect(paneSrc("not a url")).toBe("not a url");
  });

  it("says the same thing twice in a row", () => {
    const once = paneSrc("https://codecast.sh/inbox");
    expect(paneSrc(once)).toBe(once);
    expect(withEmbedFlag(withEmbedFlag("/inbox"))).toBe("/inbox?embed=1");
  });

  it("carries the flag on a bare path, keeping the rest of the address", () => {
    expect(withEmbedFlag("/inbox?s=jx7abc#msg-4")).toBe("/inbox?s=jx7abc&embed=1#msg-4");
    expect(withEmbedFlag("/tasks")).toBe("/tasks?embed=1");
  });

  it("takes the flag back off, and leaves an address without one alone", () => {
    expect(withoutEmbedFlag("https://codecast.sh/inbox?embed=1")).toBe("https://codecast.sh/inbox");
    expect(withoutEmbedFlag("/inbox?s=jx7abc&embed=1")).toBe("/inbox?s=jx7abc");
    // Untouched, not merely equivalent: the strip shows what comes back here.
    expect(withoutEmbedFlag("http://localhost:3000/a?u=http://x.test/y")).toBe(
      "http://localhost:3000/a?u=http://x.test/y",
    );
  });

  it("keeps the flag through the app rewriting its own URL", () => {
    // Every navigation inside the frame writes a bare path. One wrap over the
    // two history verbs covers all of them — the shell's own tab-path rewrite
    // (`/inbox?s=<id>`), React Router, and the stage's split sync alike.
    const written: (string | null | undefined)[] = [];
    const history = {
      pushState: (_s: unknown, _u: string, url?: string | URL | null) => written.push(url as string),
      replaceState: (_s: unknown, _u: string, url?: string | URL | null) =>
        written.push(url as string),
    };
    keepEmbedFlagOnUrl(history);
    keepEmbedFlagOnUrl(history); // installing twice must not double-wrap
    history.pushState(null, "", "/tasks");
    history.replaceState(null, "", "/inbox?s=jx7abc");
    history.pushState(null, "", "/inbox?s=jx7abc&embed=1");
    history.replaceState(null, "", null);
    expect(written).toEqual([
      "/tasks?embed=1",
      "/inbox?s=jx7abc&embed=1",
      "/inbox?s=jx7abc&embed=1",
      null,
    ]);
  });
});

describe("gestures from a pane's page", () => {
  // A codecast page framed in a pane has no stage, so it posts its pane
  // gestures up and the framing window places them. Both ends are pinned here:
  // what goes out and to whom, and what the framing window agrees to act on.

  function framedWindow(origin: string, ancestor?: string) {
    const posted: { message: unknown; target: string }[] = [];
    const parent = { postMessage: (message: unknown, target: string) => posted.push({ message, target }) };
    const win = { parent, location: { origin, ancestorOrigins: ancestor ? [ancestor] : undefined } };
    return { win, posted };
  }

  it("posts the gesture to the framing window, addressed to an app origin", () => {
    const { win, posted } = framedWindow("https://local.codecast.sh", "https://local.codecast.sh");
    const source = { kind: "url" as const, url: "http://localhost:8765" };
    expect(postToPaneHost({ type: "codecast:open-pane", source }, win)).toBe(true);
    expect(postToPaneHost({ type: "codecast:open-beside", path: "/tasks/ct-1" }, win)).toBe(true);
    expect(posted).toEqual([
      { message: { type: "codecast:open-pane", source }, target: "https://local.codecast.sh" },
      { message: { type: "codecast:open-beside", path: "/tasks/ct-1" }, target: "https://local.codecast.sh" },
    ]);
  });

  it("addresses a prod page framed on a local checkout to the local window", () => {
    const { win, posted } = framedWindow("https://codecast.sh", "https://local.codecast.sh");
    postToPaneHost({ type: "codecast:open-beside", path: "/docs" }, win);
    expect(posted[0].target).toBe("https://local.codecast.sh");
  });

  it("never addresses a foreign site that frames a codecast page", () => {
    const { win, posted } = framedWindow("https://codecast.sh", "https://evil.example");
    postToPaneHost({ type: "codecast:open-beside", path: "/docs" }, win);
    // Its own origin: the browser drops the message, because the parent is not it.
    expect(posted[0].target).toBe("https://codecast.sh");
  });

  it("is not a pane's page without a framing window, or outside embed mode", () => {
    const top = { parent: null as unknown, location: { origin: "https://codecast.sh" } };
    top.parent = top;
    expect(hasPaneHost(top)).toBe(false);
    expect(postToPaneHost({ type: "codecast:open-beside", path: "/docs" }, top)).toBe(false);
    // The default reads PANE_EMBED, which is false outside a framed document.
    expect(hasPaneHost()).toBe(false);
    expect(postToPaneHost({ type: "codecast:open-beside", path: "/docs" })).toBe(false);
  });

  const frame = {};
  const event = (data: unknown, origin = "https://codecast.sh", source: unknown = frame) => ({
    data,
    origin,
    source,
  });

  it("acts only on a message from its own frame, on an app origin", () => {
    const beside = { type: "codecast:open-beside", path: "/tasks/ct-1" };
    expect(readPaneMessage(event(beside), frame)).toEqual(beside);
    expect(readPaneMessage(event(beside, "https://local.codecast.sh"), frame)).toEqual(beside);
    // A foreign page in the frame (the pane navigated to a site) is not the app.
    expect(readPaneMessage(event(beside, "http://localhost:8765"), frame)).toBeNull();
    expect(readPaneMessage(event(beside, "null"), frame)).toBeNull();
    // Another pane's frame, or no frame mounted: not this pane's gesture.
    expect(readPaneMessage(event(beside, "https://codecast.sh", {}), frame)).toBeNull();
    expect(readPaneMessage(event(beside), null)).toBeNull();
  });

  it("acts only on a payload the app itself would send", () => {
    const pane = (source: unknown) => readPaneMessage(event({ type: "codecast:open-pane", source }), frame);
    expect(pane({ kind: "url", url: "http://localhost:8765" })).toEqual({
      type: "codecast:open-pane",
      source: { kind: "url", url: "http://localhost:8765" },
    });
    expect(pane({ kind: "watch", sessionUuid: "abc-123" })).toEqual({
      type: "codecast:open-pane",
      source: { kind: "watch", sessionUuid: "abc-123" },
    });
    expect(pane({ kind: "url", url: "javascript:alert(1)" })).toBeNull();
    expect(pane({ kind: "url", url: "localhost:8765" })).toBeNull();
    expect(pane({ kind: "watch", sessionUuid: "" })).toBeNull();
    expect(pane(null)).toBeNull();

    const beside = (path: unknown) => readPaneMessage(event({ type: "codecast:open-beside", path }), frame);
    expect(beside("//evil.example/x")).toBeNull();
    expect(beside("https://evil.example/x")).toBeNull();
    expect(beside(42)).toBeNull();
    expect(readPaneMessage(event({ type: "something-else", path: "/docs" }), frame)).toBeNull();
    expect(readPaneMessage(event("codecast:open-beside"), frame)).toBeNull();
  });
});

describe("appDocumentTitle", () => {
  it("prefixes the app in a window, and gives a pane's strip the bare title", () => {
    expect(appDocumentTitle("Fix the auth race", false)).toBe("codecast | Fix the auth race");
    expect(appDocumentTitle(null, false)).toBe("codecast");
    expect(appDocumentTitle("Fix the auth race", true)).toBe("Fix the auth race");
    // Empty, so the strip falls back to its own label rather than showing "codecast".
    expect(appDocumentTitle(null, true)).toBe("");
  });
});
