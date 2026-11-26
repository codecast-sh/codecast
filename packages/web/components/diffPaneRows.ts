// Where a diff pane's scroller stands and how to bring it to a row: what a
// follower reads off the leader's pane (FileDiffLayout) and lands on.
import type { RefObject } from "react";
import { diffLineElements, revealDiffLine } from "./diff/pierre";
import { landOn } from "../hooks/useDiffAddress";

// Sticky file header height in a pane scroller: a row under it is not read.
const PANE_HEADER_PX = 32;

/** The diff row at the top of a pane's scroller: its new-side line, and the
 *  file card it sits in when every file is stacked (`file-<index>`). */
export function topDiffRow(root: HTMLElement): { line?: number; fileIndex?: number } | null {
  const scroller = root.querySelector<HTMLElement>("[data-follow-diff-scroll]");
  if (!scroller) return null;
  const edge = scroller.getBoundingClientRect().top + PANE_HEADER_PX;
  for (const { el, anchor } of diffLineElements(scroller)) {
    if (anchor.side !== "RIGHT" || el.getBoundingClientRect().bottom <= edge) continue;
    // The line sits in its diff's shadow root; the card is around the diff.
    const host = (el.getRootNode() as ShadowRoot).host as HTMLElement | undefined;
    const card = host?.closest<HTMLElement>("[id^='file-']");
    const fileIndex = card ? Number(card.id.slice(5)) : undefined;
    return { line: anchor.lineNumber, fileIndex: Number.isFinite(fileIndex) ? fileIndex : undefined };
  }
  return { line: undefined };
}

/** Bring a file (its card, when stacked) and a new-side line to the top of a
 *  pane's scroller, the nearest line before it when the diff leaves it out. */
export function landOnDiffRow(paneRef: RefObject<HTMLElement | null>, fileIndex: number | null, line: number | undefined): () => void {
  return landOn(
    () => paneRef.current?.querySelector<HTMLElement>("[data-follow-diff-scroll]"),
    (scroller) => {
      const scope = fileIndex === null ? scroller : scroller.querySelector<HTMLElement>(`[id="file-${fileIndex}"]`);
      if (!scope || line === undefined) return scope === scroller ? (scroller.firstElementChild as HTMLElement | null) : scope;
      let best: HTMLElement | null = null;
      for (const { el, anchor } of diffLineElements(scope)) {
        if (anchor.side !== "RIGHT") continue;
        if (anchor.lineNumber > line) break;
        best = el;
      }
      // A long diff draws only near the viewport: when the line (or, in a
      // collapsed stretch, the nearest line before it) is not drawn yet,
      // scroll there and look again.
      return revealDiffLine(scope, { side: "RIGHT", lineNumber: line }, { orEarlier: true }) ? null : best ?? scope;
    },
    (el) => (el.matches("[data-line]") ? PANE_HEADER_PX : 0),
  );
}
