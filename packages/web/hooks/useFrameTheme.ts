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

/** The message a framed page listens for: a published markdown page reads the
 *  theme name, a published HTML page the token values too, any other page
 *  ignores it. It carries only colours, so it is posted to whatever origin the
 *  frame holds. */
function postTheme(frame: HTMLIFrameElement | null, theme: string) {
  try {
    frame?.contentWindow?.postMessage({ type: PAGE_THEME_MESSAGE, theme, tokens: liveTokens() }, "*");
  } catch {
    // The frame is mid-navigation; its load posts again.
  }
}

/**
 * Keep a framed page on the codecast palette and light or dark setting. Posts
 * on every theme or style change, and returns the load handler that posts again
 * for each new document the frame commits, so a navigation inside the frame
 * keeps it too.
 */
export function useFrameTheme(frameRef: RefObject<HTMLIFrameElement | null>) {
  const { theme, visualStyle } = useTheme();
  useWatchEffect(() => {
    // The provider swaps the root's classes in its own effect, which runs
    // after this one; read the tokens once that has painted.
    const raf = requestAnimationFrame(() => postTheme(frameRef.current, theme));
    return () => cancelAnimationFrame(raf);
  }, [theme, visualStyle]);
  const onLoad = useCallback(() => postTheme(frameRef.current, theme), [frameRef, theme]);
  return { theme, onLoad };
}
