import { mobileRouteForUrl } from '@/lib/linkRoutes';

/**
 * expo-router consults this for every externally delivered URL — universal
 * links, the codecast:// scheme, push-notification taps — BEFORE routing it,
 * for both the cold-start URL and URLs arriving while the app runs.
 *
 * Returning a new path re-routes; returning the input verbatim hands the URL
 * to the file-system router untouched. This replaces the old manual
 * `Linking.addEventListener` handler in _layout, which pushed a second copy of
 * any screen the router had already matched natively (e.g. /doc/<id>), and
 * left a "This screen doesn't exist" page under any route it translated
 * (e.g. /conversation/<id> → /session/<id>).
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // The app scheme carries the same path vocabulary as codecast.sh URLs
    // (codecast://conversation/<id>, codecast://share/doc/<token>). Strip just
    // that scheme to a plain path so one table answers for both; every other
    // scheme (exp:// in dev, https://) already speaks for itself.
    const normalized = path.replace(/^codecast:\/\//i, '/');
    return mobileRouteForUrl(normalized) ?? path;
  } catch {
    return path;
  }
}
