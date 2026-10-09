// What a sheet needs from the Org screen's panel (essence spec §5): the way
// to close it, to open something else in its place, to talk to whoever
// answers for it, and how it was opened.
import { createContext, useContext } from "react";
import type { OrgObjectKind } from "@codecast/shared/entities";
import type { PanelRef } from "../panelTarget";
import type { SheetRef } from "./sheetStack";

export type SheetHost = {
  close: () => void;
  /** Open something in the panel in this one's place: an object, a
   *  conversation or a proposal. `open(kind, ref)` still reads as an object. */
  open(to: PanelRef | OrgObjectKind, ref?: string): void;
  /** Open the conversation of whoever answers for the object, in the panel. */
  talk: (s: SheetRef) => void;
  /** Open a proposal in the panel, the change `seq` lit. */
  openProposal: (shortId: string, seq?: number) => void;
  /** A sheet just created from New: its title opens focused for naming. */
  focusTitle: boolean;
  /** The name was committed or let go: the title opens as a heading from now on. */
  titleSettled: () => void;
  /** How the open object was opened: a project opened to pick its lead. */
  intent?: "pick-lead" | null;
  /** The panel fills the content area (a narrow screen): its bar leads with "← Org". */
  fills?: boolean;
  /** @deprecated The panel holds one object; history is the browser's. Removed in WP9. */
  under?: SheetRef | null;
  /** @deprecated See `under`. */
  underTitle?: string | null;
  /** @deprecated See `under`. */
  back?: () => void;
  /** @deprecated Every sheet can talk now. */
  talkable?: boolean;
  /** @deprecated There is no conversation beside the panel. */
  leftConversationId?: string | null;
  /** @deprecated Read `fills`. */
  covers?: boolean;
};

export const SheetHostContext = createContext<SheetHost | null>(null);

export function useSheetHost(): SheetHost | null {
  return useContext(SheetHostContext);
}
