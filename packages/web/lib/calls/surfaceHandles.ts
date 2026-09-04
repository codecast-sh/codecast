import { createContext, useContext, type PointerEvent as ReactPointerEvent } from "react";


/**
 * The shapes the corner can hold. Not the same list as the dock's surfaces:
 * this is about the BOX, so the pinned window and the pill are two shapes of
 * one surface — and pinning morphs for free because of it.
 */
export type SurfaceShape = "walkie" | "pill" | "window" | "stage";


/**
 * The dock's surface, and the pin, read as one shape.
 *
 * The pin is not a surface — the same call is behind both — so it belongs here
 * with the box rather than beside the walkie's lookup: unpinning is the corner
 * changing shape, and it morphs for exactly the same reason the upgrade does.
 */
export function surfaceShape(surface: "walkie" | "dock" | "stage", pinned: boolean): SurfaceShape {
  if (surface === "walkie") return "walkie";
  if (surface === "stage") return "stage";
  return pinned ? "window" : "pill";
}


/** Grab the surface and move it. Given to the content, which owns the handle. */
export type DragHandles = {
  /** The header row: drag the whole surface by it. */
  onMove: (e: ReactPointerEvent) => void;
  /** The top-left grip: the corner is pinned, so this resizes the box. */
  onResize: (e: ReactPointerEvent) => void;
};


/**
 * Clicks on chrome inside a drag handle must not start a drag.
 *
 * The floating dock puts pop-out / expand / unpin on the same row you drag
 * the card by. Pointer capture on that row is what made those three buttons
 * do nothing: the header ate pointerdown, preventDefault'd it, and click
 * never fired. Same selector the titlebar uses for `-webkit-app-region:
 * no-drag` — a button, a link, a field.
 */
export const SURFACE_CHROME_SELECTOR =
  "button, a, input, textarea, select, [role='button']";


export function isSurfaceChromeTarget(target: EventTarget | null): boolean {
  const el = target as { closest?: (s: string) => Element | null } | null;
  return typeof el?.closest === "function" && !!el.closest(SURFACE_CHROME_SELECTOR);
}


export const HandleContext = createContext<DragHandles | null>(null);


/** The drag handles of the surface this content is inside, if it is inside one. */
export function useSurfaceHandles(): DragHandles | null {
  return useContext(HandleContext);
}
