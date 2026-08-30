/**
 * Everything the app knows about URLs, with no React Native in it — so it is
 * testable, and so the same answers reach markdown prose, plain tool output,
 * code blocks, tapped links and incoming deep links.
 *
 * `lib/links.ts` is the half that actually opens things.
 */

import { parseEntityUrl, parseSharePath, isAppHost, type EntityType } from '@codecast/shared/entities';

/**
 * One URL vocabulary for every surface. `www.` hosts count: people paste them
 * constantly and a reader cannot tell why one form is tappable and the other
 * isn't. The character class stops at whitespace and at the punctuation that
 * ends a sentence rather than a URL.
 */
export const URL_SOURCE = 'https?:\\/\\/[^\\s<>\\])"\',]+|www\\.[^\\s<>\\])"\',]+|mailto:[^\\s<>\\])"\',]+';

/** A fresh matcher for the shared vocabulary — each caller needs its own
 *  `lastIndex`, so this must never be a shared instance. */
export function urlPattern(): RegExp {
  return new RegExp(URL_SOURCE, 'g');
}

/**
 * Sentence punctuation glued to the end of a URL belongs to the prose:
 * "read https://example.com/page." links to `/page`, not `/page.`.
 */
export function trimUrlTail(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, '');
}

/** A long URL reads as host + a hint of the path; the full URL is the target. */
export function shortenUrl(url: string): string {
  if (url.length <= 50) return url;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
    const path = parsed.pathname.length > 1 ? parsed.pathname.slice(0, 20) + '…' : '';
    return parsed.hostname + path;
  } catch {
    return url.slice(0, 40) + '…';
  }
}

/**
 * True when the "@" at `at` starts a mention rather than sitting inside an
 * address. "git@github.com:ashot/codecast.git" used to wear a mention chip on
 * "@github", which reads as a person who does not exist.
 */
export function isMentionStart(text: string, at: number): boolean {
  return at === 0 || !/[\w.]/.test(text[at - 1]);
}

/** Mobile screen for each object type. Types absent here have no screen yet. */
export const MOBILE_ENTITY_ROUTE: Partial<Record<EntityType, string>> = {
  session: '/session',
  task: '/task',
  plan: '/plan',
  doc: '/doc',
};

/** The mobile route for an object id, or null when that type has no screen. */
export function mobileEntityRoute(type: EntityType, id: string): string | null {
  const base = MOBILE_ENTITY_ROUTE[type];
  return base ? `${base}/${id}` : null;
}

/**
 * The in-app route a URL should open, or null when it belongs to the outside
 * world. Accepts app URLs and path-only hrefs; `parseEntityUrl` does the object
 * matching, and the two app paths that aren't objects are handled here.
 */
export function mobileRouteForUrl(url: string): string | null {
  const ref = parseEntityUrl(url);
  if (ref) return mobileEntityRoute(ref.type, ref.id);

  let path: string;
  try {
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      if (!isAppHost(parsed.host)) return null;
      path = parsed.pathname;
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      return null;
    } else {
      path = url.split(/[?#]/)[0];
    }
  } catch {
    return null;
  }

  // Share links (all four kinds) land on the /share resolver screen, which
  // turns the opaque token into an object id and replaces itself with the
  // object's screen. The token, not the app, decides what it addresses.
  const share = parseSharePath(path);
  if (share) {
    return share.kind === 'conversation'
      ? `/share/${share.token}`
      : `/share/${share.kind}/${share.token}`;
  }
  // Team invites are completed on the web; the team tab is the nearest screen.
  if (path.startsWith('/join/')) return '/(tabs)/team';
  return null;
}
