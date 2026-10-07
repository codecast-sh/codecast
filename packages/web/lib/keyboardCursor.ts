// Whether the person is moving through a list with the keyboard, as one
// attribute on the root (`data-kbd-cursor`), so hosted mode draws a list's
// keyboard cursor only once the keyboard has moved it and drops it again at
// the next pointer press (globals.css, [data-list-row-state="focused"]). A
// list renders its first row as focused from the first paint; without this,
// a phone shows a cursor on a row nobody chose.

const MOVES = new Set(["ArrowDown", "ArrowUp", "j", "k", "Home", "End"]);
let installed = false;

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/** Starts watching, once per page. */
export function installKeyboardCursor(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const root = document.documentElement;
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !MOVES.has(e.key) || editable(e.target)) return;
    root.setAttribute("data-kbd-cursor", "");
  }, true);
  window.addEventListener("pointerdown", () => root.removeAttribute("data-kbd-cursor"), true);
}
