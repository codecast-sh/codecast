import { useRef } from "react";

/** A long press is a right click for a finger; this is how long it takes. */
export const LONG_PRESS_MS = 500;

/**
 * A press held for LONG_PRESS_MS, for a control that does one thing on a tap
 * and another on a hold (the walkie key's ring menu, a call line's selection
 * on a phone). `start` on pointer down (with whatever the hold needs to know,
 * captured then), `cancel` on up, leave and cancel (a scroll cancels the
 * pointer, so a finger that scrolls never holds). A hold still ends in a
 * click, which would do the tap's thing the hold was meant to avoid, so the
 * hold marks the click as spent and the click asks `takeSpent` first.
 */
export function useLongPress<A>(onHold: (arg: A) => void) {
  const state = useRef<{ timer: ReturnType<typeof setTimeout> | null; spent: boolean }>({ timer: null, spent: false });
  const hold = useRef(onHold);
  hold.current = onHold;
  const cancel = () => {
    if (state.current.timer) clearTimeout(state.current.timer);
    state.current.timer = null;
  };
  const start = (arg: A) => {
    cancel();
    state.current.spent = false;
    state.current.timer = setTimeout(() => {
      state.current.timer = null;
      state.current.spent = true;
      hold.current(arg);
    }, LONG_PRESS_MS);
  };
  /** True once, for the click that ends a hold. */
  const takeSpent = () => {
    if (!state.current.spent) return false;
    state.current.spent = false;
    return true;
  };
  return { start, cancel, takeSpent };
}
