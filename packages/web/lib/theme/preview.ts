// A theme shown for a moment without becoming the person's choice: a mod's
// "Preview" button ($.theme.preview). It lives only in this window and only
// until it expires, the person applies a theme, or another preview replaces it.

type Listener = () => void;

let previewKey: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

export const THEME_PREVIEW_MS = 8000;

export function themePreview(): string | null {
  return previewKey;
}

export function subscribeThemePreview(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Shows `key` for `ms`, or ends the preview when `key` is null. */
export function setThemePreview(key: string | null, ms = THEME_PREVIEW_MS): void {
  if (timer) clearTimeout(timer);
  timer = key ? setTimeout(() => setThemePreview(null), ms) : null;
  if (previewKey === key) return;
  previewKey = key;
  for (const fn of [...listeners]) fn();
}
