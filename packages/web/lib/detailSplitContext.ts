import { createContext, useContext } from "react";

// Whether a page is drawn as the list beside an open item (the Modern
// DetailSplitLayout, components/nav/ModernDetailSplit). The open item's own
// header holds the way back then, so the list's header draws none: one back
// control on screen, naming one place.

export const DetailListCtx = createContext(false);

/** True inside the list of a split whose item is open. */
export function useIsListBesideItem(): boolean {
  return useContext(DetailListCtx);
}
