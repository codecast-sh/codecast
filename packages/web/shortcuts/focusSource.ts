// Who owns a keyboard list's cursor: the keyboard or the mouse. A key press
// hands it to the keyboard; only a real pointer move (the pointer's screen
// position changed) hands it back. While the keyboard owns it, rows that slide
// under a still pointer (j/k scrolling the list, results reordering as you
// type) fire mouseenter without moving the cursor.
//
// Rows take their hover through hoverFocus(fn): it answers mouseenter AND
// mousemove, so the first real move over a row claims it even though the
// browser fires mouseenter before pointermove.

type Source = "keyboard" | "mouse";

let source: Source = "mouse";
let lastX = NaN;
let lastY = NaN;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock"]);

// Listeners go on once, at import; nothing to do on the server.
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => { if (!MODIFIERS.has(e.key)) source = "keyboard"; }, true);
  window.addEventListener("pointermove", (e) => {
    if (e.screenX === lastX && e.screenY === lastY) return;
    lastX = e.screenX;
    lastY = e.screenY;
    source = "mouse";
  }, true);
  window.addEventListener("pointerdown", () => { source = "mouse"; }, true);
}

/** True while the last thing that moved a list cursor was a key press. */
export function keyboardOwnsFocus(): boolean {
  return source === "keyboard";
}

/** Hover props for a keyboard list row: `fn` runs only while the mouse owns focus. */
export function hoverFocus(fn: () => void): { onMouseEnter: () => void; onMouseMove: () => void } {
  const run = () => { if (source === "mouse") fn(); };
  return { onMouseEnter: run, onMouseMove: run };
}
