import type { RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

// A Panel mounted into an already-live Group (the tree pane, when a narrow
// pane widens past the split threshold) gets its imperative handle in the
// mounting commit, but the group only derives that panel's constraints one
// commit later — collapse() throws "Panel constraints not found" until then.
// Retry across a few frames; give up once the desired state changed or the
// panel is gone.
export function collapsePanelSoon(
  panelRef: RefObject<PanelImperativeHandle | null>,
  stillWanted: () => boolean,
  frames = 5,
) {
  const ref = panelRef.current;
  if (!ref || !stillWanted()) return;
  try {
    ref.collapse();
  } catch {
    if (frames > 0) {
      requestAnimationFrame(() => collapsePanelSoon(panelRef, stillWanted, frames - 1));
    }
  }
}
