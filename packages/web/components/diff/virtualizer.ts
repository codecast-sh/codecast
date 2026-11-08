// Windowed drawing for long diffs. Pierre's Virtualizer keeps the viewport
// plus 1,000px of overscan on each side mounted (about 90 of our 22px rows);
// measured in opencode, windowing breaks even on main-thread render time near
// 200 lines and wins on DOM size and render time beyond it. Every long diff
// under one scroller shares one Virtualizer, so their scroll anchoring works
// from one picture of the page instead of several fighting over scrollTop.
//
// Loaded with PierreDiff (never in the app's first load).
import { DEFAULT_VIRTUAL_FILE_METRICS, Virtualizer, type FileDiffMetadata, type VirtualFileMetrics } from "@pierre/diffs";
import type { DiffLineAnchor } from "../../lib/patchParser";

export const VIRTUALIZE_LINE_THRESHOLD = 200;

/** Row heights as globals.css draws them (`--diffs-line-height: 22px`), so
 *  the estimate for rows not drawn yet matches the rows that are. */
export const VIRTUAL_METRICS: VirtualFileMetrics = { ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight: 22 };

/** How many rows a diff can come to show: the whole file when it carries one
 *  (any gap can be opened), else the rows of its hunks. */
export function drawableLines(diff: FileDiffMetadata): number {
  if (!diff.isPartial) return diff.unifiedLineCount;
  return diff.hunks.reduce((n, h) => n + h.unifiedLineCount, 0);
}

type Subscriber = Parameters<Virtualizer["connect"]>[1];
type Positioned = {
  getLinePosition(lineNumber: number, side?: "additions" | "deletions"): { top: number } | undefined;
  /** Whether a new-side line is drawn at all (not inside a collapsed stretch). */
  isLineRenderable(lineNumber: number): boolean;
  /** The nearest new-side line that is. */
  getNearestRenderableLine(lineNumber: number, direction: "up" | "down"): number | undefined;
};

/** Pierre's Virtualizer, remembering which diff instance draws into each
 *  container so a page can reach a line the window has not drawn. */
class SharedVirtualizer extends Virtualizer {
  override connect(container: HTMLElement, instance: Subscriber) {
    drawnBy.set(container, { virtualizer: this, diff: instance as unknown as Positioned });
    return super.connect(container, instance);
  }
  override disconnect(container: HTMLElement) {
    if (drawnBy.get(container)?.virtualizer === this) drawnBy.delete(container);
    super.disconnect(container);
  }
}

const drawnBy = new WeakMap<HTMLElement, { virtualizer: SharedVirtualizer; diff: Positioned }>();
const shared = new Map<HTMLElement | Document, { virtualizer: SharedVirtualizer; refs: number }>();

function scrollRoot(el: HTMLElement): HTMLElement | Document {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const y = getComputedStyle(node).overflowY;
    if (y === "auto" || y === "scroll" || y === "overlay") return node;
  }
  return document;
}

/** The Virtualizer for the scroller around `el`, held until `release`. */
export function acquireVirtualizer(el: HTMLElement): { virtualizer: Virtualizer; release: () => void } {
  const root = scrollRoot(el);
  let entry = shared.get(root);
  if (!entry) {
    const virtualizer = new SharedVirtualizer();
    virtualizer.setup(root);
    entry = { virtualizer, refs: 0 };
    shared.set(root, entry);
  }
  entry.refs++;
  const held = entry;
  let released = false;
  return {
    virtualizer: held.virtualizer,
    release: () => {
      if (released) return;
      released = true;
      if (--held.refs > 0) return;
      held.virtualizer.cleanUp();
      if (shared.get(root) === held) shared.delete(root);
    },
  };
}

function isDrawn(host: HTMLElement, anchor: DiffLineAnchor): boolean {
  for (const el of host.shadowRoot?.querySelectorAll<HTMLElement>(`[data-code] [data-line="${anchor.lineNumber}"]`) ?? []) {
    if ((el.dataset.lineType === "change-deletion") === (anchor.side === "LEFT")) return true;
  }
  return false;
}

/** Scroll a windowed diff toward the line `anchor` names, so it is drawn.
 *  True while that line is drawable and not drawn yet: look again once the
 *  window follows. False when `host` is not windowed, already draws the line,
 *  or never draws it (it lies in a collapsed stretch, or the diff does not
 *  have it; `orEarlier` then aims at the nearest drawable line before it): the
 *  caller settles for what is drawn, as for a diff drawn whole. */
export function revealVirtualLine(host: HTMLElement, anchor: DiffLineAnchor, opts: { orEarlier?: boolean } = {}): boolean {
  const drawn = drawnBy.get(host);
  if (!drawn) return false;
  // Removed lines always sit in a hunk; a new-side line may sit in a gap,
  // where `orEarlier` takes the nearest drawable line before it instead.
  if (anchor.side !== "LEFT" && !drawn.diff.isLineRenderable(anchor.lineNumber)) {
    const line = opts.orEarlier ? drawn.diff.getNearestRenderableLine(anchor.lineNumber, "up") : undefined;
    if (!line || line < 1) return false;
    anchor = { ...anchor, lineNumber: line };
  }
  if (isDrawn(host, anchor)) return false;
  const pos = drawn.diff.getLinePosition(anchor.lineNumber, anchor.side === "LEFT" ? "deletions" : "additions");
  const root = drawn.virtualizer.getRoot();
  if (!pos || !root) return false;
  const scroller = root instanceof Document ? root.scrollingElement : root;
  if (!scroller) return false;
  const top = drawn.virtualizer.getOffsetInScrollContainer(host) + pos.top - scroller.clientHeight / 3;
  const target = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
  // Already there: the window is still catching up.
  if (Math.abs(scroller.scrollTop - target) > 2) drawn.virtualizer.scrollTo({ top: target });
  return true;
}
