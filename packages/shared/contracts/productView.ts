// Product views: a connected app's own screens, framed inside codecast
// (docs/architecture/external-data.md X8, views). The app declares each view
// in its manifest (`views: [{ name, title, path, params }]`) and mints a
// short-lived token for one view of one id through its `views.token` action;
// codecast frames `<app origin><path>?token=<token>` and never holds a
// person's session with the app.
//
// A reference names one view of one thing in text a model or a person
// writes: `union:conversation/<contact id>@2026-10-09T14:03:00Z`, or
// `union:call/<call id>`. `at` asks for the state as of that moment (what a
// judge saw then); the app leaves out what came after it.
//
// The frame talks to the page embedding it the way the replay player does
// (contracts/replayPlayer.ts): every message is tagged with a source, it
// posts only to the host's origin (location.ancestorOrigins where the
// browser has it, else the origin of the host's first `hello`), and until it
// knows that origin it posts nothing but a bare `hello`.

export const PRODUCT_VIEW_SOURCE = "codecast-product-view";
export const PRODUCT_VIEW_HOST_SOURCE = "codecast-product-view-host";

export interface ProductViewRef {
  /** The connected app's manifest name, e.g. "union". */
  app: string;
  /** A view name the app's manifest declares. */
  view: string;
  id: string;
  /** An ISO time: the view as of that moment. */
  at: string | null;
}

const APP_RE = /^[a-z][a-z0-9-]{0,39}$/;
const VIEW_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** A moment the reference may name: an ISO date-time that parses. */
export function isProductViewAt(at: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at));
}

/** `<app>:<view>/<id>[@<iso>]`, or null when any part is malformed. */
export function parseProductViewRef(raw: string): ProductViewRef | null {
  const m = /^([^:\s]+):([^/\s]+)\/([^@\s]+)(?:@(\S+))?$/.exec(raw.trim());
  if (!m) return null;
  const [, app, view, id, at] = m;
  if (!APP_RE.test(app) || !VIEW_RE.test(view) || !ID_RE.test(id)) return null;
  if (at !== undefined && !isProductViewAt(at)) return null;
  return { app, view, id, at: at ?? null };
}

export function formatProductViewRef(ref: ProductViewRef): string {
  return `${ref.app}:${ref.view}/${ref.id}${ref.at ? `@${ref.at}` : ""}`;
}

/** One view an app's manifest declares. `path` is under the app's web origin; `params` are the query params it reads beside the token. */
export interface ProductViewDef {
  name: string;
  title: string;
  description?: string;
  path: string;
  params: string[];
}

/** What `views.token` answers: the frame url (token included) and when the token stops opening it. */
export interface ProductViewToken {
  url: string;
  token: string;
  expires_at: string;
}

/** Frame to host. */
export type ProductViewMessage =
  /** The frame does not know its host's origin yet; it carries nothing. A host answers with its own `hello`. */
  | { source: typeof PRODUCT_VIEW_SOURCE; type: "hello" }
  /** The view drew its content; `height` is the document's height in CSS px. */
  | { source: typeof PRODUCT_VIEW_SOURCE; type: "ready"; height: number }
  /** The content's height changed. */
  | { source: typeof PRODUCT_VIEW_SOURCE; type: "height"; height: number }
  /** The view could not draw (an expired or refused token, a missing record). */
  | { source: typeof PRODUCT_VIEW_SOURCE; type: "error"; message: string };

/** Host to frame. */
export type ProductViewHostMessage = { source: typeof PRODUCT_VIEW_HOST_SOURCE; type: "hello" };

const isObj = (d: unknown): d is Record<string, unknown> => !!d && typeof d === "object";
const isHeight = (h: unknown): h is number => typeof h === "number" && Number.isFinite(h) && h >= 0;

/** A frame message, checked field by field (the host reads it from a page another app serves). */
export function parseProductViewMessage(d: unknown): ProductViewMessage | null {
  if (!isObj(d) || d.source !== PRODUCT_VIEW_SOURCE) return null;
  if (d.type === "hello") return { source: PRODUCT_VIEW_SOURCE, type: "hello" };
  if ((d.type === "ready" || d.type === "height") && isHeight(d.height)) {
    return { source: PRODUCT_VIEW_SOURCE, type: d.type, height: Math.min(Math.ceil(d.height), 20_000) };
  }
  if (d.type === "error" && typeof d.message === "string") {
    return { source: PRODUCT_VIEW_SOURCE, type: "error", message: d.message.slice(0, 500) };
  }
  return null;
}

export function isProductViewHostMessage(d: unknown): d is ProductViewHostMessage {
  return isObj(d) && d.source === PRODUCT_VIEW_HOST_SOURCE && d.type === "hello";
}

/** Second-level labels that are a public suffix's own ("example.co.uk"): a site under one is its three last labels. */
const SHARED_SECOND = new Set(["co", "com", "org", "net", "gov", "edu", "ac"]);

/** The site a host belongs to: the host's registrable part as far as a frame check needs it ("admin.union.example" is "union.example"). */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2 || /^\d+$/.test(labels[labels.length - 1])) return labels.join(".");
  const take = SHARED_SECOND.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Whether a frame url is codecast's own (`self`, the app's url): the same
 * origin, or any host on the same site (a published page under codecast.sh).
 * A product view frame is sandboxed with scripts and its own origin, which is
 * only safe when that origin is not the page's around it; a frame of our own
 * site could drop its sandbox and read the parent. On a loopback host only the
 * exact origin counts, since a developer's app and codecast share "localhost"
 * on different ports. An address that does not parse counts as our own: refuse.
 */
export function framesOwnSite(url: string, self: string): boolean {
  let u: URL;
  let own: URL;
  try {
    u = new URL(url);
    own = new URL(self);
  } catch {
    return true;
  }
  if (u.origin === own.origin) return true;
  const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";
  if (loopback(own.hostname) || loopback(u.hostname)) return false;
  return siteOf(u.hostname) === siteOf(own.hostname);
}
