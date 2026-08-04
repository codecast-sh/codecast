// The ONE place the Files surface's URL shape lives. Eleven call sites used to
// build `/vault?f=<path>` by hand, which is how a rename turns into a hunt.
//
// ROUTE HISTORY, and why /vault can never be deleted: the surface was called
// "Vault" and lived at /vault. `cast vault open` printed /vault?f=… deep links
// into sessions and notes, and entity-link authoring writes real codecast URLs
// into users' markdown files on disk. Those links are already out there. /files
// is what we mint now; /vault stays routable forever so nothing already written
// goes dead. Both patterns are registered in all four route lists (App.tsx,
// TabContent.tsx, src/compat/tabRouting.ts, src/routes.manifest.ts).

/** Canonical route for the Files surface. */
export const FILES_ROUTE = "/files";

/** Permanent alias — see the route-history note above. Never remove. */
export const FILES_LEGACY_ROUTE = "/vault";

/** True for a path on the Files surface, under either route. */
export function isFilesPath(path: string): boolean {
  return /^\/(files|vault)(\?|\/|$)/.test(path);
}

/**
 * URL for the Files surface. No arguments means the bare page; `path` opens a
 * file, `line` scrolls to a source line (search hits carry it), `graph` opens
 * the link graph over whatever `path` is.
 */
export function filesHref(
  opts: { path?: string | null; line?: number; graph?: boolean } = {},
): string {
  const params = new URLSearchParams();
  if (opts.path) params.set("f", opts.path);
  if (opts.line) params.set("l", String(opts.line));
  if (opts.graph) params.set("view", "graph");
  const query = params.toString();
  return query ? `${FILES_ROUTE}?${query}` : FILES_ROUTE;
}
