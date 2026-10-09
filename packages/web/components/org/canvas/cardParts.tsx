"use client";
// The small parts every canvas card shares: Enter or Space opens the card,
// a role's state word, and a line of text with its ids drawn as pills.
import type { KeyboardEvent, MouseEvent } from "react";
import { TextWithMentions } from "../../EntityIdPill";
import { compactAge } from "../../../lib/threadState";
import type { RoleState } from "./canvasModel";

/** Enter or Space on the card itself opens it, as a click does. */
export const onCardKey = (open: () => void) => (e: KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
};

/** A role's state in one word, in the canvas's one vocabulary: Waiting on
 *  you (orange, the only orange), Working (green), else Quiet, Paused, Not
 *  started or Handing over, said plainly. `age` follows it: "Quiet · 4h". */
export function StateWord({ state, at, now }: { state: RoleState; at?: number | null; now?: number }) {
  const age = at && now ? compactAge(Math.max(0, now - at)) : null;
  return (
    <span className="oc-state" data-state={state.kind}>
      <i aria-hidden />
      {state.label}{age ? ` · ${age}` : ""}
    </span>
  );
}

/** A line of text with every id in it drawn as a live reference pill, the
 *  way the rest of the app draws it. A pill opens its object; it never also
 *  opens the card around it. */
export function IdText({ text }: { text: string }) {
  return (
    <span onClick={(e: MouseEvent) => { if ((e.target as Element).closest?.("a,button,[role=link]")) e.stopPropagation(); }}>
      <TextWithMentions text={text} bareIds />
    </span>
  );
}
