// The last few pages opened in a browser pane, per browser profile.
//
// A blank pane asks "what now", and the honest answer for most people is
// "the thing I was just looking at". This ring is that answer: eight URLs,
// newest first, written by the gesture funnel every pane opens through
// (openBrowserPane in lib/stage.ts) and by the address bar when a person types
// a page, and read by the blank pane's empty state.
//
// localStorage, not the store: these are addresses this browser happened to
// visit, not team data anyone else can see, and a pane opened on a colleague's
// machine pointing at THEIR localhost would be a lie. Keeping the ring local
// to the window's own profile keeps it true.

import { pageAddress } from "./browserPane";

const KEY = "codecast.browserPaneRecents";
const CAP = 8;

/** localStorage, or null where it is missing or walled off (private mode,
 *  a blocked third-party context, server rendering). Never throws. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The ring, newest first. A corrupt or foreign value reads as empty rather
 *  than throwing into a render. */
export function browserPaneRecents(): string[] {
  const raw = (() => {
    try {
      return storage()?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((u): u is string => typeof u === "string" && !!u).slice(0, CAP);
  } catch {
    return [];
  }
}

/** Record a page a pane opened. Re-opening a page moves it to the front
 *  instead of doubling it, so the ring reads as places, not as a log. */
export function rememberBrowserPaneUrl(url: string): void {
  if (!url) return;
  const next = [url, ...browserPaneRecents().filter((u) => u !== url)].slice(0, CAP);
  try {
    storage()?.setItem(KEY, JSON.stringify(next));
  } catch {
    // A full or read-only store costs the reader a convenience, never a page.
  }
}

export function clearBrowserPaneRecents(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* see above */
  }
}

export interface AddressSuggestion {
  url: string;
  /** What the bar shows for it: the address without its scheme, unless the
   *  person typed a scheme, in which case the whole URL. */
  label: string;
}

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * The recent pages that match what is typed in the address bar, best first:
 * pages whose address starts with it (so the first can complete the field
 * inline), then pages whose host or path holds it. Case does not matter, and
 * a typed "www." is matched with or without one.
 */
export function suggestAddresses(typed: string, recents: string[], limit = 6): AddressSuggestion[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [];
  const full = SCHEME.test(q);
  const ranked: { s: AddressSuggestion; rank: number }[] = [];
  for (const url of recents) {
    const label = full ? url : pageAddress(url);
    const hay = label.toLowerCase();
    const rank = hay.startsWith(q) ? 0 : hay.startsWith(q.replace(/^www\./, "")) ? 0 : hay.includes(q) ? 1 : -1;
    if (rank >= 0) ranked.push({ s: { url, label }, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).slice(0, limit).map((r) => r.s);
}

/**
 * The tail the bar fills in after what was typed, selected so the next key
 * replaces it: the top suggestion's remainder when that suggestion starts
 * with the typed text, else nothing.
 */
export function inlineCompletion(typed: string, top: AddressSuggestion | undefined): string {
  if (!typed || !top) return "";
  return top.label.toLowerCase().startsWith(typed.toLowerCase()) ? top.label.slice(typed.length) : "";
}
