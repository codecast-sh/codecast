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

import { inferHomeDir, resolveCustomPath } from "../utils";

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
 *
 * `localPath` is the other way in: a path as an agent or a person wrote it —
 * absolute, `~/…`, or relative to the session's working directory — rather
 * than vault-relative. The page resolves it against the daemon's vault roots
 * when it opens (`resolveVaultTarget`), then rewrites itself to `?f=`. Links
 * in conversation prose mint this form because the author never knows which
 * vault a file belongs to; the machine that has the files does.
 */
export function filesHref(
  opts: { path?: string | null; line?: number; graph?: boolean; localPath?: string | null } = {},
): string {
  const params = new URLSearchParams();
  if (opts.localPath) params.set("path", opts.localPath);
  else if (opts.path) params.set("f", opts.path);
  if (opts.line) params.set("l", String(opts.line));
  if (opts.graph) params.set("view", "graph");
  const query = params.toString();
  return query ? `${FILES_ROUTE}?${query}` : FILES_ROUTE;
}

/** Where a `?path=` deep link lands: which vault, and the path inside it
 *  ("" for the vault root). */
export interface VaultTarget {
  vaultId: string;
  rel: string;
  abs: string;
}

/**
 * Resolve a local path against the vaults this machine offers. Absolute paths
 * pick the vault whose root is their longest prefix; `~/…` expands against the
 * home directory the roots themselves reveal (the browser has no $HOME); a
 * relative path is taken against `activeRoot`, the vault already open. Null
 * when no vault contains the path — the caller says so rather than guessing.
 */
export function resolveVaultTarget(
  localPath: string,
  vaults: ReadonlyArray<{ id: string; root?: string }>,
  activeRoot?: string,
): VaultTarget | null {
  const roots = vaults.map((v) => v.root).filter((r): r is string => !!r);
  const abs = resolveCustomPath(localPath, inferHomeDir(roots), activeRoot);
  if (!abs) return null;
  let best: { id: string; root: string } | null = null;
  for (const v of vaults) {
    if (!v.root) continue;
    if (abs !== v.root && !abs.startsWith(v.root.replace(/\/$/, "") + "/")) continue;
    if (!best || v.root.length > best.root.length) best = { id: v.id, root: v.root };
  }
  if (!best) return null;
  const rel = abs === best.root ? "" : abs.slice(best.root.length).replace(/^\/+/, "");
  return { vaultId: best.id, rel, abs };
}
