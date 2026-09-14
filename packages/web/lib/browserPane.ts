// The browser pane's pure layer: the route it lives at, the URL it points at,
// and which backend renders it. No React, no DOM — everything here is a plain
// function so the pane, the tab bar, the stage helpers and the tests all read
// the same answers.
//
// The route carries the source, because a stage leaf IS its path (see
// store/stageSplit.ts): a pane that keeps its URL in component state would
// lose it on a reload, a split, or a drag to another tab.
//
//   /browser?u=<url>            a page by URL         → frame or native backend
//   /browser?watch=<uuid>       an agent's live tab   → stream backend
//   /browser?u=<url>&native=1   the user asked for the native view (desktop)

export type BrowserSource =
  // `session` is the agent session the page was offered by (the chip on the
  // session header, ct-51075). It rides the path as `s=` so the desktop's
  // native view can record who the pane is for: that is what lets that
  // session's `cast browser` find and drive this exact view over the app's
  // CDP port (packages/electron/browserPanes.js). A pane the human opened by
  // hand has none, and no agent may claim it.
  | { kind: "url"; url: string; session?: string }
  | { kind: "watch"; sessionUuid: string };

export type BrowserBackendKind = "frame" | "stream" | "native";

export const BROWSER_ROUTE = "/browser";

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Hosts that mean "the machine this window runs on". */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h === "::1") return true;
  if (h.endsWith(".localhost")) return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A hostname that can only be answered by a machine on this network: a bare
 *  name with no dot ("dev-box"), an .internal/.local name, or loopback. Those
 *  get http://, since nothing on a private network serves TLS by default. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".test")) return true;
  if (!h.includes(".")) return true;
  // RFC1918 and the link-local block: a LAN address, not a public site.
  return (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * What the user typed, as a URL the pane can load — or null when it is not a
 * web address at all. Bare hosts get a scheme: http:// for anything only this
 * machine or this network can serve ("localhost:3000", "dev-box:8080"), https://
 * for the public web ("github.com/foo"). Any scheme other than http(s) is
 * refused, so a `javascript:` or `file:` string can never reach an iframe src.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  // A space means prose, not an address; the pane is not a search box.
  if (/\s/.test(raw)) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)
    ? raw
    : (isPrivateHost(raw.split("/")[0].split(":")[0]) ? "http://" : "https://") + raw;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  return u.toString();
}

/** True when this URL can only be served by the machine the window runs on. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** True when this URL can only be served by this machine or this network. */
export function isPrivateNetworkUrl(url: string): boolean {
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The short name a person reads as "where am I": host plus port when the port
 * is unusual ("localhost:3000", "github.com"). The leading "www." goes, since
 * it is noise in a 32px strip.
 */
export function displayHost(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/^www\./, "");
  return u.port ? `${host}:${u.port}` : host;
}

/**
 * The address as a person reads it, with no scheme: "localhost:3000/inbox?q=1".
 * The strip's lock or globe glyph already says http or https, and the full URL
 * is one hover or one click away.
 */
export function pageAddress(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return displayHost(url) + path + u.search + u.hash;
}

// ---------------------------------------------------------------------------
// Embed mode: the app, framed inside one of its own panes
// ---------------------------------------------------------------------------
//
// A pane can be pointed at codecast itself — someone types the address, an
// agent offers a codecast link, a published page links back. Framed as it
// stands, the app draws its whole shell a second time: a nav rail, a tab bar
// and a session rail, nested inside a pane of the app they belong to.
//
// So a framed codecast route carries a flag, and the shell that reads it
// renders the route alone. The flag rides the URL because the iframe's `src`
// is the only channel that exists before the framed document boots.

export const EMBED_PARAM = "embed";

/** Hosts that serve this same app. `window.location.origin` covers the usual
 *  case; these two cover the cross-environment one, so a prod link framed on a
 *  local checkout is still codecast inside codecast. */
const APP_HOSTS = new Set(["codecast.sh", "local.codecast.sh"]);

/** True when this address is served by the app doing the framing. */
export function isAppOrigin(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (typeof window !== "undefined" && window.location && u.origin === window.location.origin) {
    return true;
  }
  return APP_HOSTS.has(u.hostname.toLowerCase());
}

const RELATIVE_BASE = "https://pane.invalid";

/** Edit a URL's query without touching anything else about it, and without
 *  rewriting the string at all when the edit changes nothing — a re-serialized
 *  address differs from the one a person typed even when it means the same. */
function rewriteQuery(url: string, edit: (params: URLSearchParams) => boolean): string {
  const absolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
  let u: URL;
  try {
    u = new URL(url, absolute ? undefined : RELATIVE_BASE);
  } catch {
    return url;
  }
  if (!edit(u.searchParams)) return url;
  return absolute ? u.toString() : u.pathname + u.search + u.hash;
}

/** The same address, flagged as a pane's page. Takes a full URL or a bare path,
 *  and says the same thing twice in a row. */
export function withEmbedFlag(url: string): string {
  return rewriteQuery(url, (params) => {
    if (params.get(EMBED_PARAM) === "1") return false;
    params.set(EMBED_PARAM, "1");
    return true;
  });
}

/** The address without the flag: what a person reads in the strip, and what a
 *  route stores. The flag is how the pane talks to itself, not part of the
 *  page's identity. */
export function withoutEmbedFlag(url: string): string {
  return rewriteQuery(url, (params) => {
    if (!params.has(EMBED_PARAM)) return false;
    params.delete(EMBED_PARAM);
    return true;
  });
}

/** What a frame actually loads. A codecast route gets the flag; every other
 *  address is loaded exactly as it was given. */
export function paneSrc(url: string): string {
  return isAppOrigin(url) ? withEmbedFlag(url) : url;
}

/**
 * True when THIS document is a pane's page.
 *
 * Read once per document, never from a hook: the app rewrites its own address
 * as you move around it, and a shell that re-read the flag would grow its
 * chrome back mid-session on the first navigation. Cached on globalThis so a
 * hot reload cannot answer differently from the boot that built the tree.
 */
export const PANE_EMBED: boolean = ((globalThis as Record<string, unknown>).__codecastPaneEmbed ??=
  typeof window !== "undefined" &&
  !!window.location &&
  new URLSearchParams(window.location.search).get(EMBED_PARAM) === "1") as boolean;

type HistoryLike = {
  pushState: (state: unknown, unused: string, url?: string | URL | null) => void;
  replaceState: (state: unknown, unused: string, url?: string | URL | null) => void;
  __embedFlagKept?: boolean;
};

/**
 * Keep the flag on the address while the framed app navigates itself.
 *
 * Every navigation inside the app writes the whole URL — React Router's own
 * history, the stage's `syncUrl`, the inbox's session select — and each writer
 * passes a bare path, so the first click inside the frame would drop the flag
 * and the reload after it would bring the full shell back inside the pane.
 * Wrapping the two history verbs once covers every writer, including any added
 * later, and it runs only in a document that was loaded as a pane's page.
 */
export function keepEmbedFlagOnUrl(history?: HistoryLike): void {
  const h = history ?? (typeof window !== "undefined" ? (window.history as HistoryLike) : null);
  if (!h || h.__embedFlagKept) return;
  h.__embedFlagKept = true;
  for (const verb of ["pushState", "replaceState"] as const) {
    const original = h[verb].bind(h);
    h[verb] = (state: unknown, unused: string, url?: string | URL | null) =>
      original(state, unused, url == null ? url : withEmbedFlag(String(url)));
  }
}

// The one import-time side effect in this file, and it cannot fire outside an
// embedded document: PANE_EMBED is false in the app, in a test and on a server.
if (PANE_EMBED) keepEmbedFlagOnUrl();

/** The document title a route writes. A pane's page gives the bare title: the
 *  pane strip reads it, and the strip already says which app it is in. */
export function appDocumentTitle(title: string | null, embedded: boolean = PANE_EMBED): string {
  if (embedded) return title ?? "";
  return title ? `codecast | ${title}` : "codecast";
}

// ---------------------------------------------------------------------------
// Gestures from a pane's page
// ---------------------------------------------------------------------------
//
// A pane's page has no stage of its own; the window framing it does. So a
// gesture that places a pane (a localhost pill, "open beside" on a link) is
// posted up to that window, which places the pane on its own stage. Without
// this the gesture would navigate the frame away from the page it shows.

export type PaneMessage =
  | { type: "codecast:open-pane"; source: BrowserSource }
  | { type: "codecast:open-beside"; path: string };

type PaneWindow = {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void } | unknown;
  location: { origin: string; ancestorOrigins?: ArrayLike<string> };
};

const thisPaneWindow = (): PaneWindow | null =>
  PANE_EMBED && typeof window !== "undefined" ? (window as unknown as PaneWindow) : null;

/** True when this document is a pane's page with a window framing it, so pane
 *  gestures belong to that window's stage. */
export function hasPaneHost(win: PaneWindow | null = thisPaneWindow()): boolean {
  return !!win && win.parent !== win;
}

/**
 * Hand a gesture to the window framing this pane's page. False when this
 * document is not a pane's page, and the caller places the pane itself.
 *
 * The message goes only to an app origin: the framing window when Chrome names
 * it and it serves this app (a prod page framed on a local checkout), else this
 * document's own origin. A foreign site that frames a codecast page hears
 * nothing.
 */
export function postToPaneHost(message: PaneMessage, win: PaneWindow | null = thisPaneWindow()): boolean {
  if (!win || !hasPaneHost(win)) return false;
  const framing = win.location.ancestorOrigins?.[0];
  const target = framing && isAppOrigin(framing) ? framing : win.location.origin;
  (win.parent as Window).postMessage(message, target);
  return true;
}

/** A pane gesture posted by THIS frame's page, or null. The sender must be the
 *  frame itself, still on an app origin, and the payload must be one this
 *  window would have produced: an http(s) page or an in-app path. */
export function readPaneMessage(
  event: { origin: string; data: unknown; source: unknown },
  frame: unknown,
): PaneMessage | null {
  if (!frame || event.source !== frame || !isAppOrigin(event.origin)) return null;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") return null;
  if (data.type === "codecast:open-beside") {
    const path = data.path;
    return typeof path === "string" && path.startsWith("/") && !path.startsWith("//")
      ? { type: "codecast:open-beside", path }
      : null;
  }
  if (data.type === "codecast:open-pane") {
    const source = data.source as Record<string, unknown> | null;
    if (source?.kind === "watch" && typeof source.sessionUuid === "string" && source.sessionUuid) {
      return { type: "codecast:open-pane", source: { kind: "watch", sessionUuid: source.sessionUuid } };
    }
    // Passed on as sent, not normalized: the host builds the same path the
    // gesture would have built unframed, so a pane already showing it is
    // focused rather than doubled.
    const url = source?.kind === "url" ? source.url : null;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !normalizeUrl(url)) return null;
    const session = typeof source?.session === "string" && source.session ? source.session : undefined;
    return { type: "codecast:open-pane", source: session ? { kind: "url", url, session } : { kind: "url", url } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Probing an address
// ---------------------------------------------------------------------------

/** What a probe can prove about an address, and nothing more. */
export type ProbeVerdict = "answered" | "unreachable" | "local-network-blocked";

type ProbeIo = {
  fetch: (url: string, init: RequestInit) => Promise<unknown>;
  permissions?: { query: (d: { name: string }) => Promise<{ state: string }> };
};

/**
 * Whether anything answers at `url`, asked the way the frame asks: no-cors, no
 * credentials, no referrer (the frame sends none, so the probe may not either).
 * HEAD first, because a GET downloads the page a second time; GET only when the
 * HEAD itself failed, since a server that dislikes HEAD still answers it.
 *
 * A failed request is not yet "nothing is listening". Chrome's Local Network
 * Access refuses a public page's requests to this machine or this network, and
 * that refusal fails exactly like a closed port. The permission state is the
 * only thing that tells them apart, so it is read after a failure, and only
 * "denied" counts: "prompt" is also what a page on a local origin reads, where
 * no permission applies and the port really is closed.
 */
export async function probeAddress(url: string, io?: ProbeIo): Promise<ProbeVerdict> {
  const { fetch: send, permissions } = io ?? {
    fetch: (u: string, init: RequestInit) => globalThis.fetch(u, init),
    permissions: globalThis.navigator?.permissions as ProbeIo["permissions"],
  };
  const init: RequestInit = {
    mode: "no-cors",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
  for (const method of ["HEAD", "GET"]) {
    try {
      await send(url, { ...init, method });
      return "answered";
    } catch {
      // Try the next method; a verdict needs both to fail.
    }
  }
  if (!isPrivateNetworkUrl(url) || !permissions) return "unreachable";
  // Chrome named the permission "local-network-access", then split it by
  // target. A name this Chrome does not know throws, and is skipped.
  const names = isLoopbackUrl(url)
    ? ["loopback-network", "local-network-access"]
    : ["local-network", "local-network-access"];
  for (const name of names) {
    try {
      if ((await permissions.query({ name })).state === "denied") return "local-network-blocked";
    } catch {
      // Unknown permission name in this browser.
    }
  }
  return "unreachable";
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** True for any `/browser` path, including a bare one that points nowhere yet
 *  (the palette's "Open a URL in a pane"). That pane is still a browser pane:
 *  it draws its own header and wears the browser label. */
export function isBrowserRoutePath(path: string): boolean {
  return path.split("#")[0].split("?")[0] === BROWSER_ROUTE;
}

/** The source a `/browser` path points at, or null when the path is not one
 *  (or carries nothing loadable). */
export function parseBrowserRoute(path: string): BrowserSource | null {
  if (!isBrowserRoutePath(path)) return null;
  const params = new URLSearchParams(path.split("#")[0].split("?")[1] ?? "");
  const watch = params.get("watch");
  if (watch) return { kind: "watch", sessionUuid: watch };
  const u = params.get("u");
  if (!u) return null;
  const url = normalizeUrl(u);
  if (!url) return null;
  const session = params.get("s");
  return session ? { kind: "url", url, session } : { kind: "url", url };
}

/** True when this path asked for the native view (the user chose it). */
export function prefersNativeRoute(path: string): boolean {
  const query = path.split("#")[0].split("?")[1] ?? "";
  return new URLSearchParams(query).get("native") === "1";
}

/** The path that shows this source. `native` rides the path too, so the choice
 *  survives a reload and a drag exactly like the URL does. */
export function browserRoutePath(source: BrowserSource, opts?: { native?: boolean }): string {
  const params = new URLSearchParams();
  if (source.kind === "watch") params.set("watch", source.sessionUuid);
  else {
    params.set("u", source.url);
    if (source.session) params.set("s", source.session);
  }
  if (opts?.native) params.set("native", "1");
  return `${BROWSER_ROUTE}?${params.toString()}`;
}

/** The label a browser path wears in a tab, a pane strip or a recents row:
 *  the page title once a backend has read one, else the host. */
export function browserPathLabel(path: string): string {
  const source = parseBrowserRoute(path);
  if (!source) return "Browser";
  if (source.kind === "watch") return "Agent tab";
  return browserTitle(source.url) ?? displayHost(source.url);
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

export type BrowserEnv = {
  /** Running inside the desktop shell. */
  desktop: boolean;
  /** The desktop build exposes the native view bridge. */
  nativeAvailable: boolean;
  /** This URL is known to refuse framing (the user said so, or a backend
   *  proved it). */
  refused: boolean;
  /** The route asked for the native view. */
  preferNative: boolean;
};

/**
 * Which backend renders this source. A watched tab is always the stream. A URL
 * is a frame unless the native view is both available and wanted — wanted
 * meaning the user picked it, or the frame was refused and native is the only
 * way to show the page at all.
 */
export function selectBackend(source: BrowserSource, env: BrowserEnv): BrowserBackendKind {
  if (source.kind === "watch") return "stream";
  if (env.desktop && env.nativeAvailable && (env.preferNative || env.refused)) return "native";
  return "frame";
}

// ---------------------------------------------------------------------------
// Titles a backend has learned
// ---------------------------------------------------------------------------

// A frame can only report its title when it is same-origin (verified in Chrome
// on 2026-09-13: a cross-origin frame's contentDocument is null). The title is
// therefore knowledge the PANE happens to have, not server data the store owns
// — so it lives here, next to the path helpers that need it, and everything
// that labels a browser path reads through browserPathLabel.
const titles = new Map<string, string>();
const listeners = new Set<() => void>();

export function rememberBrowserTitle(url: string, title: string | null): void {
  const clean = (title ?? "").trim();
  if (clean ? titles.get(url) === clean : !titles.has(url)) return;
  if (clean) titles.set(url, clean);
  else titles.delete(url);
  for (const fn of listeners) fn();
}

export function browserTitle(url: string): string | undefined {
  return titles.get(url);
}

/** Subscribe to learned titles (useSyncExternalStore in the pane strip). */
export function subscribeBrowserTitles(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
