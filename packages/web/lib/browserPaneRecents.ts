// The last few pages opened in a browser pane, per browser profile.
//
// A blank pane asks "what now", and the honest answer for most people is
// "the thing I was just looking at". This ring is that answer: eight URLs,
// newest first, written by the one gesture funnel every pane opens through
// (openBrowserPane in lib/stage.ts) and read by the blank pane's empty state.
//
// localStorage, not the store: these are addresses this browser happened to
// visit, not team data anyone else can see, and a pane opened on a colleague's
// machine pointing at THEIR localhost would be a lie. Keeping the ring local
// to the window's own profile keeps it true.

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
