import { createContext, useContext } from "react";

/** The screen's hover channel to the map: a subject card reports the change
 *  under the pointer or focus, null on leave, and the screen feeds it to
 *  `OrgMap.highlightChangeId`. Plain React state, no store scalar. Focus is
 *  not here: it is the store's `orgFocusChangeId`, which the cards read with
 *  the store and mark with `data-focused`. */
export const OrgHoverContext = createContext<((changeId: string | null) => void) | null>(null);

export const useOrgHover = () => useContext(OrgHoverContext);
