import type { HtmlTagDescriptor, Plugin } from "vite";
import type { OutputBundle } from "rollup";

/**
 * Starts the Modern style's interface face with the page.
 *
 * Modern's interface font is Instrument Sans (app/globals.css .modern-style
 * --font-ui), bundled by @platform/design/fonts, whose @font-face rules ride
 * in the entry stylesheet (src/main.tsx). A face is fetched only once text
 * asks for it, so without a hint the file would start after the first paint
 * and the text would swap from the fallback sans. Classic and Minimal never
 * draw it, so the hint is a few lines of script after the boot script has
 * put the style's class on <html>: a preload for Modern only. The latin file
 * is the one nearly every page needs; latin-ext still loads on demand.
 *
 * Build only: the file's name carries its content hash, which only the
 * bundle knows. The dev server paints the fallback for a moment instead.
 */
export const UI_FONT_FILE = /(?:^|\/)instrument-sans-latin-wght-normal-[\w-]+\.woff2$/;

export function uiFontPreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "codecast-ui-font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      // `post` so the bundle, with the font's hashed name, is available.
      order: "post",
      handler(_html, ctx) {
        if (!ctx.bundle) return [];
        const tag = uiFontPreloadTag(ctx.bundle, base);
        if (!tag) console.warn("[codecast-ui-font-preload] the interface face is not in the bundle; no preload hint.");
        return tag ? [tag] : [];
      },
    },
  };
}

/** The face's latin file under the build's base, or null when the bundle has none. */
export function uiFontHref(bundle: OutputBundle, base: string): string | null {
  const file = Object.values(bundle).find((f) => f.type === "asset" && UI_FONT_FILE.test(f.fileName));
  if (!file) return null;
  return `${base.endsWith("/") ? base : `${base}/`}${file.fileName}`;
}

/** The script that preloads the face when <html> carries modern-style, or null. */
export function uiFontPreloadTag(bundle: OutputBundle, base: string): HtmlTagDescriptor | null {
  const href = uiFontHref(bundle, base);
  if (!href) return null;
  return {
    tag: "script",
    // A font preload is always fetched in CORS mode, so it needs crossorigin
    // even from this origin, or the face is fetched a second time. Injected at
    // the end of <head>, after the boot script that sets the class.
    children:
      "if(document.documentElement.classList.contains('modern-style')){" +
      "var l=document.createElement('link');l.rel='preload';l.as='font';l.type='font/woff2';l.crossOrigin='';" +
      `l.href=${JSON.stringify(href)};document.head.appendChild(l)}`,
    injectTo: "head",
  };
}
