// An agent offering a web page as a pane: `cast browser pane <url>` writes one
// offer onto the conversation, and the viewer's header shows a chip that opens
// it beside the conversation.
//
// Agents ask, humans decide. The view-motion guard (web store/viewNav.ts)
// already forbids a machine from moving the visible conversation, and the same
// rule holds here: nothing an agent writes may open a pane on its own. The
// offer is data; the gesture stays with the reader (or with a preference the
// reader turned on themselves).
//
// This file is the wire shape plus the one piece of logic all three runtimes
// need — turning what an agent typed into a URL a pane can load. The CLI
// normalizes so it can print the address it offered, Convex normalizes again
// because a stored URL is reached by an iframe src and must never carry a
// `javascript:` payload, and the web reads the result.

/** The single latest offer on a conversation. Not a list: an agent that runs
 *  three dev servers is telling the reader about the newest one, and a queue of
 *  stale addresses is worse than the freshest answer. */
export type BrowserPaneOffer = {
  url: string;
  /** What the agent called the page, when it said. */
  title?: string;
  offered_at: number;
  /** Set when the reader opened or dismissed the offer; the chip is gone from
   *  that moment, and the field is what makes "already handled" survive a
   *  reload on another device. */
  opened_at?: number;
};

/** Hosts that mean "the machine this process runs on". */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "[::1]" || h === "::1") return true;
  if (h.endsWith(".localhost")) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** A host only this machine or this network can answer: loopback, a bare name
 *  with no dot, an .internal/.local/.test name, or a private range. Those get
 *  http://, because nothing on a private network serves TLS by default. */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".test")) return true;
  if (!h.includes(".")) return true;
  return (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

/**
 * What the agent typed, as a URL a pane can load — or null when it is not a
 * web address. `localhost:3000` becomes http://localhost:3000/ and
 * `github.com/foo` becomes https://github.com/foo, because a bare host with a
 * port is a dev server and a public name is not. Any scheme other than http(s)
 * is refused: this string ends up in an iframe src, so `javascript:` and
 * `file:` must not survive the trip.
 */
export function normalizePaneUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;
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

/** True when only the machine the agent ran on can serve this address. The
 *  chip says so, since a reader on another laptop gets a dead pane. */
export function isLoopbackPaneUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** An offer nobody acted on goes quiet after a day. The dev server it names is
 *  long dead by then, and a chip that never expires teaches people to ignore
 *  chips. */
export const PANE_OFFER_TTL_MS = 24 * 60 * 60 * 1000;
