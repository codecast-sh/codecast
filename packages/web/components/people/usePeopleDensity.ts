import { type RefObject } from "react";
import { useDerivedSize } from "../../hooks/useDerivedSize";
import { desktopHeaderClass, isVoiceHost } from "../../lib/desktop";
import { densityFor, type PeopleDensity } from "./peopleDensity";

/**
 * Which shape the panel takes, measured from the panel's own box.
 *
 * The first paint uses the window's inner size so the right shape is there
 * before the observer's first callback: a strip window must never flash the
 * full header for one frame.
 */
export function usePeopleDensity(ref: RefObject<HTMLElement | null>): PeopleDensity {
  return useDerivedSize(ref, densityFor, () =>
    typeof window === "undefined" ? "full" : densityFor(window.innerWidth, window.innerHeight),
  );
}

/**
 * The top row's left edge, said once. On the desktop this is the drag region
 * plus the declared traffic-light inset — declared, not measured, because the
 * people window's top row is at the window's corner by construction (a
 * measured inset once left "PEOPLE" drawn under the lights for a session).
 * Off the desktop it is the row's own padding. Tailwind resolves duplicate
 * padding classes by stylesheet order, so the caller must use ONE of these,
 * never pl-3 beside it.
 */
export function peopleHeadClass(): string {
  // The voice host is frameless: a drag region, and nothing to clear.
  if (isVoiceHost()) return "electron-drag-region pl-3";
  return desktopHeaderClass() || "pl-3";
}
