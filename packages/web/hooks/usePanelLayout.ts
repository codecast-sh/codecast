import { useCallback, useState } from "react";
import { useIsPhone, useMinWidth } from "./useIsPhone";
import { useWatchEffect } from "./useWatchEffect";

export type PanelLayout = "side" | "overlay" | "sheet";

/** The width of the panel's own column and of the overlay. */
export const PANEL_W = 360;

/** The conversation needs this much beside the panel's column before the
 *  panel gets one; a narrower page gets the panel as an overlay. */
const WIDE_MIN_W = PANEL_W + 620;

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
