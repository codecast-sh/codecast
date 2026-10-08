import { useCallback, useState } from "react";
import { useIsPhone, useMinWidth } from "./useIsPhone";
import { useWatchEffect } from "./useWatchEffect";

export type PanelLayout = "side" | "overlay" | "sheet";

/** The width of the overlay a narrow page opens the panel in. */
export const PANEL_W = 360;

/** The narrowest the two sides of the seam go (ConversationWithPanel): the
 *  conversation keeps room for a readable thread and a composer, the panel for
 *  a map or a sheet. */
export const CONVERSATION_MIN_W = 420;
export const PANEL_MIN_W = 360;

/** A page this wide holds both sides at their minimums, so the panel gets its
 *  own side of the seam; a narrower page gets the panel as an overlay. */
const WIDE_MIN_W = CONVERSATION_MIN_W + PANEL_MIN_W;

/** Where the panel sits, by the width of the PAGE, not the window: a page in
 *  a split pane is as narrow as its pane. `measureRef` goes on the page root;
 *  it is a callback ref, so a page that paints a loading state first still
 *  gets measured once its root mounts. */
export function usePanelLayout(): { layout: PanelLayout; phone: boolean; measureRef: (el: HTMLElement | null) => void } {
  const phone = useIsPhone();
  const windowWide = useMinWidth(WIDE_MIN_W);
  const [el, setEl] = useState<HTMLElement | null>(null);
  // null until the root has a width: the window answers until then.
  const [measured, setMeasured] = useState<boolean | null>(null);
  useWatchEffect(() => {
    if (!el) return;
    // A root with no width is not laid out yet (or never will be, as in a
    // test DOM): the window stays the answer until it is.
    const apply = (w: number) => setMeasured(w > 0 ? w >= WIDE_MIN_W : null);
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => { const box = entries[0]?.contentRect; if (box) apply(box.width); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  const measureRef = useCallback((node: HTMLElement | null) => setEl(node), []);
  const wide = measured ?? windowWide;
  return { layout: phone ? "sheet" : wide ? "side" : "overlay", phone, measureRef };
}
