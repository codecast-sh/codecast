/**
 * One place that decides what happens when a link is tapped.
 *
 * Three destinations, in order of preference:
 *
 *  1. A codecast object URL (https://codecast.sh/tasks/ct-42, /conversation/…,
 *     /share/<token>) routes INSIDE the app. `Linking.openURL` cannot do this:
 *     iOS never re-enters your own app through a universal link you opened
 *     yourself, so a codecast link used to bounce the reader out to Safari and
 *     a signed-out web page.
 *  2. Any other http(s) URL opens in the in-app browser (Safari View
 *     Controller): the reader keeps their place in the conversation, and the
 *     page inherits Safari's cookies so they stay signed in wherever they go.
 *  3. Everything else (mailto:, tel:, custom schemes) goes to the system.
 *
 * The URL → route table lives in `lib/linkRoutes` and is shared with the
 * deep-link handler in `app/_layout.tsx`, so a link tapped inside the app and
 * the same link tapped in Mail land on exactly the same screen.
 */

import { Linking } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';
import { mobileRouteForUrl } from '@/lib/linkRoutes';
import { Theme } from '@/constants/Theme';

export {
  MOBILE_ENTITY_ROUTE,
  mobileEntityRoute,
  mobileRouteForUrl,
  shortenUrl,
  trimUrlTail,
  urlPattern,
  URL_SOURCE,
} from '@/lib/linkRoutes';

/**
 * Open a tapped link. Never throws and never rejects — a dead link must not
 * take down the screen that rendered it.
 */
export async function openLink(url: string): Promise<void> {
  const trimmed = url?.trim();
  if (!trimmed) return;

  // A bare "www.example.com" has no scheme; everything else keeps its own.
  // Normalise first, so "www.codecast.sh/tasks/ct-42" is recognised as ours.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  const route = mobileRouteForUrl(absolute);
  if (route) {
    router.push(route as never);
    return;
  }

  if (/^https?:/i.test(absolute)) {
    try {
      await WebBrowser.openBrowserAsync(absolute, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        controlsColor: Theme.blue,
        toolbarColor: Theme.bg,
      });
      return;
    } catch {
      // Fall through to the system handler.
    }
  }

  try {
    await Linking.openURL(absolute);
  } catch {
    // Nothing can open it — stay put rather than surfacing a native error.
  }
}
