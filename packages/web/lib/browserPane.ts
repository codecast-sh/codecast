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
  | { kind: "url"; url: string }
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

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** The source a `/browser` path points at, or null when the path is not one
 *  (or carries nothing loadable). */
export function parseBrowserRoute(path: string): BrowserSource | null {
  const [clean, query = ""] = path.split("#")[0].split("?");
  if (clean !== BROWSER_ROUTE) return null;
  const params = new URLSearchParams(query);
  const watch = params.get("watch");
  if (watch) return { kind: "watch", sessionUuid: watch };
  const u = params.get("u");
  if (!u) return null;
  const url = normalizeUrl(u);
  return url ? { kind: "url", url } : null;
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
  else params.set("u", source.url);
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
