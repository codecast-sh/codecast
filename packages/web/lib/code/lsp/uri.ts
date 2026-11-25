// LSP file URIs and codecast vault paths. A server names files by URI, and
// different servers encode the same path differently (typescript-language-server
// writes `%40types`, a daemon's pathToFileURL leaves `@`), so every comparison
// goes through the decoded absolute path, never the URI text.

/** The absolute path a file: URI names, decoded; null for any other scheme. */
export function uriToFsPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  let rest = uri.slice("file://".length);
  // file://host/path: only an empty host or localhost is this machine.
  if (!rest.startsWith("/")) {
    const slash = rest.indexOf("/");
    if (slash < 0 || rest.slice(0, slash) !== "localhost") return null;
    rest = rest.slice(slash);
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/** A file: URI for an absolute path, each segment encoded the way vscode-uri
 *  does, which is what most servers echo back. */
export function fsPathToUri(absPath: string): string {
  return "file://" + absPath.split("/").map(encodeURIComponent).join("/");
}

/** The key two URIs for the same file share. */
export function uriKey(uri: string): string {
  return uriToFsPath(uri) ?? uri;
}

const trimSlash = (p: string) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p);

export type UriTarget =
  /** Inside the vault: `path` is vault-relative. */
  | { inside: true; path: string; absPath: string }
  /** Somewhere else on the machine (a toolchain's library, the registry cache). */
  | { inside: false; absPath: string | null };

/** Where an LSP URI points, relative to the vault rooted at `rootPath`. */
export function resolveUri(rootPath: string, uri: string): UriTarget {
  const abs = uriToFsPath(uri);
  if (!abs) return { inside: false, absPath: null };
  const root = trimSlash(rootPath);
  if (abs.startsWith(root + "/")) return { inside: true, path: abs.slice(root.length + 1), absPath: abs };
  return { inside: false, absPath: abs };
}

/** The URI for a vault-relative path. */
export function vaultFileUri(rootPath: string, path: string): string {
  return fsPathToUri(`${trimSlash(rootPath)}/${path}`);
}

/** A path for display: vault-relative inside the vault, `~/...` under home. */
export function displayPath(rootPath: string, uri: string, home?: string): string {
  const t = resolveUri(rootPath, uri);
  if (t.inside) return t.path;
  if (!t.absPath) return uri;
  if (home && t.absPath.startsWith(trimSlash(home) + "/")) return "~" + t.absPath.slice(trimSlash(home).length);
  return t.absPath;
}
