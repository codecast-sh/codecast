// The app's own address bar (components/AppAddressBar.tsx): what a typed or
// pasted address means, and whether the bar is open.
//
// Anything that names a place in codecast opens in the app, whichever copy of
// the app the link came from: a prod link pasted into the desktop app or a
// local checkout, a bare path, a short id. Any other web address opens in a
// browser pane beside the work, so nothing typed here leaves the app.

import { useSyncExternalStore } from "react";
import { entityRoute, entityTypeFromId, normalizeEntityType } from "@codecast/shared/entities";
import { appPathOf, normalizeUrl, pageAddress, parseBrowserRoute } from "./browserPane";
import { typedAddress } from "./browserPaneLinks";
import { NAV_REGISTRY } from "./navRegistry";

export type AddressTarget = { kind: "app"; path: string } | { kind: "web"; url: string };

/** Where an address goes, or null when the text is not one. */
export function resolveAddress(input: string): AddressTarget | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
  if (raw.startsWith("/")) return raw.startsWith("//") ? null : { kind: "app", path: raw };
  // A short id names an object: ct-4102, pl-88, jx7c6zk, sd-12.
  const type = entityTypeFromId(raw);
  const objectPath = type ? entityRoute(type, raw) : null;
  if (objectPath) return { kind: "app", path: objectPath };
  const url = /^https?:\/\//i.test(raw) ? normalizeUrl(raw) : typedAddress(raw);
  if (url) {
    const path = appPathOf(url);
    return path ? { kind: "app", path } : { kind: "web", url };
  }
  // A bare route as people say it ("inbox", "tasks/ct-12", "org?tab=roles"),
  // when it starts at one of the app's pages. Any other word is not an
  // address: the bar reads it as a page title to look for instead.
  const m = raw.match(/^([a-z][\w-]*)(?:[/?#].*)?$/i);
  return m && isAppSection(m[1].toLowerCase()) ? { kind: "app", path: `/${raw}` } : null;
}

/** A first path segment that names one of the app's pages or object kinds. */
function isAppSection(segment: string): boolean {
  if (normalizeEntityType(segment)) return true;
  const base = `/${segment}`;
  return NAV_REGISTRY.some((row) => [row.path, ...((row as { match?: readonly string[] }).match ?? [])].some((p) => p === base || p.startsWith(`${base}/`)));
}

/**
 * A path as the bar shows it. A browser pane reads as the page it shows, and
 * a long opaque id (a Convex id, an optimistic stub) as its short head.
 */
export function displayPath(path: string): string {
  const route = parseBrowserRoute(path);
  if (route?.kind === "url") return pageAddress(route.url);
  return path.replace(/\b([a-z0-9]{7})[a-z0-9]{9,}\b/g, "$1…");
}

// ---------------------------------------------------------------------------
// Open state. A gesture, not a place, and nothing else reads it, so it lives
// here rather than in the store: the menu row and the shortcut open it, the
// host in the shell draws it.
// ---------------------------------------------------------------------------

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setAppAddressBarOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function toggleAppAddressBar(): void {
  setAppAddressBarOpen(!open);
}

export function useAppAddressBarOpen(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => open,
    () => false,
  );
}
