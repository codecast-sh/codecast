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
 * Every restyle followed by a width read is a synchronous style and layout
 * pass of the whole page, and on a long conversation one pass costs hundreds
 * of milliseconds (ct-97578: a search by trial inside one frame callback froze
 * a cold open for 4.5s). So a pass reads the row once and writes at most one
 * level (`squeezeStep`); when that write needs checking, the check is the
 * next frame's read, after the browser has laid the page out anyway. Two
 * things keep that to one frame in the usual case: a raise jumps straight to
 * the level whose `.cq-sqN` parts, measured while still visible, cover the
 * overflow; and the width each level gave back is remembered, so a pass where
 * nothing that fits changed (a ticking "5m") reads once and writes nothing.
 *
 * Content changes are watched through a MutationObserver; width changes
 * through a ResizeObserver (height-only resizes are ignored: only the row's
 * width can change what fits). Content no observer can see (an input's value
 * is a property, not a DOM mutation) is passed as `contentKey`: a new key fits
 * the row again.
 */

/** What one row has learned between passes. */
export type SqueezeState = {
  level: number;
  /**
   * saving[k]: the content width level k sheds over level k-1. Exact once the
   * row has moved between the two; a lower bound when it came from the
   * visible widths of level k's parts (gaps and margins go too).
   */
  saving: number[];
  /** The level and content width before the last write, checked by the next pass. */
  pending: { from: number; width: number } | null;
};

export function squeezeStateFor(row: HTMLElement): SqueezeState {
  const level = (row.getAttribute("data-squeeze") ?? "").split(" ").filter(Boolean).length;
  return { level, saving: [], pending: null };
}

/**
 * One measured pass: read the row once, write at most one level. Returns true
 * when it wrote a level the next pass must check. Exported so a test drives
 * the real logic, not a copy.
 */
export function squeezeStep(row: HTMLElement, maxLevel: number, s: SqueezeState): boolean {
  const width = row.scrollWidth;
  const room = row.clientWidth + 1;
  const prev = s.pending;
  s.pending = null;
  const move = (level: number) => {
    const tokens = Array.from({ length: level }, (_, i) => String(i + 1)).join(" ");
    if (tokens) row.setAttribute("data-squeeze", tokens);
    else row.removeAttribute("data-squeeze");
    s.pending = { from: s.level, width };
    s.level = level;
    return true;
  };

  if (prev) {
    // A move of one level measures that level's saving exactly.
    if (Math.abs(prev.from - s.level) === 1) {
      const hi = Math.max(prev.from, s.level);
      s.saving[hi] = prev.from < s.level ? prev.width - width : width - prev.width;
    }
    // Lowering did not fit after all: go back to where it fit.
    if (prev.from > s.level && width > room) return move(prev.from);
  }

  if (width > room) {
    if (s.level >= maxLevel) return false;
    // Reads only, no write since the first one: the page is already laid out.
    const over = width - room;
    let shed = 0;
    let target = 0;
    for (let k = s.level + 1; k <= maxLevel; k++) {
      let est = 0;
      row.querySelectorAll(`.cq-sq${k}`).forEach((el) => { est += el.getBoundingClientRect().width; });
      s.saving[k] = Math.max(s.saving[k] ?? 0, est);
      shed += est;
      if (!target && shed >= over) target = k;
    }
    return move(target || s.level + 1);
  }

  // It fits. Lower only when the level below may fit too: a known saving that
  // would not fit back rules it out without a trial.
  if (s.level > 0 && width + (s.saving[s.level] ?? 0) <= room) return move(s.level - 1);
  return false;
}

const states = new WeakMap<HTMLElement, SqueezeState>();

export function useSqueezeToFit(
  rowRef: RefObject<HTMLElement | null>,
  maxLevel: number,
  contentKey?: unknown,
): void {
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let s = states.get(row);
    if (!s) states.set(row, (s = squeezeStateFor(row)));
    const state = s;
    let raf = 0;
    let lastWidth = -1;

    const fit = () => {
      raf = 0;
      if (squeezeStep(row, maxLevel, state)) schedule();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };

    // The first pass runs before paint, so a row that already fits, or needs
    // one jump, never shows overflow; a further check waits for a frame.
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
    // A style or theme switch (a class on <html>: Modern's larger title and
    // pills) restyles the row without touching it or its width, so the root's
    // class is watched too; it changes rarely.
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // Web fonts land after first layout and change every measured width.
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      ro.disconnect();
      mo?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rowRef, maxLevel, contentKey]);
}
