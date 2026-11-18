// Data sync: folders under $HOME that every machine of a person shares, as a
// repo declares them ([host] data in .codecast/workspace.toml). The rules both
// sides hold: which folders may sync, which paths inside one, and the limits.
// The server (convex/dataSync.ts) enforces them; the daemon
// (packages/cli/src/dataSync) checks them first so it never sends a refusal.

/** Rows per page, both reading changes and committing them. */
export const DATA_SYNC_PAGE = 200;
/** Largest single file a folder syncs; a bigger one stays on its machine. */
export const DATA_SYNC_MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Live bytes one person may sync across every folder. */
export const DATA_SYNC_MAX_USER_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Places a synced folder may never be: credentials, agent state the home
 * mirror owns, and codecast's own config. The first segment under $HOME, or
 * a longer prefix.
 */
const DENIED_PREFIXES = [".ssh", ".gnupg", ".aws", ".config/gcloud", ".kube", ".docker", ".codecast", ".claude", ".codex", ".gemini", ".grok", ".agents", ".config/gh", ".netrc", ".git-credentials", "Library/Keychains"];

/** Why `path` (relative to $HOME, as a manifest's `~/x` becomes `x`) cannot be a synced folder, or null. */
export function dataFolderProblem(path: string): string | null {
  if (!path || path.startsWith("/") || path.startsWith("~")) return "must be a path under $HOME, written ~/...";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "must be a plain path with no empty, . or .. segments";
  if (parts.length < 2) return "must name a folder at least two levels under $HOME, not a whole top-level folder";
  if (DENIED_PREFIXES.some((d) => path === d || path.startsWith(`${d}/`))) return "holds credentials or agent state, which never sync this way";
  if (path.length > 300) return "is longer than 300 characters";
  return null;
}

/** Why `rel` (a file's path inside its folder) cannot sync, or null. */
export function dataRelProblem(rel: string): string | null {
  if (!rel || rel.startsWith("/")) return "must be a relative path";
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "must be a plain path with no empty, . or .. segments";
  if (rel.length > 512) return "is longer than 512 characters";
  return null;
}

/** A manifest entry (`~/.local/share/tool/data`) as the home-relative folder path the index keys on, or null when it is not one. */
export function dataFolderFromManifest(entry: string): string | null {
  if (!entry.startsWith("~/")) return null;
  const path = entry.slice(2).replace(/\/+$/, "");
  return dataFolderProblem(path) ? null : path;
}
