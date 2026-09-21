import { useIsPhone, useMinWidth } from "./useIsPhone";

export type PanelLayout = "side" | "overlay" | "sheet";

/** The width of the panel's own column and of the overlay. */
export const PANEL_W = 440;

/** The conversation needs this much beside the panel's column before the
 *  panel gets one; narrower windows get the panel as an overlay. */
const WIDE_MIN_W = PANEL_W + 620;

export function usePanelLayout(): { layout: PanelLayout; phone: boolean } {
  const phone = useIsPhone();
  const wide = useMinWidth(WIDE_MIN_W);
  return { layout: phone ? "sheet" : wide ? "side" : "overlay", phone };
}
