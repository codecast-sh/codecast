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

// Compact relative age, e.g. "now", "3m", "2h", "5d" (no "ago" suffix — meant
// for tight badges/chips). For full "3m ago" phrasing add the suffix at the
// call site.
export function relTimeShort(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return `${Math.floor(diff / 86_400_000)}d`;
}

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

export async function copyToClipboard(text: string): Promise<void> {
  // Sync execCommand first - must run before dropdown/popup closes and shifts focus
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(textArea);
  if (ok) return;

  // Async Clipboard API fallback (only available in secure contexts)
  if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
  }
}
