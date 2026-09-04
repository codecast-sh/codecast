import { repoBlobHref, repoTreeHref, type RepoRouteFamily } from "./repoView";

export function safeRepoUrl(value: string, image = false): string | undefined {
  const url = value.trim();
  if (/[\u0000-\u0020\u007f\\]/.test(url)) return undefined;
  if (/^(https?:|mailto:)/i.test(url)) return image && /^mailto:/i.test(url) ? undefined : url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) return undefined;
  return url;
}

export function resolveRepoMarkdownUrl(value: string, repository: string, ref: string, file: string,
  family: RepoRouteFamily, image = false): string | undefined {
  const safe = safeRepoUrl(value, image);
  if (safe === undefined || /^(https?:|mailto:|#)/i.test(safe)) return safe;
  const resolved = new URL(safe, `https://repository.invalid/${file}`);
  if (resolved.origin !== "https://repository.invalid") return undefined;
  let path: string;
  try {
    path = decodeURIComponent(resolved.pathname.slice(1));
  } catch {
    return undefined;
  }
  if (image) return path;
  const href = safe.endsWith("/") ? repoTreeHref(repository, ref, path, family) : repoBlobHref(repository, ref, path, family);
  return `${href}${resolved.hash}`;
}

export function repoShortcutAllowed(root: HTMLElement | null, event: KeyboardEvent): boolean {
  if (!root?.isConnected || root.getClientRects().length === 0 || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest("input, textarea, select, [contenteditable=true], [role=textbox], [role=dialog], [role=menu]")) return false;
  if (document.querySelector('[role="dialog"][data-state="open"], dialog[open], [aria-modal="true"]')) return false;
  const pane = root.closest("[data-stage-leaf]");
  return !pane || pane.classList.contains("stage-cell--focused");
}
