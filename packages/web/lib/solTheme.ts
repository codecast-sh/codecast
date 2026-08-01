// Reading the app's --sol-* tokens as concrete colors.
//
// Canvas and WebGL surfaces — the terminal, the vault graph — can't consume
// CSS variables: they need literal color strings handed to them, and they need
// them handed again when the theme flips. This module is the one place that
// bridges CSS custom properties to those renderers.

/** Read one custom property off an already-computed style declaration. */
export function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim();
  return value || fallback;
}

/** Read one --sol-* token. Prefer `cssVar` with a hoisted `getComputedStyle`
 *  when reading several at once — each call here forces its own style read. */
export function readSolVar(name: string, fallback: string): string {
  return cssVar(getComputedStyle(document.documentElement), name, fallback);
}

export function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** Re-run `apply` whenever the html class flips between light/dark. */
export function observeTheme(apply: () => void): () => void {
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/**
 * Add an alpha channel to a token's value. The tokens are hex, and renderers
 * that parse their own colors (sigma, canvas) understand `rgba()` but not
 * `color-mix()` — which is why the CSS-side rule of "use color-mix, never a
 * Tailwind opacity modifier" doesn't reach here.
 */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(hex);
  const full = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  const parts = short
    ? short.slice(1, 4).map((c) => parseInt(c + c, 16))
    : full
      ? full.slice(1, 4).map((c) => parseInt(c, 16))
      : null;
  if (!parts) {
    // Already a functional color (rgb/hsl/oklch): let the renderer keep what
    // it can parse rather than corrupting it.
    return hex;
  }
  return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
}
