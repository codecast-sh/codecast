// Which links in agent prose are worth PREVIEWING instead of following.
//
// An agent that starts a dev server prints its address, and that address is
// the one link in a transcript the reader almost always wants to look at
// rather than navigate away to: it is a page they are building, next to the
// work that built it. So a loopback URL renders as a pill that opens a
// browser pane (components/LoopbackUrlPill.tsx) instead of a plain anchor.
//
// Loopback and nothing else. A public URL in a transcript means "go read
// this", and most public sites refuse to be framed anyway; a link to
// localhost means "look at what I just built", and Chrome treats loopback as
// a trustworthy origin, so it frames with no proxy and no certificate.

import { displayHost, isLoopbackUrl, normalizeUrl } from "./browserPane";

/**
 * The address this href names when it is a loopback page, else null. Only an
 * explicit http(s) scheme qualifies: a bare "localhost:3000" never reaches a
 * link renderer as an href, and guessing a scheme for anything else would
 * turn a relative path into a page.
 */
export function loopbackLinkUrl(href: string | null | undefined): string | null {
  if (!href || !/^https?:\/\//i.test(href)) return null;
  const url = normalizeUrl(href);
  return url && isLoopbackUrl(url) ? url : null;
}

/** How long a pill's label may run before the middle of the path is cut. The
 *  pill sits inline in a sentence, so it may not push the line around. */
const LABEL_MAX = 38;

/**
 * What a pill or a recents row reads: host, port, and the path when there is
 * one —
 * "localhost:3000", "localhost:3000/inbox". The path matters, because two
 * links to the same dev server usually differ only there. A long path keeps
 * its start and its end, since both ends carry meaning and the middle rarely
 * does.
 */
export function pageAddressLabel(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const path = (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")) + u.search;
  const label = displayHost(url) + path;
  if (label.length <= LABEL_MAX) return label;
  return `${label.slice(0, LABEL_MAX - 9)}…${label.slice(-8)}`;
}

/**
 * The address a person typed, when they typed one — for the command palette,
 * where every keystroke is also a search for tasks, docs and sessions.
 *
 * Stricter than normalizeUrl on purpose: normalizeUrl answers "can this be a
 * URL", which a bare word like "tasks" technically can (a machine on this
 * network could be called that). The palette needs "did they MEAN a URL",
 * so a string only counts with a scheme, a port, or a real domain suffix.
 */
export function typedAddress(text: string): string | null {
  const raw = text.trim();
  if (!raw || /\s/.test(raw)) return null;
  const host = raw.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "").split(/[/?#]/)[0];
  const addressed =
    /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) || /:\d{2,5}$/.test(host) || /\.[a-z]{2,}$/i.test(host);
  return addressed ? normalizeUrl(raw) : null;
}
