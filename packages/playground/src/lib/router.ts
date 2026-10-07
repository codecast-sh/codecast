// The shell's three addresses (SPEC "Open an app link"):
//   /[?make]          home, with the maker focused on ?make
//   /<slug>[?room]    an app on its live version, the room open with ?room
//   /<slug>/v/<n>     an app on version n, viewing the past
// Slugs always carry a hyphenated tail (convex/lib/slugs), so no slug can
// shadow a route the shell might add later.
import { useSyncExternalStore } from "react";
import { isSlug } from "../../convex/lib/slugs";
import type { AppLink } from "../../runtime/protocol";

export type Route =
  | { kind: "home" }
  | { kind: "app"; slug: string; version: number | null; room: boolean }
  | { kind: "missing" };

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { kind: "home" };
  const [slug, v, n] = parts;
  if (!isSlug(slug)) return { kind: "missing" };
  const room = new URLSearchParams(search).has("room");
  if (parts.length === 1) return { kind: "app", slug, version: null, room };
  if (parts.length === 3 && v === "v" && /^[1-9]\d{0,5}$/.test(n)) return { kind: "app", slug, version: Number(n), room };
  return { kind: "missing" };
}

export const MAKE_PARAM = "make";
export const makeUrl = `/?${MAKE_PARAM}`;
export const appUrl = (slug: string) => `/${slug}`;
export const roomUrl = (slug: string) => `/${slug}?room`;
export const versionUrl = (slug: string, n: number) => `/${slug}/v/${n}`;
export const absolute = (path: string) => new URL(path, location.origin).href;

/** What an app's SDK is told about its own links (runtime/protocol AppLink). */
export const appLink = (slug: string, name: string): AppLink => ({ name, link: absolute(appUrl(slug)), room: absolute(roomUrl(slug)) });

/** Whether a click on an in-app link should move in place: a plain primary
 *  click. Modified clicks keep the browser's meaning (a new tab, a window). */
export function isPlainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

const CHANGE = "clayground:navigate";

export function navigate(path: string, { replace = false } = {}): void {
  if (path === location.pathname + location.search) return;
  history[replace ? "replaceState" : "pushState"](null, "", path);
  window.dispatchEvent(new Event(CHANGE));
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener(CHANGE, cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener(CHANGE, cb);
  };
}

const href = () => location.pathname + location.search;

export function useLocation(): string {
  return useSyncExternalStore(subscribe, href);
}
