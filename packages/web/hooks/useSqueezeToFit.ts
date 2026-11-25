import { useLayoutEffect, type RefObject } from "react";
import { measureInFrame } from "../lib/frameMeasure";

/**
 * Progressive shedding for a single-line toolbar row whose content varies.
 *
 * Fixed container-query breakpoints cannot know how many chips a row happens
 * to carry, so a row that fits at 900px with two chips overflows at 1100px
 * with nine. This hook measures instead: it raises a squeeze level on the row
 * until the row's content fits its box, and lowers it again when room comes
 * back. The row gets `data-squeeze="1 2 …"` (every level up to the current
 * one, space separated), so CSS sheds the lowest-value parts first with plain
 * attribute selectors: `[data-squeeze~="1"] .cq-sq1 { display: none }`.
 *
 * The row must be able to overflow for the measurement to see it: give the
 * item that should win (a title) a real `min-width`, and mark everything else
 * `flex-shrink: 0`. A child that silently shrinks to nothing never registers
 * as overflow, so it never triggers a shed.
 *
 * Every level is tried from zero on each pass, so the answer is the smallest
 * level that fits and never drifts. The trials happen inside one task, so no
 * intermediate state paints. Content changes are watched through a
 * MutationObserver; width changes through a ResizeObserver (height-only
 * resizes are ignored: only the row's width can change what fits).
 * Content no observer can see (an input's value is a property, not a DOM
 * mutation) is passed as `contentKey`: a new key fits the row again.
 */
/**
 * One measured pass: the smallest level whose content fits, applied to the row.
 * Exported so a harness (and a test) can drive the real logic, not a copy.
 */
export function applySqueeze(row: HTMLElement, maxLevel: number, from = 0): number {
  // Each trial restyles the page and reads a width back, a full style and
  // layout pass, so the search starts at the last answer instead of zero:
  // shedding more never widens the row, so the smallest level that fits is
  // found by walking down while the level below still fits, or up until one
  // does. A pass where nothing moved costs two trials, not every level.
  let applied = -1;
  const apply = (level: number) => {
    const tokens = Array.from({ length: level }, (_, i) => String(i + 1)).join(" ");
    if (tokens) row.setAttribute("data-squeeze", tokens);
    else row.removeAttribute("data-squeeze");
    applied = level;
  };
  const fits = (level: number) => { apply(level); return row.scrollWidth <= row.clientWidth + 1; };
  let level = Math.max(0, Math.min(from, maxLevel));
  if (fits(level)) {
    while (level > 0 && fits(level - 1)) level--;
    // The last trial may have been the level below, which did not fit.
    if (applied !== level) apply(level);
    return level;
  }
  while (level < maxLevel) if (fits(++level)) return level;
  return maxLevel;
}

export function useSqueezeToFit(
  rowRef: RefObject<HTMLElement | null>,
  maxLevel: number,
  contentKey?: unknown,
): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let queued = false;
    let live = true;
    let lastWidth = -1;
    let lastLevel = 0;

    // Fitted at the next frame's start, beside every other layout read queued
    // there, and still before it paints. Fitted in the layout effect, the
    // first trial laid out the page the commit had just written, a forced
    // layout inside every switch or diff toggle that mounted the header row
    // (ct-101461). The trials themselves write and read in turn, so they run
    // as one read step.
    const schedule = () => {
      if (queued) return;
      queued = true;
      measureInFrame(() => {
        queued = false;
        if (live) lastLevel = applySqueeze(row, maxLevel, lastLevel);
      });
    };

    schedule();
    // The observer reports the width itself, so reading it costs no layout.
    const ro = new ResizeObserver((entries) => {
      const w = entries[entries.length - 1]?.contentRect.width ?? -1;
      if (w === lastWidth) return;
      lastWidth = w;
      schedule();
    });
    ro.observe(row);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mo?.observe(row, { childList: true, subtree: true, characterData: true });
    // A style or theme switch (a class on <html>: Modern's larger title and
    // pills) restyles the row without touching it or its width, so the root's
    // class is watched too; it changes rarely.
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // Web fonts land after first layout and change every measured width.
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      ro.disconnect();
      mo?.disconnect();
      live = false;
    };
  }, [rowRef, maxLevel, contentKey]);
}
