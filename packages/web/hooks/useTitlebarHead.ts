import { useCallback, useState, type RefCallback, type RefObject } from "react";
import { useInboxStore } from "../store/inboxStore";
import { attachTitlebarHead, isElectron } from "../lib/desktop";
import { useWatchEffect } from "./useWatchEffect";

/**
 * Marks a surface's top row as the window titlebar while zen mode hides the
 * global header on the desktop app: the row becomes the drag region and, at the
 * window's left edge, indents past the macOS traffic lights (lib/desktop
 * attachTitlebarHead). Outside zen / outside Electron it is inert. Attach the
 * returned ref to the topmost row of the page or panel; pass the row's own ref
 * object when it already has one and both stay filled.
 */
export function useTitlebarHead<T extends HTMLElement = HTMLElement>(forward?: RefObject<T | null>): RefCallback<T> {
  const zen = useInboxStore((s) => s.clientState.ui?.zen_mode ?? false);
  const [el, setEl] = useState<T | null>(null);
  useWatchEffect(() => {
    if (!el || !zen || !isElectron()) return;
    return attachTitlebarHead(el);
  }, [el, zen]);
  return useCallback((node: T | null) => {
    if (forward) forward.current = node;
    setEl(node);
  }, [forward]);
}
