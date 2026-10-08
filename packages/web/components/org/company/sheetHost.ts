// What a sheet needs from the screen it opens over (cohesive build spec §5.1,
// D4, D5, D6): the step under it for Back, the way to close, the way to talk
// to whoever answers for it, and which conversation is already on the left,
// so the Ask box stands down when it would only repeat that composer.
import { createContext, useContext } from "react";
import type { OrgObjectKind } from "@codecast/shared/entities";
import type { SheetRef } from "./sheetStack";

export type SheetHost = {
  /** The sheet under this one, for "← back"; null when it is the only one. */
  under: SheetRef | null;
  /** Its name, for the Back label. */
  underTitle: string | null;
  back: () => void;
  close: () => void;
  open: (kind: OrgObjectKind, ref: string) => void;
  /** Put the object's responsible party on the left (D5c). */
  talk: (s: SheetRef) => void;
  /** The screen has a conversation pane to talk in (the org feature on, not the company alone). */
  talkable: boolean;
  /** The conversation the left pane shows; the Ask box hides when it is the seat's. */
  leftConversationId: string | null;
  /** Scroll the conversation to a proposal's card, swapping back to the Head of People first (D8). */
  openProposal: (shortId: string, seq?: number) => void;
  /** A sheet just created from New: its title opens focused for naming. */
  focusTitle: boolean;
  /** The name was committed or let go: the title opens as a heading from now on. */
  titleSettled: () => void;
  /** The sheet covers the whole pane (a narrow pane, a phone). */
  covers: boolean;
};

export const SheetHostContext = createContext<SheetHost | null>(null);

export function useSheetHost(): SheetHost | null {
  return useContext(SheetHostContext);
}
