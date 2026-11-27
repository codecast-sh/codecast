// Class strings for controls a phone reaches: at most 520px wide, or on a
// coarse pointer, a control is at least 44px each way, and a key cap (there
// are no keys to press) is hidden. Written out whole so Tailwind generates them.

/** At least 44×44 on a narrow screen or a touch screen. */
export const TOUCH_TARGET = "max-[520px]:min-h-11 max-[520px]:min-w-11 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11";

/** At least 44px tall on a narrow screen or a touch screen (a wide control: a link with words). */
export const TOUCH_HEIGHT = "max-[520px]:min-h-11 [@media(pointer:coarse)]:min-h-11";

/** Shown only where there is a keyboard: wraps a key cap. */
export const KEYS_ONLY = "max-[520px]:hidden [@media(pointer:coarse)]:hidden";
