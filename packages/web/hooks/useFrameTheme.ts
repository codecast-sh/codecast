import { useCallback, type RefObject } from "react";
import { useTheme } from "../components/ThemeProvider";
import { useWatchEffect } from "./useWatchEffect";
import { PAGE_THEME_MESSAGE, PAGE_THEME_TOKENS, type PageThemeTokens } from "../../shared/render/pageTheme";

/** The --sol-* values this window paints with right now, whatever palette and
 *  visual style produced them. */
function liveTokens(): PageThemeTokens {
  const style = getComputedStyle(document.documentElement);
  const tokens: PageThemeTokens = {};
  for (const name of PAGE_THEME_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}

/** The alpha of a computed CSS colour, in any syntax the browser serializes:
 *  `rgba(r, g, b, a)`, or `/ a` in `rgb()`, `color(srgb …)`, `oklab()` and the
 *  rest (a `color-mix()` background computes to `color(srgb … / a)`). */
export function colorAlpha(color: string): number {
  if (!color || color === "transparent") return 0;
  const args = /\(([^)]*)\)/.exec(color)?.[1] ?? "";
  const raw = args.includes("/") ? args.split("/").pop() : args.split(",")[3];
  if (raw === undefined) return 1;
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return 1;
  return raw.trim().endsWith("%") ? value / 100 : value;
}

/** The opaque colour painted behind `el`: its nearest ancestor with a solid
 *  background. A page that paints itself with --sol-bg then shows no edge
 *  wherever it sits (a message, a decision card, a tinted bubble). */
function surfaceBehind(el: Element | null): string | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (colorAlpha(bg) >= 0.95) return bg;
  }
  return null;
}

/** The message a framed page listens for: a published markdown page reads the
 *  theme name, a published HTML page the token values too, any other page
 *  ignores it. It carries only colours, so it is posted to whatever origin the
 *  frame holds. */
function postTheme(frame: HTMLIFrameElement | null, theme: string, blend: boolean) {
  try {
    const tokens = liveTokens();
    const surface = blend ? surfaceBehind(frame) : null;
    if (surface) tokens["sol-bg"] = surface;
    frame?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, theme, tokens }, "*");
  } catch {
    // The frame is mid-navigation; its load posts again.
  }
}

/**
 * Keep a framed page on the codecast palette and light or dark setting. Posts
 * on every theme or style change, and returns the load handler that posts again
 * for each new document the frame commits, so a navigation inside the frame
 * keeps it too. `blend` makes --sol-bg the surface the frame sits on, for a
 * page shown frameless inside the thread.
 */
export function useFrameTheme(frameRef: RefObject<HTMLIFrameElement | null>, { blend = false } = {}) {
  const { theme, visualStyle } = useTheme();
  useWatchEffect(() => {
    // The provider swaps the root's classes in its own effect, which runs
    // after this one; read the tokens once that has painted.
    const raf = requestAnimationFrame(() => postTheme(frameRef.current, theme, blend));
    return () => cancelAnimationFrame(raf);
  }, [theme, visualStyle, blend]);
  const onLoad = useCallback(() => postTheme(frameRef.current, theme, blend), [frameRef, theme, blend]);
  return { theme, onLoad };
}
