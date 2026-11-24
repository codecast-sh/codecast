// Whether a scroll has left the rows in the DOM behind.
//
// The list re-renders after a scroll event, in a later task, so the frame that
// carried the scroll paints the rows of the previous range. While that range
// still covers the viewport nothing shows. Once the scroll passes its edge the
// frame paints bare background where rows belong and they arrive a frame late:
// a flash at the leading edge on a brisk scroll, an empty pane on a fling.
// Overscan does not prevent it, because overscan counts rows and a transcript
// is full of rows that draw nothing (six of them cover no distance at all).
//
// When this says the mounted rows no longer cover the viewport, the list
// commits the new range inside the scroll event, in the same frame.

/** The first and last row in the DOM as of the last commit, in the virtualizer's offsets. */
export type MountedRows = { firstIndex: number; start: number; lastIndex: number; end: number };

export function scrollOutranRows(i: {
  /** The scroll offset the event reports. */
  offset: number;
  /** The scroller's height. */
  viewport: number;
  /** Rows in the list. */
  count: number;
  mounted: MountedRows | null;
}): boolean {
  const m = i.mounted;
  if (!m || i.viewport <= 0) return false;
  // Past the first or the last row there is nothing more to mount.
  if (m.firstIndex > 0 && i.offset < m.start) return true;
  return m.lastIndex < i.count - 1 && i.offset + i.viewport > m.end;
}

// A measurement can move the range with no scroll at all: a row above the
// viewport measures in taller and the rows that belong on screen are now other
// rows. The virtualizer places only the rows of its current range, so a row
// still in the DOM from the old range keeps its old `top` (drawn over its
// neighbours, or far from them) and a row new to the range is not there yet,
// until the next commit. Measurements land after layout and just before paint,
// so without a commit in between that frame is painted as it stands.

/** Whether the rows the virtualizer now wants differ from the rows in the DOM. */
export function rangeLeftMountedRows(mounted: MountedRows | null, firstIndex: number | undefined, lastIndex: number | undefined): boolean {
  if (!mounted || firstIndex === undefined || lastIndex === undefined) return false;
  return firstIndex !== mounted.firstIndex || lastIndex !== mounted.lastIndex;
}
