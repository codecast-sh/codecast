// What the native browser view has to get out of the way of.
//
// A native pane (packages/electron/browserPanes.js) is not an element: it is a
// Chromium view the shell places over the window, and it paints ABOVE every
// pixel the app draws. So the command palette, a context menu, the drag veil,
// a modal and a toast would all appear behind a page the person is reading —
// or, worse, be invisible while still taking the clicks the person aims at
// them. The renderer's half of the deal is to hide the view whenever the app
// draws over it, and this file is the rule for "whenever".
//
// Two kinds of overlay, because they deserve different answers:
//
//   modal    a dialog, the palette, the drag veil, the pick layer. It takes
//            the whole app: its backdrop covers every pane and its keyboard
//            focus must not land in a page. Any pane hides while one is up,
//            whether or not the rects meet.
//
//   floating a menu, a tooltip, a select popup, a toast. It is small and it
//            is somewhere. A pane hides only when the thing actually lands
//            over it — hiding a browser pane in the left half of the window
//            because a toast appeared in the bottom right would be a page
//            blinking for no reason the person can see.
//
// Everything here is a plain function over rects so it can be tested without a
// browser; the only DOM the module touches is a single MutationObserver that
// every native pane shares.

export type Rect = { left: number; top: number; right: number; bottom: number };

export type OverlayHit = { kind: "modal" | "floating"; selector: string; rect: Rect };

/** Overlays that own the whole app while they are up. */
export const MODAL_SELECTORS = [
  // Radix dialogs and the command palette (its root carries role="dialog").
  '[role="dialog"]',
  '[role="alertdialog"]',
  // The stage's own layers: the veil under a drag to split, and the layer
  // that asks which pane to place something in.
  ".stage-drop-veil",
  ".stage-pick",
  // The deliberate hook: anything else that must black out a native pane can
  // say so on its own element rather than growing this list.
  "[data-native-overlay]",
];

/** Overlays that only matter where they land. */
export const FLOATING_SELECTORS = [
  // Radix floats every menu, tooltip, select and popover inside this wrapper.
  "[data-radix-popper-content-wrapper]",
  '[role="menu"]',
  '[role="tooltip"]',
  '[role="listbox"]',
  // Sonner: the individual toast, not its always-present region.
  "[data-sonner-toast]",
];

function isVisible(el: Element): boolean {
  // Radix keeps content mounted through its exit animation; a closed popper is
  // on its way out and must not hold a page hidden behind it.
  return el.getAttribute("data-state") !== "closed";
}

function hasArea(rect: Rect): boolean {
  return rect.right > rect.left && rect.bottom > rect.top;
}

/** Every overlay the app currently has up, with where it is. `rectOf` is
 *  injectable because no headless DOM measures layout. */
export function collectOverlays(
  root: ParentNode,
  rectOf: (el: Element) => Rect = (el) => el.getBoundingClientRect(),
): OverlayHit[] {
  const hits: OverlayHit[] = [];
  const scan = (selectors: string[], kind: OverlayHit["kind"]) => {
    for (const selector of selectors) {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (!isVisible(el)) continue;
        const rect = rectOf(el);
        if (!hasArea(rect)) continue;
        hits.push({ kind, selector, rect });
      }
    }
  };
  scan(MODAL_SELECTORS, "modal");
  scan(FLOATING_SELECTORS, "floating");
  return hits;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Must this pane's view go away right now? */
export function overlayHidesPane(paneRect: Rect, overlays: OverlayHit[]): boolean {
  for (const overlay of overlays) {
    if (overlay.kind === "modal") return true;
    if (intersects(paneRect, overlay.rect)) return true;
  }
  return false;
}

/** The whole question in one call, for a pane that just measured itself. */
export function paneIsCovered(paneRect: Rect, root?: ParentNode): boolean {
  const target = root ?? (typeof document !== "undefined" ? document.body : null);
  if (!target) return false;
  return overlayHidesPane(paneRect, collectOverlays(target));
}

// ---------------------------------------------------------------------------
// The watcher
//
// One observer for every pane on the page, not one per pane: overlays are a
// property of the document, and a person with four browser panes open should
// not pay for four subtree observers. It starts with the first pane and stops
// with the last.
// ---------------------------------------------------------------------------

const watchers = new Set<() => void>();
let observer: MutationObserver | null = null;
let frame = 0;

function notify() {
  // Coalesced to a frame: opening a menu is a burst of mutations, and the
  // answer only has to be right by the time the next frame paints.
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const fn of watchers) fn();
  });
}

/** Call `cb` whenever the set of overlays may have changed. */
export function watchOverlays(cb: () => void): () => void {
  watchers.add(cb);
  if (!observer && typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    observer = new MutationObserver(notify);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      // A Radix popper opens and closes in place: the element stays, its
      // data-state flips. Without this a menu would close and the page would
      // stay hidden until the next unrelated mutation.
      attributes: true,
      attributeFilter: ["data-state", "class", "aria-hidden"],
    });
  }
  return () => {
    watchers.delete(cb);
    if (watchers.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
