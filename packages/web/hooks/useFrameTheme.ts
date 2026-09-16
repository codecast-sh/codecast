import { useCallback, type RefObject } from "react";
import { useTheme } from "../components/ThemeProvider";
import { useWatchEffect } from "./useWatchEffect";

/** The message a framed page listens for (a published markdown page does;
 *  any other page ignores it). It carries nothing but the theme name, so it is
 *  posted to whatever origin the frame holds. */
function postTheme(frame: HTMLIFrameElement | null, theme: string) {
  try {
    frame?.contentWindow?.postMessage({ type: "codecast:theme", theme }, "*");
  } catch {
    // The frame is mid-navigation; its load posts again.
  }
}

/**
 * Keep a framed page on the codecast light or dark setting. Posts on every
 * theme change, and returns the load handler that posts again for each new
 * document the frame commits, so a navigation inside the frame keeps it too.
 */
export function useFrameTheme(frameRef: RefObject<HTMLIFrameElement | null>) {
  const { theme } = useTheme();
  useWatchEffect(() => {
    postTheme(frameRef.current, theme);
  }, [theme]);
  const onLoad = useCallback(() => postTheme(frameRef.current, theme), [frameRef, theme]);
  return { theme, onLoad };
}
