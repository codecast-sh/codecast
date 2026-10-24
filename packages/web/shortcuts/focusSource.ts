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

// Listeners go on once, when the first keyboard list renders a row (before
// any key reaches it), never at import: a page that only loads a module with
// such a list, like the homepage hero, takes no page keys. Nothing to do on
// the server.
let listening = false;
function listen() {
  if (listening || typeof window === "undefined") return;
  listening = true;
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
  listen();
  return source === "keyboard";
}

/** Hover props for a keyboard list row: `fn` runs only while the mouse owns
 *  focus. Called while rendering the row, which starts the watch. */
export function hoverFocus(fn: () => void): { onMouseEnter: () => void; onMouseMove: () => void } {
  listen();
  const run = () => { if (source === "mouse") fn(); };
  return { onMouseEnter: run, onMouseMove: run };
}
