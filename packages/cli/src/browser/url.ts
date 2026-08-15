/**
 * URL comparison for "am I already on this page?".
 *
 * Split out from cli.ts so the rule can be tested directly: cli.ts registers
 * commands on import, so nothing there is reachable from a unit test. The rule
 * is worth pinning because both ways of getting it wrong are bad — too loose
 * and `open` silently refuses to navigate anywhere, too strict and every call
 * reloads a page that was already loaded.
 */

/**
 * Do these two URLs name the same document?
 *
 * Compared after normalising the parts that do not change what is loaded: a
 * missing scheme, a trailing slash on the root, and the fragment — following
 * `#section` is a scroll, not a load. Query strings DO count, since they
 * routinely select what a page shows.
 */
export function sameDocument(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
      u.hash = "";
      const path = u.pathname.replace(/\/$/, "");
      return `${u.protocol}//${u.host}${path}${u.search}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  const nb = norm(b);
  return na !== null && na === nb;
}
