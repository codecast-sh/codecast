// The editor tab being dragged, readable on dragover (dataTransfer is not).
// The tab strip starts and ends it; a drop target outside the strip (another
// group's body) takes it.

export type TabDrag = { groupId: string; path: string };

let dragging: TabDrag | null = null;

export function startTabDrag(d: TabDrag): void {
  dragging = d;
}

export function endTabDrag(): void {
  dragging = null;
}

export const isDraggingTab = () => dragging !== null;

/** The tab being dragged; taking it ends the drag. */
export function takeTabDrag(): TabDrag | null {
  const d = dragging;
  dragging = null;
  return d;
}
