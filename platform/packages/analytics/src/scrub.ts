// URLs that are credentials. An app has pages whose address IS the key: a
// share link, a guest's meeting link, an invite code. Any of them in a
// pageview, a referrer, an error report or a breadcrumb hands the key to
// whoever can read the analytics project, who can then open the shared thing
// as if they had been sent it. So the app names its secret paths once, as a
// rewrite (config.scrubUrl, "/share/doc/k3y" to "/share/doc/:token"), and
// every surface that carries a URL off the page runs it: PostHog's
// before_send, Sentry's beforeSend and beforeBreadcrumb, the codecast sink's
// error url and the replay recorder's nav and network entries.
//
// The rewrite takes any string, not a parsed URL, because the same address
// turns up whole, as a bare path, inside a referrer, and inside PostHog's
// autocapture element chain. A rewrite that misses a shape simply leaves it,
// and one that throws must never cost the event, so each pass here guards it.

export type UrlScrubber = (text: string) => string;

const safely = (scrub: UrlScrubber, text: string): string => {
  try {
    return scrub(text);
  } catch {
    return text;
  }
};

/** Every string value of a flat property bag, rewritten. Returns the same
 *  object when nothing changed. */
function scrubStrings<T extends Record<string, unknown>>(bag: T, scrub: UrlScrubber): T {
  let out: T | null = null;
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== "string") continue;
    const next = safely(scrub, value);
    if (next === value) continue;
    out ??= { ...bag };
    (out as Record<string, unknown>)[key] = next;
  }
  return out ?? bag;
}

type PosthogLikeEvent = {
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
};

/**
 * A PostHog capture with every URL rewritten: the event's own properties
 * ($current_url, $pathname, $referrer, $prev_pageview_*, $elements_chain),
 * each autocaptured element's attributes (an href), and the person
 * properties PostHog sets alongside ($initial_current_url and friends).
 * Every string is passed through, rather than a list of keys, so a property
 * PostHog adds later is covered without anyone remembering to add it here.
 */
export function scrubPosthogEvent<E extends PosthogLikeEvent | null>(event: E, scrub: UrlScrubber): E {
  if (!event) return event;
  const props = event.properties;
  if (props) {
    const next = scrubStrings(props, scrub);
    const elements = next.$elements;
    if (Array.isArray(elements)) {
      next.$elements = elements.map((el) => (el && typeof el === "object" ? scrubStrings(el as Record<string, unknown>, scrub) : el));
    }
    for (const key of ["$set", "$set_once"] as const) {
      const bag = next[key];
      if (bag && typeof bag === "object") next[key] = scrubStrings(bag as Record<string, unknown>, scrub);
    }
    event.properties = next;
  }
  if (event.$set) event.$set = scrubStrings(event.$set, scrub);
  if (event.$set_once) event.$set_once = scrubStrings(event.$set_once, scrub);
  return event;
}

type SentryLikeBreadcrumb = { message?: string; data?: Record<string, unknown> };
type SentryLikeEvent = {
  request?: { url?: string; headers?: Record<string, string> };
  breadcrumbs?: SentryLikeBreadcrumb[];
  transaction?: string;
};

/** A breadcrumb with its URLs rewritten: a navigation's from and to, a
 *  fetch's url, and the message line that can quote either. */
export function scrubSentryBreadcrumb<B extends SentryLikeBreadcrumb | null>(crumb: B, scrub: UrlScrubber): B {
  if (!crumb) return crumb;
  if (typeof crumb.message === "string") crumb.message = safely(scrub, crumb.message);
  if (crumb.data && typeof crumb.data === "object") crumb.data = scrubStrings(crumb.data, scrub);
  return crumb;
}

/** A Sentry event with its URLs rewritten: the page it happened on, the
 *  referrer header, the transaction name a router names after the path, and
 *  the breadcrumbs it carries (recorded before beforeBreadcrumb existed for
 *  them, or added by an integration that skips it). */
export function scrubSentryEvent<E extends SentryLikeEvent | null>(event: E, scrub: UrlScrubber): E {
  if (!event) return event;
  if (event.request) {
    if (typeof event.request.url === "string") event.request.url = safely(scrub, event.request.url);
    if (event.request.headers) event.request.headers = scrubStrings(event.request.headers, scrub);
  }
  if (typeof event.transaction === "string") event.transaction = safely(scrub, event.transaction);
  if (Array.isArray(event.breadcrumbs)) event.breadcrumbs = event.breadcrumbs.map((b) => scrubSentryBreadcrumb(b, scrub));
  return event;
}

/** A rewrite run safely: a scrubber that throws leaves its input as it was. */
export function runScrub(scrub: UrlScrubber | undefined, text: string): string {
  return scrub ? safely(scrub, text) : text;
}
