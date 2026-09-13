import { useLayoutEffect, type RefObject } from "react";

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
 * resizes are ignored, since the top level may wrap the row and grow it).
 */
export function useSqueezeToFit(rowRef: RefObject<HTMLElement | null>, maxLevel: number): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let raf = 0;
    let lastWidth = -1;

    const fit = () => {
      raf = 0;
      for (let level = 0; level <= maxLevel; level++) {
        const tokens = Array.from({ length: level }, (_, i) => String(i + 1)).join(" ");
        if (tokens) row.setAttribute("data-squeeze", tokens);
        else row.removeAttribute("data-squeeze");
        if (row.scrollWidth <= row.clientWidth + 1) break;
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };

    fit();
    lastWidth = row.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = row.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      schedule();
    });
    ro.observe(row);
    const mo = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
    mo?.observe(row, { childList: true, subtree: true, characterData: true });
    // Web fonts land after first layout and change every measured width.
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      ro.disconnect();
      mo?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rowRef, maxLevel]);
}
