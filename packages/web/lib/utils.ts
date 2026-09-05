import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// The DOM event the desktop shell (Electron tray / dock / app menu, via
// window.__CODECAST_NEW_SESSION) fires to start a new session. DashboardLayout
// listens for it and opens the compose popup — the same surface every in-app
// "New Session" affordance opens directly through store.openCompose().
export const NEW_SESSION_EVENT = "codecast-new-session";

// Relative/calendar stamp formatting lives in @codecast/shared/time so web,
// mobile and the CLI age a timestamp by the same rules. Re-exported here for
// the many existing web callers.
export { relTimeShort, formatRelative, formatShortDate, formatDateFull, formatDateSmart } from "@codecast/shared/time";

export function shareOrigin(): string {
  return "https://codecast.sh";
}

export function canonicalUrl(): string {
  if (typeof window === "undefined") return shareOrigin();
  return `${shareOrigin()}${window.location.pathname}${window.location.search}${window.location.hash}`;
}

// Shared match rule for the project pickers (chip picker + new-session modal).
// Queries match the project NAME (last path segment) anchored at the start of
// the name or of one of its words ("mobile" → union-mobile), never mid-word.
// Matching the full path is reserved for queries containing "/" — every recent
// path shares the ~/src/… prefix, so substring-matching the whole path made
// almost any letter match every project.
export function matchesProjectQuery(path: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (q.includes("/")) return path.toLowerCase().includes(q);
  const name = path.split("/").filter(Boolean).pop()?.toLowerCase() ?? "";
  return name.startsWith(q) || name.split(/[-_.]/).some((seg) => seg.startsWith(q));
}

// --- project-path helpers (shared by the new-session directory picker) -------

// The home directory, inferred from the shape of real local roots so "~/…"
// resolves to the same place the daemon would cd to.
export function inferHomeDir(paths: Array<string | undefined>): string | undefined {
  for (const p of paths) {
    const m = p?.match(/^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?:\/|$)/);
    if (m) return m[1];
  }
  return undefined;
}

// The parent directory of an absolute path ("/a/b/c" → "/a/b", "/a" → "/").
export function parentDir(abs: string): string {
  const i = abs.replace(/\/$/, "").lastIndexOf("/");
  return i > 0 ? abs.slice(0, i) : "/";
}

// The deepest directory every path shares ("/Users/a/src/x" + "/Users/a/src/y"
// → "/Users/a/src"). Returns undefined when the only thing in common is root,
// so callers can fall back to something more useful than "/".
export function commonParentDir(paths: string[]): string | undefined {
  const segs = paths.filter(Boolean).map((p) => p.replace(/\/$/, "").split("/"));
  if (segs.length === 0) return undefined;
  const [first] = segs;
  let n = first.length;
  for (const s of segs) {
    let k = 0;
    while (k < n && k < s.length && s[k] === first[k]) k++;
    n = k;
  }
  if (n <= 1) return undefined; // only the leading "" (root) is common
  return first.slice(0, n).join("/") || undefined;
}

// The base a bare folder name resolves against in the picker: a sibling of the
// current project (its parent dir) when you're inside one, else the directory
// your recent projects cluster under, else home. Lets "weekend-hack" mean
// "/Users/me/src/weekend-hack" without typing the whole path.
export function inferProjectBase(
  currentPath: string | undefined,
  recentPaths: string[],
  home: string | undefined,
): string | undefined {
  if (currentPath) return parentDir(currentPath);
  return commonParentDir(recentPaths) ?? home;
}

// Resolve a picker query that NAMES a directory into an absolute path:
//   "~/…" → home-relative, "/…" → absolute (both already unambiguous), and a
//   bare/relative name → joined onto `base` when one is known. Without a base,
//   a bare name stays a plain filter (the daemon can't resolve it). Returns the
//   normalized absolute path, or undefined when there's nothing to resolve to.
export function resolveCustomPath(
  raw: string,
  home: string | undefined,
  base?: string,
): string | undefined {
  const s = raw.trim();
  let abs: string | undefined;
  if (s === "~" || s.startsWith("~/")) {
    if (!home) return undefined;
    abs = home + s.slice(1);
  } else if (s.startsWith("/")) {
    abs = s;
  } else if (s && base) {
    abs = base + "/" + s;
  } else {
    return undefined;
  }
  abs = abs.replace(/\/{2,}/g, "/");
  if (abs.length > 1) abs = abs.replace(/\/$/, "");
  return abs;
}

// True when the query is an explicit path (absolute or home-relative) rather
// than a bare name — explicit paths always offer their "open" chip; bare names
// only offer it as a fallback when nothing in recents matches.
export function isExplicitPath(raw: string): boolean {
  return /^\s*[~/]/.test(raw);
}

// Re-collapse the home prefix to "~" for a compact, readable chip label.
export function displayPath(abs: string, home: string | undefined): string {
  if (home && (abs === home || abs.startsWith(home + "/"))) return "~" + abs.slice(home.length);
  return abs;
}

// One directory entry as the daemon's /fs/dirs route reports it.
export type DiskDir = { name: string; path: string; repo: boolean };

// What the picker knows about one directory on the machine's disk: the folders
// directly inside it, or that it doesn't exist. `home` is the daemon's real
// home, which replaces the inferred one the moment it's known.
export type DiskListing = { home: string; path: string; exists: boolean; dirs: DiskDir[] };

// Split a picker query into the directory to LIST and the name prefix to match
// inside it, shell-completion style: "~/src/co" lists ~/src and matches "co";
// "~/src/" lists ~/src and matches everything; a bare "co" resolves against
// `base` first. With no home known yet, a ~-relative directory is returned as
// typed — the daemon expands it, and the listing then brings the real home
// back. Returns undefined when the text names nothing listable.
export function splitDirQuery(
  raw: string,
  home: string | undefined,
  base: string | undefined,
): { dir: string; prefix: string; hidden: boolean } | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const browsing = s.endsWith("/");
  const tildeNoHome = !home && (s === "~" || s.startsWith("~/"));
  let dir: string | undefined;
  let prefix: string;
  if (browsing) {
    dir = tildeNoHome ? s.replace(/\/+$/, "") || "~" : resolveCustomPath(s, home, base);
    prefix = "";
  } else {
    const cut = s.lastIndexOf("/");
    prefix = cut >= 0 ? s.slice(cut + 1) : s;
    if (tildeNoHome) dir = cut > 0 ? s.slice(0, cut) : "~";
    else if (cut >= 0) dir = resolveCustomPath(s.slice(0, cut) || "/", home, base);
    else dir = base;
  }
  if (!dir) return undefined;
  return { dir, prefix, hidden: prefix.startsWith(".") };
}

export type ProjectPathOption = {
  path: string;
  /** A row the text NAMED rather than one that was found: open (or create) this folder. */
  custom?: boolean;
  /** The custom folder is known not to exist; picking it creates it. */
  create?: boolean;
  /** Found on the machine's disk (not in recents). `repo` = has a .git inside. */
  disk?: boolean;
  repo?: boolean;
};

// The option list a project-path picker offers for a query: matching recents,
// then folders found on disk in the directory the query browses (repos first),
// then a synthetic "open this folder" row when the text NAMES a directory, so
// any path stays reachable — not just previously-used ones. An explicit path
// (absolute or ~/…) always offers it; a bare name resolves against `base` and
// offers it only when nothing else matches (plain filtering stays clean). When
// the listing proves the named folder is absent, that row becomes "create".
// With no query: the first `defaultLimit` recents.
export function buildProjectPathOptions(opts: {
  query: string;
  recentPaths: string[];
  home: string | undefined;
  base: string | undefined;
  /** Excluded from the custom offer — "open the folder you're already in" is a no-op. */
  currentPath?: string;
  defaultLimit?: number;
  /** The daemon's listing of the directory splitDirQuery(query) names, when it has answered. */
  listing?: DiskListing | null;
  diskLimit?: number;
}): ProjectPathOption[] {
  const { query, recentPaths, home, base, currentPath, defaultLimit = 8, listing, diskLimit = 12 } = opts;
  if (!query.trim()) return recentPaths.slice(0, defaultLimit).map((path) => ({ path }));
  const explicit = isExplicitPath(query);
  const custom = resolveCustomPath(query, home, base);
  // Explicit paths match recents by their resolved absolute form (so "~/…"
  // still filters previously-used folders); bare names match by name.
  const matchQuery = explicit ? (custom ?? query) : query;
  const matches: ProjectPathOption[] = recentPaths
    .filter((p) => matchesProjectQuery(p, matchQuery))
    .map((path) => ({ path }));

  // Disk entries only count when the listing is of the directory THIS query
  // browses — a stale answer for the previous keystroke's directory would
  // otherwise offer folders from the wrong place.
  const split = splitDirQuery(query, home, base);
  const listed = !!split && !!listing && listing.path === split.dir;
  const shown = new Set(matches.map((m) => m.path));
  if (currentPath) shown.add(currentPath);
  const disk: ProjectPathOption[] = listed
    ? listing!.dirs
        .filter((d) => !shown.has(d.path) && (!split!.prefix || matchesProjectQuery(d.path, split!.prefix)))
        // A name that STARTS with the prefix outranks a segment match
        // ("codex" before "claude-code" for "co"); repos outrank plain folders.
        .sort((a, b) => {
          const pre = split!.prefix.toLowerCase();
          const ap = Number(a.name.toLowerCase().startsWith(pre));
          const bp = Number(b.name.toLowerCase().startsWith(pre));
          return bp - ap || Number(b.repo) - Number(a.repo) || a.name.localeCompare(b.name);
        })
        .slice(0, diskLimit)
        .map((d) => ({ path: d.path, disk: true, repo: d.repo }))
    : [];
  for (const d of disk) shown.add(d.path);

  const offerCustom =
    !!custom &&
    custom !== currentPath &&
    !shown.has(custom) &&
    (explicit || (matches.length === 0 && disk.length === 0));
  if (!offerCustom) return [...matches, ...disk];
  // Absent from a directory we listed (or under a directory that doesn't
  // exist) → the folder isn't there; picking it creates it.
  const absent =
    listed && !!split!.prefix && (!listing!.exists || !listing!.dirs.some((d) => d.path === custom));
  return [...matches, ...disk, { path: custom!, custom: true, ...(absent ? { create: true } : {}) }];
}

export async function copyToClipboard(text: string): Promise<void> {
  // Async Clipboard API first. The execCommand path cannot be the primary:
  // its hidden textarea lives outside any open Radix dialog, so the dialog's
  // focus trap yanks focus off it and the copy silently grabs nothing while
  // still reporting success (the InviteModal "Copy" bug).
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // e.g. "Document is not focused" — fall through to execCommand.
    }
  }

  // execCommand fallback. Park the textarea inside the open dialog (when one
  // is up) so a focus trap can't steal focus from it mid-copy.
  const host =
    (document.activeElement?.closest?.('[role="dialog"]') as HTMLElement | null) ??
    document.body;
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  host.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const ok = document.execCommand("copy");
  host.removeChild(textArea);
  if (!ok) throw new Error("Copy to clipboard failed");
}
